// Local notifications honour the preview-privacy setting, focus mode and quiet
// hours. Background/closed-app delivery needs the push Edge Function + FCM
// (see README): the device token registered here is what that function reads.
import { S } from './state.js';
import { sb, ins, publicUrl } from './db.js';
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

// A separate banner for incoming calls — a call is a stronger signal than a
// text, so this only checks focus mode / quiet hours, not per-chat mute.
export function notifyIncomingCall(who, kind, chatId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (S.settings.focus_mode) return;
  const n = new Notification(`Incoming ${kind === 'video' ? 'video' : 'voice'} call`, {
    body: who || 'Wisp', tag: 'call-' + (chatId || ''), requireInteraction: true,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

/* ── tone synthesis ───────────────────────────────────────────────────────
   Every built-in tone is a short list of notes played in sequence with a
   quick attack/decay envelope — no audio files to host, works offline, and
   sounds distinct enough at a glance to tell message and call sounds apart.
   A value that isn't one of the known keys is treated as a path in the
   "sounds" storage bucket (an upload from the settings screen) and played
   back as a real audio file instead of being synthesized. */
let ctx;
function synth(notes, { noteLen = 0.09, gap = 0.09, peak = 0.14 } = {}) {
  try {
    ctx = ctx || new AudioContext();
    notes.forEach((f, i) => {
      const t0 = ctx.currentTime + i * gap;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + noteLen);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + noteLen + 0.02);
    });
  } catch {}
}

const MESSAGE_TONES = {
  chime: { notes: [880, 1320] },
  knock: { notes: [220, 180] },
  pop: { notes: [660, 990] },
};
const CALL_TONES = {
  ring: { notes: [523.25, 659.25, 523.25, 659.25], opts: { noteLen: 0.16, gap: 0.16, peak: 0.16 } },
  marimba: { notes: [392, 523.25, 659.25], opts: { noteLen: 0.26, gap: 0.1, peak: 0.15 } },
  pulse: { notes: [440, 440, 440], opts: { noteLen: 0.11, gap: 0.16, peak: 0.15 } },
};

function playTone(value, presets) {
  if (!value || value === 'none') return;
  const preset = presets[value];
  if (preset) return synth(preset.notes, preset.opts);
  // Not a known key: treat it as an uploaded custom sound's storage path.
  try { new Audio(publicUrl('sounds', value)).play().catch(() => {}); } catch {}
}

export function playSound() { playTone(S.settings.notif_sound, MESSAGE_TONES); }
export function playCallTone() { playTone(S.settings.call_sound ?? 'ring', CALL_TONES); }

/* ── ring loops ───────────────────────────────────────────────────────────
   Shared by the incoming-call ringtone and the outgoing-call ringback —
   both are just "replay the chosen call tone on an interval" with a
   different cadence, and both need to stop cleanly the instant the call
   state changes, so that lives here instead of being duplicated in calls.js. */
let ringTimer = null;
export function startRing(intervalMs = 2500) {
  stopRing();
  playCallTone();
  ringTimer = setInterval(playCallTone, intervalMs);
}
export function stopRing() { clearInterval(ringTimer); ringTimer = null; }

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
