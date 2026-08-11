/* P-Roster service worker — app-shell caching for offline use */
const CACHE_NAME = "proster-cache-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./admin.html",
  "./booking.html",
  "./style.css",
  "./app.js",
  "./booking.js",
  "./landing.js",
  "./manifest.json",
  "./assets/logo.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // App shell (same-origin): NETWORK-FIRST. This is an actively-updated app —
  // always prefer the latest index.html/app.js/etc. from the server, and only
  // fall back to the cached copy if the network is unreachable (offline use).
  // A cache-first strategy here would silently keep serving old JS/HTML
  // indefinitely after every deploy, which is worse than a slower first paint.
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cross-origin (fonts, html2canvas CDN): stale-while-revalidate — these
  // change rarely, so serving a cached copy immediately while refreshing in
  // the background is a good trade-off.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
