// Shows notifications for pushes delivered by the push-notify Edge Function.
// Registering a real push subscription requires a provider key (see README):
// without it this worker still runs, it just never receives a push.
//
// Private Vault: a payload marked private is rendered generically here as well,
// no matter what it contains. The Edge Function already strips the sender, the
// message and the conversation id before sending — this is the second gate, so
// that a payload that somehow arrives with more in it than it should still
// cannot put a private conversation on a lock screen. The service worker runs
// while the app is closed and the vault is locked, so it is exactly the place
// that must not be clever.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const isPrivate = data => data?.private === '1' || data?.private === 1 || data?.private === true;

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'Wisp', body: event.data?.text() || '' }; }
  const data = payload.data || payload;
  const priv = isPrivate(data);

  const title = priv ? 'Wisp' : (data.title || 'Wisp');
  const body = priv ? 'New private message' : (data.body || 'New message');
  // One shared tag for private messages, so the lock screen does not count out
  // how many private conversations are active either.
  const tag = priv ? 'wisp-private' : (data.chat_id || 'wisp');

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data: priv ? { private: '1' } : data,
    renotify: true,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  // A private notification never deep-links: the URL would name the
  // conversation, and URLs end up in history. It opens the vault, which then
  // asks for authentication.
  const url = isPrivate(data) ? '/#vault' : '/#chat/' + (data.chat_id || '');
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
