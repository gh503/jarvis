/* A deliberately small shell cache. API responses and media are never cached.
   The shell is network-first so a local update is visible on the next load;
   the cache is only an offline fallback. */
const CACHE = 'jarvis-shell-v44'
const SHELL = [
  '/', '/pair', '/pair.js', '/theme-boot.js', '/styles.css', '/studio.css', '/pair.css',
  '/app.js', '/browser-capture.js', '/theme.js', '/studio.js', '/visual.js', '/profile.js', '/profile.css', '/tools.js', '/tools.css', '/local-tools.js', '/local-tools.css', '/manifest.webmanifest',
  '/mcp-services.js', '/mcp-services.css', '/settings-studio.css', '/typography.css', '/product-polish.css',
  '/providers', '/providers.js', '/providers.css',
  '/install', '/install.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/jarvis.svg',
]

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
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => undefined))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(event.request)
        if (cached) return cached
        // Only navigations fall back to the app shell; answering a script or
        // stylesheet request with HTML would break the page in a confusing way.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/')
          if (shell) return shell
        }
        return new Response('offline', { status: 503, statusText: 'offline', headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }),
  )
})
