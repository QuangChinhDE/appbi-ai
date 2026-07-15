/* AppBI mini-app service worker — Phase 2 (offline-first: shell + RSC nav + read cache).
 *
 * Scope is the whole origin but we ONLY touch the public mini-app surfaces
 * (launcher `/m`, runtime `/ws/...`, Next static, public GET APIs, RSC payloads).
 * The authenticated admin app and all non-GET requests are passed straight to
 * the network (offline writes are queued at the APP layer, not here).
 *
 * Strategies:
 *   - /_next/static/*, /icon-*, /manifest        -> cache-first (immutable)
 *   - RSC client-nav (header RSC:1 or ?_rsc=)     -> network-first, cache under a
 *                                                    normalized key so it doesn't
 *                                                    collide with the HTML of the
 *                                                    same URL → offline DEEP-NAV works
 *   - full navigations to /m and /ws/**           -> network-first, cache, offline-shell fallback
 *   - GET /api/v1/public/**                       -> network-first, cache → offline READ of
 *                                                    screens/reports viewed at least once
 *   - everything else                             -> network (untouched)
 */
const VERSION = 'appbi-pwa-v4';
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;
const RSC_CACHE = `${VERSION}-rsc`;
const API_CACHE = `${VERSION}-api`;
const OFFLINE_URL = '/m';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGE_CACHE).then((c) => c.add(OFFLINE_URL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Let the app force activation of a freshly-deployed SW.
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Web Push (C13) ────────────────────────────────────────────────────────
// Payload is JSON {title, body, url}. Shows a notification; clicking it focuses
// an existing mini-app tab or opens the target URL.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Thông báo';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/m' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/m';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })(),
  );
});

const isStatic = (u) =>
  u.pathname.startsWith('/_next/static/') ||
  u.pathname.startsWith('/icon-') ||
  u.pathname === '/manifest.webmanifest' ||
  u.pathname === '/favicon.ico';

const isMiniAppPath = (u) => u.pathname === '/m' || u.pathname.startsWith('/m/') || u.pathname.startsWith('/ws/');

const isRsc = (req) => {
  if (req.headers.get('RSC') === '1' || req.headers.get('Next-Router-Prefetch') === '1') return true;
  try {
    return new URL(req.url).searchParams.has('_rsc');
  } catch {
    return false;
  }
};

const isPublicApiGet = (req, u) => req.method === 'GET' && u.pathname.startsWith('/api/v1/public/');

// File downloads (export.xlsx, .pdf, …) — bypass the SW entirely.
const isDownload = (u) =>
  /\.(xlsx|xls|csv|pdf|docx|zip)$/i.test(u.pathname) || /\/export(\.[a-z0-9]+)?$/i.test(u.pathname);

// RSC and HTML share a URL → give RSC its own normalized cache key (path only,
// dropping the volatile _rsc cache-buster) so client-nav hits offline.
const rscKey = (u) => `${u.origin}${u.pathname}__swrsc`;

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (fallbackUrl) {
      const shell = await caches.match(fallbackUrl);
      if (shell) return shell;
    }
    throw err;
  }
}

async function networkFirstRsc(req, url) {
  const cache = await caches.open(RSC_CACHE);
  const key = rscKey(url);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Binary downloads (Excel / PDF exports) must NEVER be served from or written
  // to the cache — a cached/partial binary reopens as a corrupt "not a real
  // file" error. Pass them straight to the network, untouched by the SW.
  if (request.method === 'GET' && isDownload(url)) return;

  if (isStatic(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
  } else if (request.method === 'GET' && isMiniAppPath(url) && isRsc(request)) {
    event.respondWith(networkFirstRsc(request, url));
  } else if (request.mode === 'navigate' && isMiniAppPath(url)) {
    event.respondWith(networkFirst(request, PAGE_CACHE, OFFLINE_URL));
  } else if (isPublicApiGet(request, url)) {
    event.respondWith(networkFirst(request, API_CACHE, null));
  }
  // else: network (admin app, POST/PATCH/DELETE, etc.) — app-layer queue handles offline writes.
});
