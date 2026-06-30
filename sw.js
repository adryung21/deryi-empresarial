const CACHE_NAME = 'deryi-empresarial-multiempresa-v1-9-pdf-profesional';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=1.9',
  './app.js?v=1.9',
  './firebase-config.js',
  './manifest.json',
  './favicon.png',
  './assets/logo.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function shouldUseNetworkFirst(request) {
  const url = new URL(request.url);
  if (request.mode === 'navigate') return true;
  return ['/', '/index.html', '/app.js', '/styles.css', '/sw.js'].some(path => url.pathname.endsWith(path));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (shouldUseNetworkFirst(request)) {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok && new URL(request.url).origin === location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response && response.ok && new URL(request.url).origin === location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match('./index.html')))
  );
});
