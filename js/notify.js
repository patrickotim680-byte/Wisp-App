// Local notifications honour the preview-privacy setting, focus mode and quiet
// hours. Background/closed-app delivery needs the push Edge Function + FCM
// (see README): the device token registered here is what that function reads.
import { S } from './state.js';
import { sb, ins } from './db.js';
import { toast } from './util.js';

export async function askPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') await Notification.requestPermission();
  return Notification.permission === 'granted';
}

export function notify(chat, m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const mode = S.settings.notif_preview;
  const who = chat.name || 'New message';
  const title = mode === 'hidden' ? 'Wisp' : who;
  const body = mode === 'full'
    ? (m.body || `[${m.kind}]`).slice(0, 140)
    : mode === 'sender_only' ? 'New message' : 'New message';
  const n = new Notification(title, { body, tag: chat.chat_id, silent: false });
  n.onclick = () => { window.focus(); location.hash = '#chat/' + chat.chat_id; n.close(); };
  playSound();
}

let ctx;
export function playSound() {
  const tone = { chime: [880, 1320], knock: [220, 180], pop: [660, 990], none: null }[S.settings.notif_sound] ?? [880, 1320];
  if (!tone) return;
  try {
    ctx = ctx || new AudioContext();
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

// Registers this browser as a device row so the push function can target it.
export async function registerDevice() {
  try {
    const key = 'wisp.device';
    let token = sessionStorage.getItem(key);
    if (!token) { token = 'web:' + crypto.randomUUID(); sessionStorage.setItem(key, token); }
    await sb.from('devices').upsert({
      user_id: S.me.id, token, platform: 'web',
      label: navigator.userAgent.slice(0, 60), last_active: new Date().toISOString(),
    }, { onConflict: 'user_id,token' });
  } catch (e) { console.warn('device register failed', e); }
}
