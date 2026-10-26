/* A deliberately small shell cache. API responses and media are never cached.
   The shell is network-first so a local update is visible on the next load;
   the cache is only an offline fallback. */
const CACHE = 'jarvis-shell-v5'
const SHELL = ['/', '/styles.css', '/studio.css', '/app.js', '/studio.js', '/visual.js', '/manifest.webmanifest', '/icons/jarvis.svg']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => undefined)
        }
        return response
      })
      .catch(async () => (await caches.match(event.request)) || (await caches.match('/'))),
  )
})
