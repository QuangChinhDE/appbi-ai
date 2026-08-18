/**
 * Next.js Edge Middleware — route protection (authentication only).
 *
 * Runs on the Edge runtime (no Node.js APIs). Uses `jose` for JWT verification.
 *
 * Rules:
 * - No valid cookie → redirect to /login
 * - Page-level permission checks are handled by usePermissions() hook,
 *   NOT by this middleware.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

import { DEFAULT_LANDING_PATH, HOME_MODULE_ENABLED } from '@/lib/feature-flags';

// Public paths that do NOT require authentication.
// /ws/ + /w/ are workspace + workboard public links. End-user sessions use
// Workboard app users, not AppBI accounts.
const PUBLIC_PATHS = ['/login', '/d/', '/embed/', '/ws/', '/w/'];
const ACCESS_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const LEGACY_REFRESH_COOKIE_PATH = '/api/auth/refresh';

function getSecret(): Uint8Array {
  const secret = process.env.SECRET_KEY ?? 'change-this-in-production';
  return new TextEncoder().encode(secret);
}

// ── Embed framing guard ──────────────────────────────────────────────────────
//
// An embed link may declare which sites are allowed to iframe it (per PAT, see
// docs/embed-integration-api.md). Enforcement has to happen HERE, on the page
// response, for a reason worth remembering: the browser is the only party that
// knows which site is framing us. Requests the report makes from inside the
// iframe carry the report's OWN origin, so no backend endpoint can see the host
// page's domain. So:
//   • `frame-ancestors` on this response → the browser refuses to paint the
//     report inside any other site (cannot be spoofed by the embedding page);
//   • `Sec-Fetch-Dest` (browser-set, not settable from JS) tells us whether we
//     are being framed at all → a pasted link opened in a tab is refused with a
//     readable message instead of quietly serving the report.
// Links with no declared origins keep behaving exactly as before.

const EMBED_POLICY_TTL_MS = 60_000;
const embedPolicyCache = new Map<string, { origins: string[]; at: number }>();

async function fetchEmbedPolicy(token: string): Promise<string[]> {
  const cached = embedPolicyCache.get(token);
  if (cached && Date.now() - cached.at < EMBED_POLICY_TTL_MS) return cached.origins;
  const base = (process.env.BACKEND_URL || 'http://backend:8000/api/v1').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/public/embed/${encodeURIComponent(token)}/policy`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { allowed_origins?: string[] };
    const origins = Array.isArray(data?.allowed_origins) ? data.allowed_origins : [];
    embedPolicyCache.set(token, { origins, at: Date.now() });
    return origins;
  } catch {
    // Policy lookup unavailable → do not lock the report out. Availability wins
    // here: the token is still short-lived and filter-locked, and a backend blip
    // must not black out every customer's iframe.
    return [];
  }
}

/** Reduce a Referer URL to its origin, lowercased. */
function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Same dot-boundary matching as the backend (backend/app/services/embed_link_service.py). */
function originAllowed(origin: string | null, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (scheme === 'https' ? '443' : '80');
  return allowlist.some((rule) => {
    let r: URL;
    try {
      r = new URL(rule.replace('*.', 'wildcard-placeholder.'));
    } catch {
      return false;
    }
    const rScheme = r.protocol.replace(':', '').toLowerCase();
    const rPort = r.port || (rScheme === 'https' ? '443' : '80');
    if (scheme !== rScheme || port !== rPort) return false;
    const rHost = r.hostname.toLowerCase();
    if (rHost.startsWith('wildcard-placeholder.')) {
      const parent = rHost.slice('wildcard-placeholder.'.length);
      // Subdomains only, and only on a label boundary: this is what stops
      // `evil-base.vn` and `base.vn.evil.com` from passing.
      return host.endsWith(`.${parent}`) && host !== parent;
    }
    return host === rHost;
  });
}

function embedRefusedResponse(reason: 'not-framed' | 'origin', origin: string | null): NextResponse {
  const detail = reason === 'not-framed'
    ? 'Link này chỉ hoạt động khi được nhúng trong trang được cấp phép, không mở trực tiếp.'
    : `Miền ${origin ?? 'không xác định'} không nằm trong danh sách được phép nhúng báo cáo này.`;
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Không thể mở báo cáo</title></head>`
    + `<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;`
    + `font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a">`
    + `<div style="max-width:420px;padding:28px;text-align:center">`
    + `<div style="font-size:15px;font-weight:600;margin-bottom:8px">Không thể mở báo cáo</div>`
    + `<div style="font-size:13px;line-height:1.55;color:#475569">${detail}</div>`
    + `<div style="font-size:12px;margin-top:14px;color:#94a3b8">Vui lòng mở báo cáo từ ứng dụng của bạn.</div>`
    + `</div></body></html>`;
  return new NextResponse(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}


export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // --- Reverse-proxy /api/v1/* to backend, preserving the exact path
  //     including trailing slashes. This replaces the next.config.js rewrite
  //     which strips trailing slashes, causing FastAPI to redirect with the
  //     internal Docker hostname and breaking CORS. ---
  if (pathname.startsWith('/api/v1/') || pathname === '/api/v1') {
    const backendBase = (process.env.BACKEND_URL || 'http://backend:8000/api/v1')
      .replace(/\/api\/v1\/?$/, '');
    const requestHeaders = new Headers(request.headers);
    const token = request.cookies.get('access_token')?.value;
    if (token && !requestHeaders.has('authorization')) {
      requestHeaders.set('authorization', `Bearer ${token}`);
    }
    return NextResponse.rewrite(new URL(pathname + search, backendBase), {
      request: { headers: requestHeaders },
    });
  }

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    // Deployment-wide framing floor (opt-in). When EMBED_FRAME_ANCESTORS is set
    // (space-separated origins), only those parents may iframe /embed and /d
    // pages. Unset = no header = backward compatible. Runtime-read here (not
    // next.config headers(), which is build-time only).
    const fa = (process.env.EMBED_FRAME_ANCESTORS || '').trim();

    // Per-link allowlist declared by the integration (see the block comment
    // above). Only for the embed DOCUMENT request — assets and data go through
    // their own paths and would just add lookups.
    const embedToken = pathname.startsWith('/embed/') ? pathname.split('/')[2] : '';
    const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
    if (embedToken && wantsHtml) {
      const allowlist = await fetchEmbedPolicy(embedToken);
      if (allowlist.length > 0) {
        const dest = request.headers.get('sec-fetch-dest');
        const origin = originOf(request.headers.get('referer'));
        // Opened directly rather than embedded. `sec-fetch-dest` is set by the
        // browser and cannot be forged from a page; when it is absent (old
        // browser, curl) we do not guess — the origin check below still applies.
        if (dest && dest !== 'iframe' && dest !== 'embed' && dest !== 'frame') {
          return embedRefusedResponse('not-framed', origin);
        }
        // A browser with the default referrer policy sends the parent's origin on
        // a cross-site iframe load. If it sends nothing we let the request pass
        // and rely on frame-ancestors below, which the browser enforces anyway —
        // refusing here would break hosts that set `referrer: no-referrer`.
        if (origin && !originAllowed(origin, allowlist)) {
          return embedRefusedResponse('origin', origin);
        }
        const res = NextResponse.next();
        res.headers.set('Content-Security-Policy', `frame-ancestors ${allowlist.join(' ')};`);
        return res;
      }
    }

    const res = NextResponse.next();
    if (fa && (pathname.startsWith('/embed/') || pathname.startsWith('/d/'))) {
      res.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${fa};`);
    }
    return res;
  }

  // PWA mini-app surfaces (public): launcher `/m`, manifest, service worker,
  // and the PWA icons must be reachable without an admin session.
  if (
    pathname === '/m' ||
    pathname.startsWith('/m/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname.startsWith('/icon-')
  ) {
    return NextResponse.next();
  }

  // Allow Next.js internals and other API routes (e.g. /api/auth/*) through
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // --- Hidden Home module (see lib/feature-flags.ts) -------------------------
  //
  // Bounce /overview HERE, on the server, rather than from inside the page. A
  // client-side guard would still have to mount the page first, and mounting is
  // exactly what costs us: the component fires five list queries the moment it
  // renders. Redirecting at the edge means the route's bundle is never fetched
  // and those endpoints are never called — for a bookmark, a typed URL, or a
  // client-side navigation (App Router runs middleware on the RSC request too).
  //
  // Placed BEFORE the auth check on purpose: a logged-out visitor then gets
  // `?next=/dashboards` and lands somewhere real after signing in, instead of
  // being sent back to a route that only redirects again.
  if (!HOME_MODULE_ENABLED && (pathname === '/overview' || pathname.startsWith('/overview/'))) {
    const landing = request.nextUrl.clone();
    landing.pathname = DEFAULT_LANDING_PATH;
    landing.search = '';
    return NextResponse.redirect(landing);
  }

  // Read the httpOnly auth cookie
  const token = request.cookies.get('access_token')?.value;

  if (!token) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Verify the JWT
  try {
    await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
  } catch {
    // Access token expired — try silent refresh via refresh_token cookie
    const refreshToken = request.cookies.get('refresh_token')?.value;
    if (refreshToken) {
      try {
        const backendUrl = process.env.BACKEND_URL || 'http://backend:8000/api/v1';
        const refreshRes = await fetch(`${backendUrl}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `refresh_token=${refreshToken}`,
          },
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          const newToken: string = data.access_token;
          const response = NextResponse.next();
          response.cookies.set({
            name: 'access_token',
            value: newToken,
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.COOKIE_SECURE !== 'false',
            maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
            path: '/',
          });
          // Proxy new refresh token
          const setCookieHeaders = refreshRes.headers.getSetCookie?.() ?? [];
          for (const cookieStr of setCookieHeaders) {
            if (cookieStr.startsWith('refresh_token=')) {
              const value = cookieStr.split('=')[1]?.split(';')[0] ?? '';
              response.cookies.set({
                name: 'refresh_token',
                value: '',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.COOKIE_SECURE !== 'false',
                maxAge: 0,
                path: LEGACY_REFRESH_COOKIE_PATH,
              });
              response.cookies.set({
                name: 'refresh_token',
                value,
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.COOKIE_SECURE !== 'false',
                maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
                path: '/',
              });
            }
          }
          return response;
        }
      } catch {
        // Refresh failed — fall through to redirect to login
      }
    }

    // Invalid/expired token and refresh failed — redirect to login
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.set({
      name: 'access_token',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE !== 'false',
      maxAge: 0,
      path: '/',
    });
    response.cookies.set({
      name: 'refresh_token',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE !== 'false',
      maxAge: 0,
      path: '/',
    });
    response.cookies.set({
      name: 'refresh_token',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE !== 'false',
      maxAge: 0,
      path: LEGACY_REFRESH_COOKIE_PATH,
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
