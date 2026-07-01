// Nova service worker — installable PWA support + offline shell.
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). Use string concatenation only.
// Bump CACHE_VERSION whenever the shell or cached assets change.
var CACHE_VERSION = 'nova-v87';
var SHELL_ASSETS = [
  '/',
  '/index.html',
  '/js/app.js',
  '/js/vault.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon-180.png',
  '/favicon-32.png'
];

// Install: pre-cache the app shell.
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Activate: drop old caches.
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) { return caches.delete(k); }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle GET; let everything else hit the network untouched.
  if (req.method !== 'GET') { return; }

  var url = new URL(req.url);

  // Same-origin only.
  if (url.origin !== self.location.origin) { return; }

  // NEVER cache the API — always go to the network, fail naturally if offline.
  if (url.pathname.indexOf('/api/') === 0) { return; }

  // Navigation requests (the SPA shell): network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put('/', copy); });
        return res;
      }).catch(function () {
        return caches.match('/').then(function (cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // Static assets: stale-while-revalidate. Serve the cached copy instantly and
  // refresh it in the background so a new deploy lands on the next load.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});

// Allow the page to tell a waiting worker to take over immediately, and to ask
// the active worker which version it is (so the UI can show the real version).
self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (event.data && event.data.type === 'GET_VERSION') {
    var v = CACHE_VERSION.replace(/^nova-/, '');
    var reply = { type: 'VERSION', version: v };
    if (event.ports && event.ports[0]) { event.ports[0].postMessage(reply); }
    else if (event.source && event.source.postMessage) { event.source.postMessage(reply); }
  }
});

// --- Web push notifications ---
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'Nova';
  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/favicon-32.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(url) !== -1 && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
