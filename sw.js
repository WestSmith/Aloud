/* Aloud service worker — offline app shell + CDN module caching.
   Bump VERSION on each release to roll the cache. */
const VERSION = 'aloud-v6.2.0';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k.startsWith('aloud-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // model weights: transformers.js manages its own Cache Storage — don't double-cache 90MB
  if (url.hostname.endsWith('huggingface.co') || url.hostname.endsWith('hf.co')) return;

  if (url.origin === location.origin) {
    // app shell: cache-first, refresh in background
    e.respondWith(
      caches.match(e.request).then(hit => {
        const refresh = fetch(e.request).then(res => {
          if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || refresh;
      })
    );
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // engine modules (kokoro-js, phonemizer): cache-first so neural + G2P work offline
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
  }
});
