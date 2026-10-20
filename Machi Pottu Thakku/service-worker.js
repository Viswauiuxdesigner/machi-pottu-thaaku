const CACHE_NAME = 'mpt-cache-v8';
const LOCAL_ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/js/vendor/lucide.min.js',
  '/js/vendor/peerjs.min.js',
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
      // 1. Resiliently cache local assets (avoids install failure if an asset is missing)
      await Promise.allSettled(
        LOCAL_ASSETS_TO_CACHE.map(async url => {
          try {
            const res = await fetch(url);
            if (res && (res.status === 200 || res.type === 'opaque')) {
              await cache.put(url, res);
            }
          } catch (e) {}
        })
      );

      // 2. Best-effort cache for external assets
      await Promise.allSettled(
        EXTERNAL_ASSETS_TO_CACHE.map(async url => {
          try {
            const res = await fetch(url);
            if (res && (res.status === 200 || res.type === 'opaque')) {
              await cache.put(url, res);
            }
          } catch (e) {}
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(async cacheNames => {
      // 1. Delete old cache versions
      await Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );

      // 2. Prune any duplicate audio/media blobs in current cache to reclaim storage
      try {
        const cache = await caches.open(CACHE_NAME);
        const requests = await cache.keys();
        for (const req of requests) {
          const reqUrl = req.url.toLowerCase();
          if (reqUrl.includes('_capacitor_file_') ||
              reqUrl.includes('/music-play') ||
              reqUrl.endsWith('.mp3') ||
              reqUrl.endsWith('.m4a') ||
              reqUrl.endsWith('.wav') ||
              reqUrl.endsWith('.aac') ||
              reqUrl.endsWith('.flac') ||
              reqUrl.endsWith('.ogg')) {
            await cache.delete(req);
          }
        }
      } catch (err) {
        console.warn('[SW] Cache audio cleanup error:', err);
      }
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = event.request.url.toLowerCase();
  const isAudioOrMedia = event.request.destination === 'audio' ||
                         event.request.destination === 'video' ||
                         url.includes('_capacitor_file_') ||
                         url.includes('/music-play') ||
                         url.endsWith('.mp3') ||
                         url.endsWith('.m4a') ||
                         url.endsWith('.wav') ||
                         url.endsWith('.aac') ||
                         url.endsWith('.flac') ||
                         url.endsWith('.ogg');

  // Media files must NEVER be stored in Chromium CacheStorage to prevent massive disk bloat.
  // They are managed strictly via Filesystem / ExoPlayer.
  if (isAudioOrMedia) {
    return;
  }

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
  
  // Cache-first for static assets only (HTML, CSS, images, fonts)
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request).then(
          function(response) {
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            const contentType = response.headers.get('content-type') || '';
            if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
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
