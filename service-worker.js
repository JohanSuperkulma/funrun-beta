const CACHE_NAME = "funrun-pwa-v15";
const PRECACHE = [
  "./",
  "./index.html",
  "./live.html?v=15",
  "./supabase-live.js?v=15",
  "./satellite-maps.js?v=15",
  "./package-flow.js?v=15",
  "./game-ui.js?v=15",
  "./supabase-config.js",
  "./manifest.webmanifest",
  "./offline.html",
  "./apple-touch-icon.png",
  "./funrun-icon-192.png",
  "./funrun-icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("funrun-pwa-") && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (path.includes("/auth/v1/") || path.includes("/rest/v1/") || path.includes("/functions/v1/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (url.pathname.endsWith("/live.html") && response.ok) {
          let html = await response.text();
          const leafletScript = '  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>';
          const injected = '  <script src="./satellite-maps.js?v=15"></script>\n  <script src="./package-flow.js?v=15"></script>\n  <script src="./game-ui.js?v=15"></script>\n' + leafletScript;
          if (html.includes(leafletScript)) html = html.replace(leafletScript, injected);
          return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
      } catch {
        return await caches.match(new URL("./offline.html", self.registration.scope).href) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".png") || url.pathname.endsWith(".svg") || url.pathname.endsWith(".webmanifest")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return await cache.match(request) || Response.error();
      }
    })());
  }
});
