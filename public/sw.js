// Keeps the app shell available offline and makes launches instant: the saved
// copy is shown straight away and refreshed in the background, and the page is
// told when a newer version has arrived. Feed data is not handled here; the
// page keeps its own offline copy of lists and articles.
'use strict';
const CACHE = 'reader-shell-v2';
const SHELL = [
  '/', '/style.css', '/theme.js', '/app.js',
  '/modules/api.js', '/modules/db.js', '/modules/prefs.js', '/modules/sanitize.js', '/modules/util.js',
  '/icon.svg', '/icon-192.png', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function refresh(cache, key, had) {
  const res = await fetch(key, { cache: 'no-cache' });
  if (!res.ok) return res;
  await cache.put(key, res.clone());
  const changed = had && had.headers.get('ETag') !== res.headers.get('ETag');
  if (changed) {
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'updated' });
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // The page is the same whatever the query string says, so store it once.
  const key = url.origin + url.pathname;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const had = await cache.match(key, { ignoreVary: true });
      const fresh = refresh(cache, key, had);
      if (!had) return fresh;
      e.waitUntil(fresh.catch(() => {}));
      return had;
    }),
  );
});
