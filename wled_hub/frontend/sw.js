// Service worker: caches the app shell so the PWA opens instantly and offline.
// API calls always go to the network (live state must never come from cache).
const CACHE = "wled-hub-v6";
const SHELL = [
  "./",
  "index.html",
  "css/app.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "js/app.js",
  "js/api.js",
  "js/ui.js",
  "js/colorwheel.js",
  "js/colorpicker.js",
  "js/views/rooms.js",
  "js/views/roomsheet.js",
  "js/views/grid.js",
  "js/views/devices.js",
  "js/views/settings.js",
  "js/views/scanner.js",
  "js/mapping.js",
  "js/livepreview.js",
  "js/templates.js",
  "js/views/devicesettings.js",
  "js/views/studio.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.includes("/api/")) return;
  // Network first, fall back to cache: updates show up right away when online.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
