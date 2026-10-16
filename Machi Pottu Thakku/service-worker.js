const CACHE_NAME = 'mpt-cache-v7';
const LOCAL_ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/manifest.webmanifest',
  '/js/vendor/lucide.min.js',
  '/assets/covers/default.svg',
  '/assets/covers/tamil-hits.svg',
  '/assets/covers/melody.svg',
  '/assets/covers/folk.svg',
  '/assets/covers/retro.svg'
];
const EXTERNAL_ASSETS_TO_CACHE = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // 1. Reliably cache local assets
      await cache.addAll(LOCAL_ASSETS_TO_CACHE);

      // 2. Best-effort cache for external assets (does not fail installation if offline)
      await Promise.allSettled(
        EXTERNAL_ASSETS_TO_CACHE.map(url =>
          fetch(url)
            .then(res => {
              if (res && res.status === 200) {
                return cache.put(url, res);
              }
            })
            .catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => {
          return name !== CACHE_NAME;
        }).map(name => {
          return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Network-first for songs.json
  if (event.request.url.includes('/data/songs.json')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // Network-first for JavaScript files
  if (event.request.url.endsWith('.js')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache the latest version if successful
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache if network fails
          return caches.match(event.request);
        })
    );
    return;
  }
  
  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request).then(
          function(response) {
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            var responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(function(cache) {
                if (!event.request.url.startsWith('chrome-extension')) {
                  cache.put(event.request, responseToCache);
                }
              });
            return response;
          }
        );
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      })
  );
});
