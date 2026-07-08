/* Aloud service worker — offline app shell + CDN module caching.
   Bump VERSION on each release to roll the cache. */
const VERSION = 'aloud-v6.2.5';
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
    // never cache reset/cache-bust URLs — caching them is what used to strand
    // users on a stale build across repeated ?reset attempts
    const noStore = /[?&](reset|fresh)\b/i.test(url.search);
    // app shell: NETWORK-FIRST so a fresh deploy is picked up immediately when
    // online; fall back to cache only when offline. (Was cache-first, which
    // left installed PWAs stuck on old versions.)
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok && !noStore) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html') || caches.match('./')))
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
