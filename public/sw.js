// Minimal service worker: cache static assets for offline daily viewing.
//
// Bumped to v2 (was stuck forever on v1 — see below) and switched HTML
// navigations to network-first: a cache-first strategy that precaches '/'
// means the very first cached copy of index.html is served on every future
// visit, forever, with no revalidation — any later deploy is invisible to
// already-visited browsers until they clear storage. Static assets (JS,
// images) keep cache-first since those are versioned by browser reload
// anyway and benefit more from instant offline hits.
const CACHE_NAME = 'cotsozanuta-v2';
const PRECACHE = [
  '/utils.js',
  '/images/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  // Only cache GET requests for same-origin static assets
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // Skip API calls
  if (url.pathname.startsWith('/api/')) return;

  // HTML navigations: always try the network first so deploys show up
  // immediately; fall back to the last cached page only when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => caches.match(request).then(cached => cached || caches.match('/')))
    );
    return;
  }

  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response.ok) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, clone));
        return response;
      }).catch(() => caches.match('/'));
    })
  );
});
