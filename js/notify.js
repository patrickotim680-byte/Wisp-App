// Notifications, in two halves.
//
// Foreground: the realtime channel sees the INSERT and we show a notification
// ourselves, honouring the preview-privacy setting, focus mode, quiet hours
// and the per-chat level (chats.js decides, this renders).
//
// Background / app closed: the browser has to deliver it, which means a real
// push subscription. registerDevice() used to store an invented token
// ('web:<uuid>'), so the push function had nothing deliverable to send to and
// notifications simply stopped existing the moment the tab did. We register
// the actual pushManager subscription now; the Edge Function sends Web Push
// to it with the VAPID key pair (see supabase/functions/push-notify).
import { S } from './state.js';
import { sb, publicUrl } from './db.js';
import { toast } from './util.js';

let cfg = null;
async function config() {
  if (cfg) return cfg;
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    cfg = r.ok ? await r.json() : {};
  } catch { cfg = {}; }
  return cfg;
}

export async function askPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* Safari <16 callback form */ }
  }
  return Notification.permission === 'granted';
}

const b64ToBytes = b64 => {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

const deviceLabel = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Web';
  const app = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const standalone = matchMedia('(display-mode: standalone)').matches ? ' (installed)' : '';
  return `${app} on ${os}${standalone}`;
};

/* Subscribes this browser for background pushes and records it as a device.
   Safe to call on every boot: an existing subscription is reused, and the
   upsert keys on (user_id, token) so the row is refreshed rather than
   duplicated. */
export async function subscribePush(loud = false) {
  const say = msg => { if (loud) toast(msg, true); return null; };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return say('This browser cannot receive background notifications. Install the app to the home screen, or use Chrome, Edge or Firefox.');
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    const ok = await askPermission();
    if (!ok) return say('Notifications are not allowed for this site yet.');
  }
  const { vapidPublicKey } = await config();
  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch { return say('The service worker is not running yet. Reload and try again.'); }

  let sub = null;
  try { sub = await reg.pushManager.getSubscription(); } catch { /* fall through */ }
  if (!sub) {
    if (!vapidPublicKey) {
      // Without the key pair a subscription cannot be created at all, so be
      // explicit rather than pretending the device is registered.
      await recordDevice('web-local', 'local:' + (S.me?.id || 'me'));
      return say('Background notifications need VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY set on the server.');
    }
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBytes(vapidPublicKey),
      });
    } catch (e) {
      console.warn('push subscribe failed', e);
      return say('The browser refused a push subscription: ' + (e?.message || e));
    }
  }
  await recordDevice('webpush', JSON.stringify(sub));
  if (loud) toast('This device will get notifications even when Wisp is closed.');
  return sub;
}

async function recordDevice(platform, token) {
  if (!S.me?.id) return;
  try {
    await sb.from('devices').upsert({
      user_id: S.me.id, token, platform,
      label: deviceLabel(), last_active: new Date().toISOString(),
    }, { onConflict: 'user_id,token' });
  } catch (e) { console.warn('device register failed', e); }
}

/* Called on boot. Keeps the old name so app.js reads the same. */
export async function registerDevice() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  await subscribePush(false);
}

/* What Settings shows, in plain words instead of an enum. */
export async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, message: 'not available in this browser — add Wisp to your home screen, or use Chrome, Edge or Firefox' };
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return { ok: false, message: 'waiting on permission — allow notifications first' };
  }
  const { vapidPublicKey } = await config();
  if (!vapidPublicKey) return { ok: false, message: 'the server has no VAPID public key set, so no subscription can be created' };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { ok: false, message: 'not registered on this device yet' };
    const rows = await sb.from('devices').select('id').eq('user_id', S.me.id).eq('token', JSON.stringify(sub));
    if (!rows.data?.length) return { ok: false, message: 'registered in the browser but not saved to your account — tap Register this device' };
    return { ok: true, message: 'on — this device gets notifications with Wisp closed' };
  } catch (e) {
    return { ok: false, message: 'could not be checked: ' + (e?.message || e) };
  }
}

/* ── foreground notification ─────────────────────────────────────── */
const KIND_LABEL = {
  image: 'sent a photo', video: 'sent a video', voice: 'sent a voice note',
  audio: 'sent audio', document: 'sent a file', location: 'shared a location',
  contact: 'shared a contact', poll: 'started a poll', sticker: 'sent a sticker',
  call: 'called', text: 'sent a message',
};

export async function notify(chat, m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const mode = S.settings.notif_preview;
  const who = chat.name || 'New message';
  const title = mode === 'hidden' ? 'Wisp' : who;
  const body = mode === 'full'
    ? (m.body ? String(m.body).slice(0, 140) : (KIND_LABEL[m.kind] || 'sent something'))
    : mode === 'sender_only' ? 'sent you a message' : 'New message';

  const opts = {
    body,
    tag: chat.chat_id,          // one line per conversation, not one per message
    renotify: true,
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    silent: S.settings.notif_sound === 'none',
    data: { chat_id: chat.chat_id, message_id: m.id, title, body },
  };

  // Through the service worker when there is one: those survive the tab being
  // backgrounded or closed mid-flight, and they can carry actions.
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg?.showNotification) {
      await reg.showNotification(title, {
        ...opts,
        actions: [{ action: 'open', title: 'Open' }, { action: 'read', title: 'Mark as read' }],
      });
      playSound();
      return;
    }
  } catch { /* fall through to the page-level API */ }

  const n = new Notification(title, opts);
  n.onclick = () => { window.focus(); location.hash = '#chat/' + chat.chat_id; n.close(); };
  playSound();
}

/* ── sound ─────────────────────────────────────────────────── */
let ctx;
const TONES = { chime: [880, 1320], knock: [220, 180], pop: [660, 990], none: null };

export function playSound() {
  const choice = S.settings?.notif_sound ?? 'chime';
  if (choice === 'none') return;
  // An uploaded sound is stored as a path in the same column, which the tone
  // table can never match — the old code fell through to the default chime,
  // so "custom sound" appeared to save and then did nothing.
  if (typeof choice === 'string' && (choice.includes('/') || choice.startsWith('http'))) {
    try {
      const url = choice.startsWith('http') ? choice : publicUrl('sounds', choice);
      const a = new Audio(url);
      a.volume = 0.9;
      a.play().catch(() => beep(TONES.chime));
      return;
    } catch { /* fall back to a tone */ }
  }
  beep(TONES[choice] ?? TONES.chime);
}

function beep(tone) {
  if (!tone) return;
  try {
    ctx = ctx || new AudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    tone.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.09 + 0.28);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.09); o.stop(ctx.currentTime + i * 0.09 + 0.3);
    });
  } catch {}
}
