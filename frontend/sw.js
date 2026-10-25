/**
 * GEHPM service worker â€” offline-first app shell (Phase 1).
 *
 * Strategy:
 * - On install: precache the full app shell so the app boots with NO internet.
 * - Navigations + HTML: network-first, falling back to cached shell offline.
 * - JS/CSS: network-first (code updates apply immediately), cache fallback offline.
 * - API (`/api/`): never cached â€” handled by the sync engine/outbox instead.
 * - Same-origin assets are cached on http AND https (field devices often use
 *   plain http over the local network; the old SW only cached on https).
 */
const CACHE_NAME = 'gutenberg-v67-irmanage';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/rental-theme.css',
  '/js/app.js',
  '/js/api.js',
  '/js/offline-db.js',
  '/js/mpesa-parse.js',
  '/js/sync-engine.js',
  '/js/offline-session.js',
  '/js/offline-media.js',
  '/js/water-anomaly.js',
  '/js/agreement-scan.js',
  '/img/logo.png?v=2',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url, { cache: 'no-store' })
            .then((res) => {
              if (res && res.ok) return cache.put(url, res);
              return null;
            })
            .catch(() => null)
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
  // NOTE: never force-navigate tabs here. A forced reload mid-click loses
  // agent input and can flash blank views. The app listens for
  // 'controllerchange' and reloads itself only when safe (no pending uploads).
});

function putInCache(request, response) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.method !== 'GET') return;
    const clone = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
  } catch (_) {}
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-http(s) requests (chrome-extension, etc.)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // Never cache API or auth requests â€” the sync engine owns offline API.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Navigations / HTML: network-first, cached shell fallback when offline.
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) putInCache(event.request, response);
          return response;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match('/index.html'))
        )
    );
    return;
  }

  // JS/CSS: network-first so code updates are seen immediately,
  // falling back to the cached copy only when offline.
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) putInCache(event.request, response);
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response && response.status === 200) putInCache(event.request, response);
        return response;
      }).catch(() => cached);

      return cached || fetched;
    })
  );
});
