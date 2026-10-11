// Gesso offline cache: app shell, cache-first, refreshed in the background.
const V = 'gesso-__V__';
const SHELL = ['./', 'index.html', 'app.js?v=__V__', 'worker.js?v=__V__', 'style.css?v=__V__', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'fonts/caveat.woff2', 'fonts/bebas.woff2'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // network-first for navigations so new versions arrive; cache-first for assets
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(V).then((c) => c.put('index.html', cp)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(req, cp)); }
    return r;
  })));
});
