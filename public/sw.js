// Offline support. Caches the site's own files and nothing else: this worker
// never sees the user's file, their usernames or their results.

// Bump the version whenever any file below changes.
const VERSION = 'v8';
const CACHE = `followcheck-${VERSION}`;

const FILES = [
  '/',
  '/privacy',
  '/app.js',
  '/app.css',
  '/core/zip.js',
  '/core/extract.js',
  '/core/analyze.js',
  '/manifest.webmanifest',
  '/fonts/bricolage-grotesque-latin-wght-normal.woff2',
  '/fonts/bricolage-grotesque-latin-ext-wght-normal.woff2',
  '/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2',
  '/fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2',
  '/icons/favicon.svg',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (error) {
        if (request.mode === 'navigate') {
          const home = await cache.match('/');
          if (home) return home;
        }
        throw error;
      }
    }),
  );
});
