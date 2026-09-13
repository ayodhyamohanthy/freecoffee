/* ==========================================================================
   FreeCoffee demo service worker — plain ES2018, no transpiler, no imports.

   Caching strategy:
     - precache (install):  all ten pages + CSS + JS + icons + manifest,
       cache-first. Each URL is added individually so one missing file
       can never fail the whole install (cache.addAll is atomic).
     - navigations:         network-first, fall back to cache (then index.html)
     - other same-origin GET: cache-first, runtime-cache misses
     - cross-origin / non-GET: untouched — this includes the platform
       backend (POST /track, GET /earnings/…, GET /feed.json on a
       workers.dev origin): dynamic, never precached, never cached.

   Version bump CACHE on any content change — activate() deletes old caches.
   ========================================================================== */
/* eslint-disable no-restricted-globals */
'use strict';

var CACHE = 'freecoffee-v11';

var PRECACHE = [
  './',
  './index.html',
  './agents.html',
  './dashboard.html',
  './payouts.html',
  './model.html',
  './install-guide.html',
  './campaigns.html',
  './profile.html',
  './referrals.html',
  './advertisers.html',
  './manifest.webmanifest',
  './assets/css/styles.css',
  './assets/js/demo.js',
  './assets/js/dashboard.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
];

var FALLBACK_URL = new URL('./index.html', self.location.href).toString();

function putSafe(cache, request, response) {
  try {
    if (!response || !response.ok) return;
    cache.put(request, response);
  } catch (e) { /* opaque or oversized — non-fatal */ }
}

/* ---------- install: precache everything, take over immediately ---------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var adds = PRECACHE.map(function (url) {
        return cache.add(new URL(url, self.location.href).toString()).catch(function () {
          return null; // one bad URL must never fail the whole install
        });
      });
      return Promise.all(adds);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* ---------- activate: drop old caches, claim existing pages ---------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var stale = keys.filter(function (key) { return key !== CACHE; });
      return Promise.all(stale.map(function (key) { return caches.delete(key); }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Never touch cross-origin or non-GET traffic.
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation requests (HTML pages): network-first, fallback to cache,
  // final fallback to the cached app shell (index.html).
  if (request.mode === 'navigate' ||
      (request.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { putSafe(cache, request, copy); });
        }
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match(FALLBACK_URL);
        });
      })
    );
    return;
  }

  // Everything else same-origin: cache-first; runtime-cache on miss.
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { putSafe(cache, request, copy); });
        }
        return response;
      }).catch(function (err) {
        // Offline and not in cache: surface the network error so the
        // page's own offline handling applies. Never synthesize content.
        throw err;
      });
    })
  );
});
