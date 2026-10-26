/* A deliberately small shell cache. API responses and media are never cached.
   The shell is network-first so a local update is visible on the next load;
   the cache is only an offline fallback. */
const CACHE = 'jarvis-shell-v11'
const SHELL = ['/', '/styles.css', '/studio.css', '/pair.css', '/app.js', '/studio.js', '/visual.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/jarvis.svg']

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
  // Never put a URL that carries an access token into Cache Storage.
  if (url.searchParams.has('token')) return
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
