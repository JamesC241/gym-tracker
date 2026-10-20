/*
 * sw.js — the service worker. It saves a copy of the app's files on the
 * phone so the app opens and works with no signal.
 *
 * It does NOT touch your workout data (that's in IndexedDB, not this cache).
 *
 * ►► WHEN YOU CHANGE THE APP: bump VERSION below, then deploy. ◄◄
 * Phones will download the new files in the background and show an
 * "Update" banner. Tapping it switches to the new version.
 * If you add a new file to the app, also add it to ASSETS.
 */

const VERSION = '1.1.0';
const CACHE = `gym-tracker-v${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/progression.js',
  'js/backup.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

// Install: download every file fresh (bypassing the HTTP cache) into a new cache.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  // We don't skipWaiting() here: the page asks for it when you tap "Update".
});

// Activate: delete caches from older versions, then take control of open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('gym-tracker-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: serve from the cache first (works offline), fall back to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Page loads always get the cached app shell (index.html).
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { ignoreSearch: true }).then((hit) => hit || fetch(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});

// Messages from the page.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage(VERSION);
});
