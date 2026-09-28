// Kill switch: v1 registered a cache-first service worker at this same URL/scope that's still
// active on some devices, permanently serving its old cached copy of the site regardless of any
// server-side changes. This replaces it, wipes that old cache, and unregisters so every future
// load goes straight to the network again. Safe to delete once affected devices have picked this up.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
  );
});
