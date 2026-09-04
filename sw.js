// Shows notifications for pushes delivered by the push-notify Edge Function.
// Registering a real push subscription requires a provider key (see README):
// without it this worker still runs, it just never receives a push.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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
