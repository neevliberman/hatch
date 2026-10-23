// Offline support, so Hatch opens from a phone's home screen with no signal (and loads faster on a second visit).
// Not bundled: vite.config.ts copies this to dist/sw.js at build time, filling in VERSION (a hash of every built
// file) and PRECACHE (the app shell). A new deploy changes VERSION, which installs a fresh cache and drops the old one.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `hatch-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
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
          if (res.ok) caches.open(CACHE).then((c) => c.put('./', res.clone()));
          return res;
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
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
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
