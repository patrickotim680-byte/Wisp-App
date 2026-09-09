// Service worker: background notifications and nothing else.
//
// No fetch handler on purpose. A caching layer here would serve stale JS after
// a deploy, which is a far worse bug than a slightly slower cold start, and
// the app already keeps its own IndexedDB thread cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const ICON = '/assets/icon-192.png';

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'Wisp', body: event.data?.text() || '' }; }
  const data = payload.data || payload;
  const title = data.title || 'Wisp';
  const body = data.body || 'New message';

  event.waitUntil((async () => {
    // If a window is open and already looking at this chat, a system
    // notification on top of it is just noise.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = clients.find(c => c.focused);
    if (focused && data.chat_id) {
      focused.postMessage({ type: 'push-message', data });
    }
    await self.registration.showNotification(title, {
      body,
      tag: data.chat_id || 'wisp',
      renotify: true,
      icon: ICON,
      badge: ICON,
      data,
      vibrate: [12, 60, 12],
      actions: [{ action: 'open', title: 'Open' }, { action: 'read', title: 'Mark as read' }],
    });
    if (data.unread && self.navigator?.setAppBadge) {
      try { await self.navigator.setAppBadge(Number(data.unread) || 0); } catch {}
    }
  })());
});

self.addEventListener('notificationclick', event => {
  const data = event.notification.data || {};
  event.notification.close();

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = clients[0];

    if (event.action === 'read') {
      // The worker has no auth session of its own, so the open page does it.
      // With no page open, mark-as-read is a no-op rather than a lie.
      if (target) { target.postMessage({ type: 'mark-read', chat_id: data.chat_id }); await target.focus(); }
      return;
    }

    if (target) {
      // postMessage + focus, not navigate(): navigating an open client
      // reloaded the whole app and threw away its state.
      target.postMessage({ type: 'open-chat', chat_id: data.chat_id });
      await target.focus();
      return;
    }
    await self.clients.openWindow('/#chat/' + (data.chat_id || ''));
  })());
});

// Browsers rotate push subscriptions on their own schedule. Without this the
// old endpoint keeps 410-ing and the device silently stops getting anything.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || await self.registration.pushManager.getSubscription();
      const key = event.newSubscription?.options?.applicationServerKey
        || old?.options?.applicationServerKey;
      const fresh = event.newSubscription
        || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({
        type: 'push-resubscribed',
        oldToken: old ? JSON.stringify(old) : null,
        token: JSON.stringify(fresh),
      }));
    } catch (e) {
      // Nothing else to try from here; the next app boot re-subscribes.
      console.warn('resubscribe failed', e);
    }
  })());
});
