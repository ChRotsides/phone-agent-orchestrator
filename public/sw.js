// Shell cache only — the realtime link always goes to the network.
const CACHE = 'jarvis-v2';
const SHELL = ['./', 'index.html', 'app.js', 'capture-worklet.js', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/rt')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
