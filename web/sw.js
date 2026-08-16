const CACHE_NAME = 'jarvis-pwa-shell-v10'
const SHELL_PATHS = [
  '/app/',
  '/app/app.css',
  '/app/app.js?v=10',
  '/app/pairing.js?v=10',
  '/app/device-store.js?v=10',
  '/app/conversations.js?v=10',
  '/app/apple-touch-icon.png',
  '/app/icon.svg',
  '/app/icon-192.png',
  '/app/icon-512.png',
  '/app/manifest.webmanifest',
]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_PATHS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request)
      .then(response => {
        if (response.ok) void caches.open(CACHE_NAME).then(cache => cache.put('/app/', response.clone()))
        return response
      })
      .catch(() => caches.match('/app/')))
    return
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) void caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()))
    return response
  }).catch(() => caches.match(event.request)))
})
