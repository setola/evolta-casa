// Scope both URLs and caches to this installation (Pages can host multiple apps).
const BASE = new URL('./', self.location.href).href;
const CACHE = `evolta-casa-v2:${BASE}`;
const ASSETS = ['', 'index.html', 'manifest.webmanifest', 'config/assumptions.yaml', 'icon.svg']
  .map(path => new URL(path, BASE).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(BASE)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request, { cacheName: CACHE });
    if (cached) return cached;
    if (event.request.mode === 'navigate') {
      const shell = await caches.match(new URL('index.html', BASE).href, { cacheName: CACHE });
      if (shell) return shell;
    }
    return Response.error();
  }));
});
