// Service worker: offline app shell + cached TMDB images. TMDB API calls are NOT cached here
// (the app caches trimmed results itself), and /api/* always goes to the network.
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const IMAGES = 'tmdb-img-v1';
const SHELL_FILES = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest',
  '/js/app.js', '/js/store.js', '/js/dates.js', '/js/tmdb.js', '/js/platforms.js', '/js/releases.js', '/js/ui.js', '/js/ics.js',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== IMAGES) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimImages(max = 400) {
  const c = await caches.open(IMAGES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return; // always live
    // Stale-while-revalidate for the app shell.
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('/') : null);
      const net = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
    })());
    return;
  }

  if (url.hostname === 'image.tmdb.org') {
    e.respondWith((async () => {
      const cache = await caches.open(IMAGES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          await cache.put(req, res.clone());
          e.waitUntil(trimImages());
        }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/#/watchlist';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.navigate(target).catch(() => {}); return w.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
