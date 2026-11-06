// Static files of the driver app that are not part of the Vite bundle (they live in public/).
export const PUBLIC_APP_FILES = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

/** The files the service worker precaches: the built app and nothing else (no API answer is ever cached). */
export function precacheList(bundleFileNames: string[]) {
  const built = bundleFileNames.filter((name) => name !== "index.html" && name !== "sw.js" && !name.endsWith(".map"));
  return ["/index.html", ...PUBLIC_APP_FILES, ...built.map((name) => `/${name}`)];
}

// FNV-1a, enough to give each build its own cache name.
export function buildVersion(contents: string[]) {
  let hash = 0x811c9dc5;
  for (const text of contents) {
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Source of sw.js. It precaches the app's own files, answers only same-origin GETs for those files (a navigation gets
 * index.html) and lets everything else, such as the API, go to the network untouched. A new build drops the old cache.
 */
export function serviceWorkerSource(files: string[], version: string) {
  return `const CACHE = ${JSON.stringify(`driver-app-${version}`)};
const APP_FILES = ${JSON.stringify(files)};
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = event.request.mode === "navigate" ? "/index.html" : url.pathname;
  if (!APP_FILES.includes(path)) return;
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(path)).then((cached) => cached || fetch(event.request)));
});
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Nueva versión del plan";
  const options = {
    body: data.body || "Se publicó una nueva versión de tu recorrido.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: {
      url: data.url || "/",
      routeId: data.routeId,
      version: data.version,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const urlToOpen = (event.notification.data && event.notification.data.url) ? event.notification.data.url : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          if ("navigate" in client && urlToOpen) {
            client.navigate(urlToOpen);
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
`;
}
