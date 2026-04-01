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

// Public paths that do NOT require authentication
const PUBLIC_PATHS = ['/login', '/d/'];

function getSecret(): Uint8Array {
  const secret = process.env.SECRET_KEY ?? 'change-this-in-production';
  return new TextEncoder().encode(secret);
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
    return NextResponse.rewrite(new URL(pathname + search, backendBase));
  }

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow Next.js internals and other API routes (e.g. /api/auth/*) through
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.startsWith('/api/')) {
    return NextResponse.next();
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
    // Invalid/expired token — clear cookie and redirect to login
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete('access_token');
    return response;
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
