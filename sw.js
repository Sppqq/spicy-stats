// File: sw.js
const CACHE_NAME = 'spicy-monitor-cache-v1.4.10';
const STATIC_ASSETS = [
  '/',
  '/dashboard.html',
  '/user.html',
  '/admin.html',
  '/icon.png',
  '/api.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Caching only requests to our own origin
  if (url.origin !== self.location.origin) {
    return;
  }

  // Skip caching for API queries to ensure real-time data loading
  if (url.pathname.includes('/api/')) {
    return;
  }

  // Handle SPA-like rewrites for service worker caching (navigation requests only)
  let requestTarget = event.request;
  if (event.request.mode === 'navigate') {
    if (url.pathname.startsWith('/user/')) {
      requestTarget = new Request('/user.html');
    } else if (url.pathname === '/admin') {
      requestTarget = new Request('/admin.html');
    } else if (url.pathname === '/') {
      requestTarget = new Request('/dashboard.html');
    }

    // Navigation must prefer the network so releases and settings fixes appear
    // on the first load instead of one refresh behind the service-worker cache.
    event.respondWith(
      fetch(requestTarget).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => cache.put(requestTarget, networkResponse.clone()));
        }
        return networkResponse;
      }).catch(() => caches.match(requestTarget))
    );
    return;
  }

  event.respondWith(
    caches.match(requestTarget).then((cachedResponse) => {
      // Fetch in background and update cache (Stale-While-Revalidate)
      const fetchPromise = fetch(requestTarget).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(requestTarget, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fail silently if user is offline, cachedResponse will still render
      });

      return cachedResponse || fetchPromise;
    })
  );
});
