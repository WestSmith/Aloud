/* Aloud service worker — offline app shell + CDN module caching.
   Bump VERSION on each release to roll the cache. */
const VERSION = 'aloud-v6.42.0';
/* Multi-core neural voice. wasm threads need SharedArrayBuffer, which needs
   the document delivered with COOP/COEP. GitHub Pages cannot send headers,
   but a service worker can add them to every same-origin response. It is
   opt-in (Settings → "Use all CPU cores"): COEP require-corp also blocks any
   cross-origin subresource that lacks CORS/CORP, which an opened HTML file's
   remote images or scripts may be. The flag is kept in Cache Storage
   because a service worker cannot read localStorage; the page sends it over
   postMessage and re-sends it on every boot. It persists across VERSION
   rolls on purpose — the activate handler only deletes 'aloud-v*' caches. */
const FLAGS = 'aloud-flags';
const MODULES = 'aloud-modules';
const COI_KEY = '/__aloud_coi';
async function coiWanted() {
  try { return !!(await (await caches.open(FLAGS)).match(COI_KEY)); } catch { return false; }
}
function withCoiHeaders(res) {
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('message', (e) => {
  const m = e.data;
  if (!m) return;
  if (m.type === 'status') {
    e.waitUntil((async () => {
      try {
        const cache = await caches.open(VERSION);
        const ready = (await Promise.all(CORE.map(path => cache.match(path)))).every(Boolean);
        e.ports[0]?.postMessage({ version: VERSION.slice('aloud-'.length), ready });
      } catch { e.ports[0]?.postMessage({ version: VERSION.slice('aloud-'.length), ready: false }); }
    })());
    return;
  }
  if (m.type !== 'coi') return;
  const port = e.ports && e.ports[0];
  e.waitUntil((async () => {
    let ok = false;
    try {
      const c = await caches.open(FLAGS);
      if (m.on) await c.put(COI_KEY, new Response('1'));
      else await c.delete(COI_KEY);
      ok = true;
    } catch {}
    if (port) port.postMessage({ ok });
  })());
});
const CORE = ['./', './index.html', './kokoro-worker.js', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Older releases mixed engine modules into the shell cache. Preserve those
    // exact pinned URLs before rolling the shell, including an offline upgrade.
    const modules = await caches.open(MODULES);
    for (const name of (await caches.keys()).filter(k => /^aloud-v\d/.test(k))) {
      try {
        const old = await caches.open(name);
        for (const request of await old.keys()) {
          if (new URL(request.url).hostname !== 'cdn.jsdelivr.net') continue;
          if (!await modules.match(request)) await modules.put(request, await old.match(request));
        }
        if (name !== VERSION) await caches.delete(name);
      } catch (error) { console.warn('module cache migration', error); } // Retain the old cache on failure.
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Native Kokoro WAVs are temporary files. Never retain one after Swift has
  // released it, and never replace a missing clip with the app shell.
  if (url.pathname.includes('/__aloud_kokoro/')) return;
  // model weights: transformers.js manages its own Cache Storage — don't double-cache 90MB
  if (url.hostname.endsWith('huggingface.co') || url.hostname.endsWith('hf.co')) return;

  let cacheWrite = Promise.resolve();
  if (url.origin === location.origin) {
    // never cache reset/cache-bust URLs — caching them is what used to strand
    // users on a stale build across repeated ?reset attempts
    const noStore = /[?&](reset|fresh)\b/i.test(url.search);
    // app shell: NETWORK-FIRST so a fresh deploy is picked up immediately when
    // online; fall back to cache only when offline. (Was cache-first, which
    // left installed PWAs stuck on old versions.)
    const shell = fetch(e.request).then(res => {
      if (res.ok && !noStore) { const copy = res.clone(); cacheWrite = caches.open(VERSION).then(c => c.put(e.request, copy)).catch(e => console.warn('shell cache', e)); }
      return res;
    }).catch(async () => { const cache = await caches.open(VERSION); return await cache.match(e.request) || await cache.match('./index.html') || await cache.match('./'); });
    // every same-origin response carries the isolation headers when the flag
    // is on. Not just the document: a dedicated worker's script response must
    // itself declare an embedder policy at least as strict as its owner's, or
    // the browser refuses to start the worker (ERR_BLOCKED_BY_RESPONSE —
    // measured in Chromium against kokoro-worker.js before this line existed).
    e.waitUntil(shell.then(() => cacheWrite).catch(() => {}));
    e.respondWith(Promise.all([shell, coiWanted()]).then(([res, coi]) => coi ? withCoiHeaders(res) : res));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // engine modules (kokoro-js, phonemizer): cache-first so neural + G2P work offline
    const response = caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); cacheWrite = caches.open(MODULES).then(c => c.put(e.request, copy)).catch(e => console.warn('CDN cache', e)); }
        return res;
      }));
    e.waitUntil(response.then(() => cacheWrite).catch(() => {}));
    e.respondWith(response);
  }
});
