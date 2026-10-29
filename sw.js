/* LONDON BOOM! service worker — cache-first local shell (F6).
   Works OFFLINE after the first load. Caches LOCAL files only.

   ⚠ CACHE name must be bumped whenever ANY cached file changes — the new
   cache name activates the updated service worker, and the activate step
   deletes the old cache. That is the deploy cache-bust mechanism. */
const CACHE = 'london-boom-v2.0.0';

const ASSETS = [
  './',
  'index.html',
  'game.js',
  'vendor/matter.min.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // local shell only
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        // serve from cache; refresh it in the background when online
        fetch(req).then(function (resp) {
          if (resp && resp.ok) caches.open(CACHE).then(function (c) { c.put(req, resp); });
        }).catch(function () { /* offline: cached copy already served */ });
        return hit;
      }
      return fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      });
    })
  );
});
