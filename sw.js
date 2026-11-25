// Shows notifications for pushes delivered by the push-notify Edge Function,
// and precaches the app shell so opening Wisp again — which on a real 2G
// connection can otherwise mean a dozen-odd round trips (index.html, 3
// stylesheets, 20-ish JS modules, icons) before a single pixel of a chat you
// already have paints — costs close to nothing: the shell comes straight out
// of this cache, and the only thing that still has to cross a slow radio is
// the data itself (messages, the chat list). That's the main lever available
// to a browser-based PWA for getting data use and startup time closer to a
// native app's, which never re-downloads its own UI on every open.
//
// There's no build step and no hashed filenames in this project (see
// README), so this can't key cache-busting off a content hash the way a
// bundler output would. Bump CACHE_VERSION by hand whenever any precached
// file changes; the old cache is dropped on activate, and a stale-while-
// revalidate fetch handler means even a missed bump self-heals within one
// extra load instead of sticking forever.
const CACHE_VERSION = 'wisp-shell-v1';
const PRECACHE = [
  '/', '/index.html', '/styles.css', '/call.css', '/theme-packs.css', '/manifest.webmanifest',
  '/js/app.js', '/js/auth.js', '/js/cache.js', '/js/calls.js', '/js/chats.js', '/js/composer.js',
  '/js/crypto.js', '/js/db.js', '/js/env.js', '/js/media.js', '/js/net.js', '/js/notify.js',
  '/js/outbox.js', '/js/panels.js', '/js/settings.js', '/js/state.js', '/js/theme.js',
  '/js/thread.js', '/js/util.js',
  '/assets/icon-192.png', '/assets/icon-512.png', '/assets/wisp-logo.png',
  '/assets/softronics-logo-dark.png', '/assets/softronics-logo-light.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll() fails the whole install if any single file 404s — every path
    // above is relative to this file's own origin and known to exist, so a
    // failure here is loud on purpose (the install just doesn't take, old
    // worker keeps serving) rather than silently caching half a shell.
    await cache.addAll(PRECACHE);
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_VERSION).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Only same-origin GETs for the app shell go through the cache. Everything
// else — Supabase's REST/Realtime/Storage calls, /api/config, the esm.sh
// module CDN, any POST — is left completely alone (no respondWith at all),
// so this never risks serving stale data for a message, a signed media URL,
// or a websocket upgrade.
const isShellRequest = url => url.origin === self.location.origin &&
  (PRECACHE.includes(url.pathname) || url.pathname.startsWith('/js/') ||
   url.pathname.startsWith('/assets/') || /\.(css|webmanifest)$/.test(url.pathname));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!isShellRequest(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(event.request);
    // Stale-while-revalidate: an instant answer from cache when there is
    // one (this is what makes a 2G open feel instant, or work at all while
    // the radio is mid-handoff), plus a background refetch that quietly
    // updates the cache for next time so a real deploy still reaches people
    // within one extra load, without ever blocking this one on the network.
    const revalidate = fetch(event.request).then(res => {
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await revalidate) || new Response('Offline and not yet cached.', { status: 503 });
  })());
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'Wisp', body: event.data?.text() || '' }; }
  const data = payload.data || payload;
  event.waitUntil(self.registration.showNotification(data.title || 'Wisp', {
    body: data.body || 'New message',
    tag: data.chat_id || 'wisp',
    data,
    renotify: true,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = '/#chat/' + (event.notification.data?.chat_id || '');
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
