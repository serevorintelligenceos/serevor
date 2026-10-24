// Serevor service worker — intentionally minimal.
// It makes the app installable (so "Share → Serevor" works) but caches NOTHING:
// user data is private and always fetched fresh over the network.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
