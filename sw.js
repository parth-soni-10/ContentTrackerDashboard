/* Content Tracker — offline shell.
 *
 * There was no worker on this site, so a dropped connection meant a blank page
 * even though the last rendered snapshot was still in localStorage. This adds
 * one without moving the source of truth: the watchlist still comes from D1
 * through /.netlify/functions/watchlist, and nothing here caches a response from
 * that path.
 *
 * Scope of the cache is the shell only — the page, the stylesheet, the app, the
 * vendored chart build and the icon. Those are network-first, because a cached
 * app.js is how a deployed fix keeps being answered by the copy in the
 * visitor's browser; the cache exists for the request that cannot reach the
 * network at all.
 *
 * A new worker installs and WAITS. The page shows "A new version is ready →
 * Reload" and only then posts SKIP_WAITING, so nobody is swapped onto new code
 * mid-read while the admin panel is open.
 */
var CACHE = 'content-tracker-v1';
var SHELL = [
  './',
  './styles.css',
  './app.js',
  './theme-init.js',
  './vendor/chart.umd.js',
  './favicon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // A missing optional asset must not fail the install, so each file is added
    // on its own rather than through addAll's all-or-nothing behaviour.
    return Promise.all(SHELL.map(function (path) {
      return cache.add(path).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) {
      return caches.delete(key);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  // Posters are on image.tmdb.org / static.tvmaze.com and the media lookups go
  // to those hosts: cross-origin, so not ours to answer.
  if (url.origin !== location.origin) return;
  // Live data, admin routes and the feedback endpoint are never cached. The
  // watchlist is the site's only source of truth and an admin write has to be
  // visible on the next read.
  if (url.pathname.indexOf('/.netlify/') === 0 || url.pathname.indexOf('/api/') === 0) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(function () {
      return caches.match('./').then(function (hit) { return hit || caches.match('./index.html'); });
    }));
    return;
  }

  event.respondWith(fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (hit) {
      return hit || new Response('', { status: 504, statusText: 'Offline' });
    });
  }));
});
