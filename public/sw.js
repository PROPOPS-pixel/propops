/* PropOps PWA Service Worker — cache-first for static ASSETS only */
/* v5 — never cache HTML pages, /api/, or navigation requests */
/* v5 fix: HTML pages were being cached by v4, causing propops.trade to serve
   stale propops.pro content. Now only icons/manifest are cached. */
const CACHE_NAME = 'propops-v5';
const ASSETS = [
  '/favicon.svg',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
  '/offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Delete ALL old caches (including propops-v4 which cached HTML pages)
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never proxy API responses — must always be fresh (user-specific authenticated data)
  if (url.pathname.startsWith('/api/')) return;

  // NEVER cache HTML pages or navigation requests — domain routing depends on hostname
  // which the SW cannot distinguish. Let the server always decide what HTML to serve.
  if (event.request.mode === 'navigate') return;
  if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/dashboard.html') return;
  if (url.pathname.endsWith('.html')) return;

  // Only cache known static assets (images, icons, manifest)
  // Skip anything that isn't in the pre-cached ASSETS list or a static file type
  const isStaticAsset = url.pathname.match(/\.(svg|png|jpg|jpeg|gif|ico|woff2?|ttf|css|js)$/);
  if (!isStaticAsset) return;

  // Don't cache hugo-widget.js — it has no-cache headers for a reason
  if (url.pathname === '/hugo-widget.js') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(function() {
        // Network failed and nothing in cache — serve offline fallback
        // Only for same-origin page requests (not API, fonts, images, etc.)
        if (url.protocol === 'https:' && url.origin === self.location.origin) {
          return caches.match('/offline.html');
        }
        return new Response('', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});

// ─── Push Notification Handler ────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'PropOps', body: event.data ? event.data.text() : 'New notification' };
  }

  const title   = data.title || 'PropOps';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.svg',
    badge: '/favicon.svg',
    tag: data.tag || 'propops-notification',
    data: { url: data.url || '/dashboard' },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification Click Handler ───────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/dashboard';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if already open
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});