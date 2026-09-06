/* ==========================================================================
   FreeCoffee demo service worker — plain ES2018, no transpiler, no imports.

   Caching strategy:
     - precache (install):  the eight pages + CSS + JS + icons, cache-first
     - navigations:         network-first, fall back to cache (then /index.html)
     - other same-origin GET: cache-first, runtime-cache misses
     - cross-origin / non-GET: untouched — this includes the platform
       backend (POST /track, GET /earnings/…, GET /feed.json on a
       workers.dev origin): dynamic, never precached, never cached.

   Version bump CACHE on any content change — activate() deletes old caches.
   ========================================================================== */
/* eslint-disable no-restricted-globals */
'use strict';

var CACHE = 'freecoffee-v5';

var PRECACHE = [
  './',
  './index.html',
  './dashboard.html',
  './payouts.html',
  './model.html',
  './campaigns.html',
  './profile.html',
  './referrals.html',
  './advertisers.html',
  './assets/css/styles.css',
  './assets/js/demo.js',
  './assets/js/dashboard.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

/* ---------- install: precache everything, take over immediately ---------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
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
  // final fallback to the cached shell (index.html).
  if (request.mode === 'navigate' ||
      (request.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match('./index.html');
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
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
