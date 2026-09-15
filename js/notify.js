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

/* ── custom uploaded tones ────────────────────────────────────────────────
   A storage path instead of a preset key means "play the file this account
   uploaded". The old one line — `new Audio(url).play().catch(() => {})` —
   looked complete and failed in four different ways, all of them silent:

   1. A brand-new Audio element per notification means the file is fetched
      again every time and the first play lands *after* the download, so a
      short tone arrives late or not at all. Now one element per URL, created
      once, preloaded, and rewound instead of rebuilt.
   2. Browsers refuse to play audio before the user has interacted with the
      page. The rejection was swallowed by the empty catch, so a tone that
      never played looked exactly like a tone that worked. Playback is now
      armed on the first real interaction, and a failure says so once.
   3. A song is not a notification. An uploaded 3-minute MP3 played to the end
      over every incoming message; message tones now stop after a few seconds
      with a short fade instead of a hard cut.
   4. A 404 (object deleted, bucket flipped private) produced silence with no
      way to tell. Now it falls back to the built-in tone and says why, once
      per session, so "my sound stopped working" is visible rather than
      mysterious.

   Volume is honoured here as well, for the synthesized presets too, because a
   full-volume 2 kHz sine is its own kind of eye-strain for ears. */
const audioCache = new Map();
let armed = false;
let warned = false;

export function armAudio() {
  if (armed) return;
  armed = true;
  try { ctx = ctx || new AudioContext(); ctx.resume?.(); } catch {}
  audioCache.forEach(a => { try { a.load(); } catch {} });
}
['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
  addEventListener(evt, armAudio, { once: true, passive: true }));

const volume = () => {
  const v = Number(S.settings?.notif_volume);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
};

function customAudio(path) {
  const url = publicUrl('sounds', path);
  if (!url) return null;
  let a = audioCache.get(url);
  if (!a) {
    a = new Audio(url);
    a.preload = 'auto';
    audioCache.set(url, a);
  }
  return a;
}

/* MAX_TONE_MS only applies to message tones: a ringtone is supposed to keep
   going until the call is answered, a message tone is not. */
const MAX_TONE_MS = 6000;

function playFile(path, { loop = false, cap = 0, onFail } = {}) {
  const a = customAudio(path);
  if (!a) return onFail?.();
  a.loop = loop;
  a.volume = volume();
  try { a.currentTime = 0; } catch {}
  const p = a.play();
  if (p?.catch) p.catch(err => {
    // NotAllowedError is the autoplay gate, not a broken file: the next tone
    // after the person touches the app will work, so don't cry wolf.
    if (err?.name !== 'NotAllowedError' && !warned) {
      warned = true;
      toast('Your custom notification sound could not be played, so Wisp used the built-in tone.', true);
    }
    onFail?.();
  });
  if (cap) {
    clearTimeout(a._capTimer);
    a._capTimer = setTimeout(() => fadeOut(a), cap);
  }
  return a;
}

/* A hard pause mid-note is a click; 220ms of ramp is not. */
function fadeOut(a, ms = 220) {
  const from = a.volume, steps = 8, step = from / steps;
  let i = 0;
  const t = setInterval(() => {
    i += 1;
    a.volume = Math.max(0, from - step * i);
    if (i >= steps) { clearInterval(t); try { a.pause(); a.currentTime = 0; } catch {} a.volume = from; }
  }, ms / steps);
}

export function stopFiles() {
  audioCache.forEach(a => {
    clearTimeout(a._capTimer);
    try { a.pause(); a.currentTime = 0; } catch {}
  });
}

function playTone(value, presets, opts = {}) {
  if (!value || value === 'none') return;
  const preset = presets[value];
  if (preset) return synth(preset.notes, { ...preset.opts, peak: (preset.opts?.peak ?? 0.14) * volume() / 0.8 });
  // Not a known key: an uploaded custom sound's storage path. If it cannot be
  // played, fall back to the preset this account would otherwise have had, so
  // a notification is never silently lost.
  const fallback = opts.fallback && presets[opts.fallback];
  playFile(value, {
    loop: !!opts.loop,
    cap: opts.loop ? 0 : MAX_TONE_MS,
    onFail: () => fallback && synth(fallback.notes, fallback.opts),
  });
}

export function playSound() {
  playTone(S.settings.notif_sound, MESSAGE_TONES, { fallback: 'chime' });
}
export function playCallTone({ loop = false } = {}) {
  playTone(S.settings.call_sound ?? 'ring', CALL_TONES, { fallback: 'ring', loop });
}

/* Used by the settings screen so "Preview" and "Test" go through exactly the
   code path a real notification does — previewing something other than what
   will actually play is how the old picker managed to look fine and still be
   wrong. `value` lets it preview a choice that has not been saved yet. */
export function previewSound(kind, value) {
  armAudio();
  const presets = kind === 'call' ? CALL_TONES : MESSAGE_TONES;
  stopFiles();
  playTone(value ?? (kind === 'call' ? (S.settings.call_sound ?? 'ring') : S.settings.notif_sound),
    presets, { fallback: kind === 'call' ? 'ring' : 'chime' });
}

/* Confirms an uploaded object is really readable at its public URL before the
   settings row starts pointing at it — the difference between "saved" and
   "saved and actually works", which is the whole complaint. */
export function verifySound(path, timeoutMs = 8000) {
  return new Promise(resolve => {
    const url = publicUrl('sounds', path);
    if (!url) return resolve(false);
    const a = new Audio();
    const done = ok => { clearTimeout(timer); a.src = ''; resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(true);
    a.onerror = () => done(false);
    a.src = url;
    a.load();
  });
}

/* ── ring loops ───────────────────────────────────────────────────────────
   Shared by the incoming-call ringtone and the outgoing-call ringback —
   both are just "replay the chosen call tone on an interval" with a
   different cadence, and both need to stop cleanly the instant the call
   state changes, so that lives here instead of being duplicated in calls.js. */
let ringTimer = null;
export function startRing(intervalMs = 2500) {
  stopRing();
  armAudio();
  const custom = !CALL_TONES[S.settings?.call_sound ?? 'ring'] && (S.settings?.call_sound ?? '') !== 'none';
  // A custom ringtone loops itself. Re-firing it on a 2.5s timer, which is what
  // the presets need, stacked a fresh copy of an uploaded file over the one
  // still playing every 2.5 seconds until the call was answered.
  playCallTone({ loop: custom });
  if (!custom) ringTimer = setInterval(() => playCallTone(), intervalMs);
}
export function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
  stopFiles();
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
