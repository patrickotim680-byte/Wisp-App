// ── Chat lock: the wiring ────────────────────────────────────────────────
// Every decision this file makes is imported from lockcore.js, which is unit
// tested. What lives here is the PIN pad, the RPC calls and the timers.
//
// What changed, and why the old version did not really work:
//   • The gate was promptBox() — one text field, one shot. A wrong PIN closed
//     the dialog and toasted, and there was no limit, so a PIN could be
//     guessed as fast as you could tap. Now: a real pad, in-place errors, and
//     an escalating server-side cooldown you can watch tick down.
//   • The lock could be switched off from chat details without knowing it.
//     Now set_chat_lock() demands the current PIN, in Postgres.
//   • S.unlocked was write-only: once unlocked, a chat stayed unlocked until
//     the page was reloaded. Now there is a relock policy per chat, and the
//     app rechecks on close, on backgrounding and on a timer.
//   • The chat list, notifications and global search all still showed the
//     content of a locked chat. Those are fixed at their own call sites, but
//     they all read the same two helpers from here and lockcore.js.
import { rpc } from './db.js';
import { S } from './state.js';
import { $, h, clear, toast, oops, modal, closeModal, iconEl, paintIcons } from './util.js';
import {
  validatePin, attemptMessage, countdownText, needsGate, expiredUnlocks,
  searchableUnlocked, RELOCK_MODES, RELOCK_LABEL,
} from './lockcore.js';

/* chat_id -> epoch ms of the unlock. Deliberately in memory only: a reload is
   an app restart as far as a lock is concerned, so it asks again. S.unlocked
   (a Set) is kept in step for anything older that still reads it. */
const unlockedAt = new Map();

export const isUnlocked = chatId => {
  const chat = S.chats.find(c => c.chat_id === chatId);
  if (!chat) return unlockedAt.has(chatId);
  return !needsGate(chat, unlockedAt.has(chatId) ? unlockedAt.get(chatId) : null);
};

export function markUnlocked(chatId) {
  unlockedAt.set(chatId, Date.now());
  S.unlocked.add?.(chatId);
}

export function relock(chatId) {
  unlockedAt.delete(chatId);
  S.unlocked.delete?.(chatId);
}

export function relockAll() {
  unlockedAt.clear();
  S.unlocked.clear?.();
}

export const unlockedIds = () => new Set([...unlockedAt.keys()]);

/* Chat ids that global search is allowed to look inside. */
export const searchableLockedIds = () => searchableUnlocked(S.chats || [], unlockedIds());

/* Relock sweep. `away` means the chat was closed or the app was backgrounded,
   which is what the 'immediate' policy waits for. A chat that gets relocked
   while it is open is also closed, otherwise the messages stay on screen
   behind a lock that thinks it is on. */
export async function sweepLocks({ away = false } = {}) {
  const byId = new Map((S.chats || []).map(c => [c.chat_id, c]));
  const gone = expiredUnlocks(unlockedAt, byId, Date.now(), { away });
  if (!gone.length) return;
  gone.forEach(id => relock(id));
  const open = S.chat?.chat_id;
  if (open && gone.includes(open) && byId.get(open)?.locked) {
    const { closeChat, renderChatList } = await import('./chats.js');
    closeChat();
    renderChatList();
    toast('Locked again.');
  } else {
    const { renderChatList } = await import('./chats.js');
    renderChatList();
  }
}

let sweepTimer = null;
export function mountChatLock() {
  clearInterval(sweepTimer);
  // 15s is fine for a 1m/15m policy and costs nothing: it is a Map walk.
  sweepTimer = setInterval(() => sweepLocks({ away: !S.chat }), 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sweepLocks({ away: true });
  });
  addEventListener('pagehide', () => relockAll());
}

/* ── the pad ─────────────────────────────────────────────────────────────
   Digits, a masked readout, an error line that stays put instead of a toast
   that flies past, and a countdown that disables the pad while the server is
   in a cooldown. Resolves true only when Postgres said the PIN was right. */
export function pinPad({ title = 'Locked chat', note = '', confirmLabel = 'Unlock',
                         verify, onForgot = null, min = 4, max = 8 } = {}) {
  return new Promise(resolve => {
    let value = '', cooldown = 0, timer = null, settled = false;

    const dots = h('div', { class: 'pin-dots' });
    const err = h('p', { class: 'pin-err', role: 'alert' });
    const okBtn = h('button', { class: 'btn primary' }, confirmLabel);
    const pad = h('div', { class: 'pin-pad' });

    const done = v => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      closeModal();
      removeEventListener('keydown', onKey, true);
      resolve(v);
    };

    const paint = () => {
      clear(dots);
      const n = Math.max(min, value.length);
      for (let i = 0; i < n; i++) dots.append(h('i', { class: i < value.length ? 'is-on' : '' }));
      okBtn.disabled = value.length < min || cooldown > 0;
      pad.classList.toggle('is-cold', cooldown > 0);
    };

    const shake = () => {
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
    };

    const startCooldown = secs => {
      cooldown = Math.ceil(secs);
      clearInterval(timer);
      const tick = () => {
        if (cooldown <= 0) { clearInterval(timer); err.textContent = 'Try again now.'; paint(); return; }
        err.textContent = `Too many wrong PINs. Try again in ${countdownText(cooldown)}.`;
        cooldown -= 1;
        paint();
      };
      tick();
      timer = setInterval(tick, 1000);
    };

    const submit = async () => {
      if (cooldown > 0) return;
      const check = validatePin(value);
      if (!check.ok) { err.textContent = check.reason; value = ''; paint(); shake(); return; }
      okBtn.disabled = true;
      try {
        const res = await verify(value);
        if (res?.ok) return done(true);
        value = ''; paint(); shake();
        err.textContent = res?.reason || attemptMessage(res);
        if (Number(res?.wait_seconds) > 0) startCooldown(Number(res.wait_seconds));
      } catch (e) {
        err.textContent = e?.message === 'wrong_pin' ? 'Wrong PIN.' : (e?.message || 'That did not work.');
        value = ''; paint(); shake();
      }
      paint();
    };

    const push = d => {
      if (cooldown > 0 || value.length >= max) return;
      value += d;
      err.textContent = '';
      paint();
      try { navigator.vibrate?.(8); } catch {}
    };
    const back = () => { value = value.slice(0, -1); paint(); };

    const onKey = e => {
      if (!document.getElementById('modal')?.open) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); push(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!okBtn.disabled) submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };

    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(d =>
      pad.append(h('button', { class: 'pin-key', type: 'button', onclick: () => push(d) }, d)));
    pad.append(h('button', { class: 'pin-key pin-ghost', type: 'button', disabled: true }, ''));
    pad.append(h('button', { class: 'pin-key', type: 'button', onclick: () => push('0') }, '0'));
    pad.append(h('button', { class: 'pin-key pin-back', type: 'button', title: 'Delete', onclick: back },
      iconEl('back', 20)));

    okBtn.onclick = submit;
    paint();

    modal(
      h('div', { class: 'pin-sheet' },
        h('div', { class: 'pin-badge' }, iconEl('lock', 22)),
        h('h3', { class: 'display' }, title),
        note && h('p', { class: 'hint' }, note),
        dots, err, pad,
        h('div', { class: 'modal-actions' },
          onForgot && h('button', { class: 'btn ghost', onclick: () => { done(false); onForgot(); } }, 'Forgot PIN'),
          h('button', { class: 'btn ghost', onclick: () => done(false) }, 'Cancel'),
          okBtn)));
    paintIcons($('#modal-body'));
    addEventListener('keydown', onKey, true);
  });
}

/* The gate openChat() waits on. True means "go ahead and open it". */
export async function gateChat(chatId) {
  const chat = S.chats.find(c => c.chat_id === chatId);
  if (!chat?.locked) return true;
  if (isUnlocked(chatId)) { markUnlocked(chatId); return true; }

  const ok = await pinPad({
    title: 'Locked chat',
    note: `${chat.name || 'This chat'} is locked on this account.`,
    verify: pin => rpc('verify_chat_lock', { p_chat: chatId, p_pin: pin }),
    onForgot: () => forgotPinFlow(chat),
  });
  if (ok) markUnlocked(chatId);
  return ok;
}

/* Forgot the PIN: prove the account password, which is checked in Postgres
   against the hash GoTrue stores, and the lock comes off. Nothing here can
   read or reveal the PIN itself — there is nothing to read, it is bcrypt. */
export async function forgotPinFlow(chat) {
  const input = h('input', { type: 'password', autocomplete: 'current-password' });
  const err = h('p', { class: 'pin-err' });
  const pw = await new Promise(res => {
    const go = async () => {
      const v = input.value;
      if (!v) { err.textContent = 'Enter your account password.'; return; }
      closeModal(); res(v);
    };
    modal(
      h('h3', { class: 'display' }, 'Remove the lock'),
      h('p', { class: 'hint' }, 'Your account password takes the lock off this chat. The PIN itself cannot be recovered \u2014 it is stored as a bcrypt hash, not as something readable.'),
      h('label', {}, 'Account password', input), err,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: go }, 'Remove lock')));
    input.focus();
  });
  if (!pw) return false;
  try {
    const ok = await rpc('reset_chat_lock', { p_chat: chat.chat_id, p_password: pw });
    if (!ok) { toast('That password did not match, so the lock stayed on.', true); return false; }
    relock(chat.chat_id);
    const { loadChats } = await import('./chats.js');
    await loadChats();
    toast('Lock removed for this chat.');
    return true;
  } catch (e) { oops(e); return false; }
}

/* ── settings: turn it on, change it, tune it ─────────────────────────── */
export async function turnLockOn(chat) {
  // Two entries that have to match, so a mistyped PIN cannot lock you out of
  // your own chat. The first pad captures, the second compares — and the
  // comparison happens here, never on the way to the server.
  let firstPin = null;
  const one = await pinPad({
    title: 'Set a PIN',
    note: '4 to 8 digits. Not all one digit and not a straight run \u2014 Postgres refuses those too, not just this screen.',
    confirmLabel: 'Continue',
    verify: async pin => {
      const check = validatePin(pin);
      if (!check.ok) return { ok: false, wait_seconds: 0, attempts_left: 5, reason: check.reason };
      firstPin = pin;
      return { ok: true };
    },
  });
  if (!one || !firstPin) return false;

  const two = await pinPad({
    title: 'Confirm the PIN',
    note: 'Type the same digits once more.',
    confirmLabel: 'Lock this chat',
    verify: async pin => (pin === firstPin
      ? { ok: true }
      : { ok: false, wait_seconds: 0, attempts_left: 5 }),
  });
  if (!two) { firstPin = null; return false; }

  try {
    await rpc('set_chat_lock', { p_chat: chat.chat_id, p_pin: firstPin, p_old_pin: null });
    markUnlocked(chat.chat_id);
    const { loadChats } = await import('./chats.js');
    await loadChats();
    toast('This chat is locked now.');
    return true;
  } catch (e) {
    if (/weak_pin/.test(e?.message || '')) toast('Pick a less guessable PIN \u2014 not 1234, not 0000.', true);
    else if (/locked_out/.test(e?.message || '')) toast('Too many wrong tries. Wait for the cooldown.', true);
    else oops(e);
    return false;
  } finally {
    firstPin = null;
  }
}

export async function turnLockOff(chat) {
  let oldPin = null;
  const got = await pinPad({
    title: 'Remove the lock',
    note: 'Enter the current PIN.',
    confirmLabel: 'Remove lock',
    verify: async pin => {
      const res = await rpc('verify_chat_lock', { p_chat: chat.chat_id, p_pin: pin });
      if (res?.ok) oldPin = pin;
      return res;
    },
    onForgot: () => forgotPinFlow(chat),
  });
  if (!got || !oldPin) return false;
  try {
    await rpc('set_chat_lock', { p_chat: chat.chat_id, p_pin: null, p_old_pin: oldPin });
    relock(chat.chat_id);
    const { loadChats } = await import('./chats.js');
    await loadChats();
    toast('Lock removed.');
    return true;
  } catch (e) { oops(e); return false; }
}

export async function changePin(chat) {
  let oldPin = null;
  const ok = await pinPad({
    title: 'Change the PIN',
    note: 'Current PIN first.',
    confirmLabel: 'Continue',
    verify: async pin => {
      const res = await rpc('verify_chat_lock', { p_chat: chat.chat_id, p_pin: pin });
      if (res?.ok) oldPin = pin;
      return res;
    },
    onForgot: () => forgotPinFlow(chat),
  });
  if (!ok || !oldPin) return false;
  let fresh = null;
  const set = await pinPad({
    title: 'New PIN',
    note: '4 to 8 digits.',
    confirmLabel: 'Continue',
    verify: async pin => {
      const check = validatePin(pin);
      if (!check.ok) return { ok: false, wait_seconds: 0, attempts_left: 5, reason: check.reason };
      fresh = pin;
      return { ok: true };
    },
  });
  if (!set || !fresh) return false;
  const again = await pinPad({
    title: 'Confirm the new PIN',
    note: 'Once more.',
    confirmLabel: 'Save',
    verify: async pin => (pin === fresh ? { ok: true } : { ok: false, wait_seconds: 0, attempts_left: 5 }),
  });
  if (!again) return false;
  try {
    await rpc('set_chat_lock', { p_chat: chat.chat_id, p_pin: fresh, p_old_pin: oldPin });
    markUnlocked(chat.chat_id);
    toast('PIN changed.');
    return true;
  } catch (e) {
    if (/weak_pin/.test(e?.message || '')) toast('Pick a less guessable PIN.', true);
    else oops(e);
    return false;
  }
}

export async function setRelock(chat, mode) {
  if (!RELOCK_MODES.includes(mode)) return;
  await rpc('set_chat_lock_prefs', { p_chat: chat.chat_id, p_relock: mode });
  chat.lock_relock = mode;
}

export async function setLockPrefs(chat, { hidePreview = null, hideInList = null } = {}) {
  await rpc('set_chat_lock_prefs', {
    p_chat: chat.chat_id,
    p_hide_preview: hidePreview,
    p_hide_in_list: hideInList,
  });
  if (hidePreview !== null) chat.lock_hide_preview = hidePreview;
  if (hideInList !== null) chat.lock_hide_in_list = hideInList;
}

export const relockOptions = () => RELOCK_MODES.map(m => [m, RELOCK_LABEL[m]]);
