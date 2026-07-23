// -----------------------------------------------------------------------------
// Bookpitch service worker — hand-rolled, ~80 lines. Three cache strategies:
//   1. HTML navigations → network-first, cached shell fallback,
//      /offline as the last resort.
//   2. /api/* and /dev/* → NETWORK ONLY. Never cache. RLS + freshness matter,
//      and webhooks must not be intercepted.
//   3. Static assets (/_next/static/*, /_next/image, /icon…) → cache-first
//      with silent SWR refresh in the background.
//
// Bump CACHE_VERSION on any strategy change; `activate` evicts old versions
// so shells never get stuck.
// -----------------------------------------------------------------------------

const CACHE_VERSION = 'bookpitch-v2';
const SHELL_URLS = [
  '/',
  '/scheduler',
  '/patients',
  '/reminders',
  '/billing',
  '/analytics',
  '/signin',
  '/offline',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Best-effort — some shell URLs may 401/302 for signed-out users on
      // first install; ignore individual failures so activate still proceeds.
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch(() => null),
        ),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('bookpitch-') && name !== CACHE_VERSION)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiOrDev(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/dev/');
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/_next/image') ||
    url.pathname.startsWith('/icon') ||
    url.pathname.startsWith('/apple-icon') ||
    url.pathname.startsWith('/manifest') ||
    url.pathname === '/favicon.ico'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache mutations

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never cache cross-origin

  // Strategy 2: API + dev — never touch the cache.
  if (isApiOrDev(url)) return;

  // Strategy 3: static assets — cache-first + background refresh.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })(),
    );
    return;
  }

  // Strategy 1: HTML navigation — network-first, shell fallback, /offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(req, res.clone());
          }
          return res;
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          const cached = await cache.match(req);
          if (cached) return cached;
          const offline = await cache.match('/offline');
          return (
            offline ||
            new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
          );
        }
      })(),
    );
  }
});

// -----------------------------------------------------------------------------
// Web Push. Payload shape: { title, body, url? }. Bodies are counts /
// generic phrases only — the sender in lib/push.ts is what enforces the
// "no PHI on lock screens" rule, but the SW is defensive too and never
// renders `data` (which could contain arbitrary text from an attacker).
// -----------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let payload = { title: 'Bookpitch', body: 'You have a new notification.' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed.title === 'string' && typeof parsed.body === 'string') {
        payload = { title: parsed.title, body: parsed.body, url: parsed.url };
      }
    }
  } catch {
    /* fall through to defaults */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon',
      badge: '/icon',
      data: { url: payload.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientsList) {
        if ('focus' in c) {
          await c.focus();
          if (target && 'navigate' in c) {
            try { await c.navigate(target); } catch { /* ignore */ }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target || '/');
    })(),
  );
});
