// Offline support, so Hatch opens from a phone's home screen with no signal (and loads faster on a second visit).
// Not bundled: vite.config.ts copies this to dist/sw.js at build time, filling in VERSION (a hash of every built
// file and of this template) and PRECACHE (the app shell). A new deploy changes VERSION, which installs a fresh
// cache. The new worker waits until every old tab has closed (no skipWaiting), so a page left open across a deploy
// keeps the cache its bundles came from; then the old cache is dropped.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `hatch-${VERSION}`;

// Only whole, same-origin answers are worth keeping (a 206 partial response can't be cached at all).
const keepable = (res) => res.status === 200 && res.type === 'basic';
const store = (key, res) => caches.open(CACHE).then((c) => c.put(key, res)).catch(() => {});

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, which may still hold the previous deploy's page for ~10 minutes.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hatch-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // The page itself: network first, so a new deploy shows up at once; the cached copy when offline.
    // Query strings (?date=, ?at=) all map to the one cached page.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (keepable(res)) e.waitUntil(store('./', res.clone()));
          return res;
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    );
    return;
  }
  if (/\/live\/(latest|scorecard)\.json$/.test(url.pathname)) {
    // This season's live forecast and its scorecard change every night: network first, the last copy only when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (keepable(res)) e.waitUntil(store(url.pathname, res.clone()));
          return res;
        })
        .catch(() => caches.match(url.pathname).then((hit) => hit ?? Response.error())),
    );
    return;
  }
  // Everything else (hashed bundles, fonts, icons, the finer hexagons fetched on zoom): cache first, and keep what
  // the network returns. The cache is per deploy, so nothing outlives the build it came from.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (keepable(res)) e.waitUntil(store(req, res.clone()));
          return res;
        }),
    ),
  );
});
