const CACHE_NAME = "funrun-pwa-v12";
const PRECACHE = [
  "./",
  "./index.html",
  "./live.html?v=12",
  "./supabase-live.js?v=12",
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

  // Never cache authentication, database, or live-game endpoints.
  const path = url.pathname;
  if (path.includes("/auth/v1/") || path.includes("/rest/v1/") || path.includes("/functions/v1/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
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
