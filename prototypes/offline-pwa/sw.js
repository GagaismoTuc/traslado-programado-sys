// Throwaway prototype for issue #40: keeps the page working without signal and shows test pushes.
const CACHE = 'offline-prototype-v1';
const SHELL = ['./', 'index.html', 'app.mjs', 'queue.mjs', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

// The shell comes from the network when there is signal and from the cache without it; marks and push calls never use the cache.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin) return;
  const path = url.pathname.slice(scope.pathname.length);
  const shell = event.request.mode === 'navigate' || SHELL.includes(path);
  if (!shell) return;
  event.respondWith(fetch(event.request)
    .then(async (response) => {
      if (response.ok && event.request.mode !== 'navigate') await (await caches.open(CACHE)).put(event.request, response.clone());
      return response;
    })
    .catch(async () => (await caches.match(event.request.mode === 'navigate' ? 'index.html' : event.request)) ?? Response.error()));
});

// A push carries no payload; iOS requires every push to show a notification.
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Offline prototype', { body: `Push received at ${new Date().toLocaleTimeString()}`, icon: 'icon-192.png' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(self.registration.scope));
});
