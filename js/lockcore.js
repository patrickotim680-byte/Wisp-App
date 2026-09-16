// ── Chat lock: the decisions, with nothing attached ─────────────────────────
// Every rule the lock depends on lives here as a pure function: no DOM, no
// network, no Supabase, no globals. That is deliberate — this is the half of
// the feature that can be unit tested for real (see tests/lockcore.test.js),
// and chatlock.js is left holding only wiring.
//
// Threat model, stated plainly so the code can be judged against it: the
// adversary is a person holding your unlocked phone, or reading over your
// shoulder. It is NOT the server (a chat lock is a member-side flag, and the
// messages are still readable by your own account — that is what E2EE is for)
// and it is NOT someone with your account password (that is what the reset
// path deliberately allows).
//
// So "really works" means, concretely:
//   1. the PIN cannot be brute forced faster than the cooldown allows,
//   2. the lock cannot be changed or removed without the PIN,
//   3. nothing about the chat leaks anywhere a locked chat is not open:
//      list preview, notification, search results, badge text,
//   4. it comes back on its own — a session that stays unlocked forever is
//      not a lock, it is a speed bump.

export const RELOCK_MODES = ['immediate', '1m', '15m', 'session'];
export const RELOCK_LABEL = {
  immediate: 'As soon as I leave the chat',
  '1m': 'After 1 minute away',
  '15m': 'After 15 minutes away',
  session: 'When the app is closed',
};
export const MAX_ATTEMPTS = 5;

/* Mirrors chat_lock_cooldown() in the migration. Both sides are asserted
   against the same table of pairs in the tests; the server is the one that
   enforces it, this copy only draws the countdown. */
export function cooldownFor(fails) {
  const f = Number(fails) || 0;
  if (f < 5) return 0;
  if (f === 5) return 30;
  if (f === 6) return 60;
  if (f === 7) return 300;
  return 900;
}

/* Mirrors chat_lock_pin_ok(). Rejecting 1234/0000 client-side is a courtesy;
   the server rejects them too, so a hand-rolled request cannot set one. */
export function validatePin(pin) {
  if (pin === null || pin === undefined) return { ok: false, reason: 'Enter a PIN.' };
  const s = String(pin);
  if (!/^[0-9]+$/.test(s)) return { ok: false, reason: 'Digits only.' };
  if (s.length < 4 || s.length > 8) return { ok: false, reason: 'Use 4 to 8 digits.' };
  if (/^(\d)\1+$/.test(s)) return { ok: false, reason: 'That is the same digit repeated — too easy to shoulder-surf.' };
  const codes = [...s].map(c => c.charCodeAt(0));
  const run = step => codes.every((c, i) => i === 0 || c === codes[i - 1] + step);
  if (run(1) || run(-1)) return { ok: false, reason: 'That is a straight run of digits — pick something less obvious.' };
  return { ok: true, reason: '' };
}

/* What the chat list is allowed to say about a chat. A locked chat with
   hide_preview on gets one fixed string and never the message text — the
   redaction also happens in SQL (chat_overview), so this is belt and braces,
   not the only line of defence. */
export function previewFor(chat, { unlocked = false } = {}) {
  const kindWord = {
    image: 'Photo', video: 'Video', voice: 'Voice note', audio: 'Audio',
    document: 'Document', location: 'Location', contact: 'Contact', poll: 'Poll', call: 'Call',
  };
  if (chat?.locked && chat?.lock_hide_preview !== false && !unlocked) return 'Locked chat';
  if (chat?.locked && !unlocked && chat?.lock_hide_preview === false) {
    return chat.last_body || kindWord[chat.last_kind] || 'Locked chat';
  }
  if (chat?.e2ee && !chat?.last_body) return 'Encrypted message';
  return chat?.last_body || kindWord[chat?.last_kind] || 'No messages yet';
}

/* Notifications for a locked chat never carry the sender or the text, whatever
   the account-wide preview setting says: the whole point is that the screen is
   visible to someone who should not be reading it. */
export function notifyPayload(chat, message, previewMode = 'full') {
  if (chat?.locked) return { title: 'Wisp', body: 'Message in a locked chat', redacted: true };
  const who = chat?.name || 'New message';
  if (previewMode === 'hidden') return { title: 'Wisp', body: 'New message', redacted: true };
  if (previewMode === 'sender_only') return { title: who, body: 'New message', redacted: true };
  return { title: who, body: String(message?.body || `[${message?.kind || 'message'}]`).slice(0, 140), redacted: false };
}

/* Should this chat be sitting behind the gate right now? */
export function needsGate(chat, unlockedAt, now = Date.now()) {
  if (!chat?.locked) return false;
  if (unlockedAt === null || unlockedAt === undefined) return true;
  return relockDue(chat.lock_relock, unlockedAt, now, { away: false });
}

/* The relock policy, in one place.
     immediate  the moment the chat is not open any more
     1m / 15m   that long after you last had it open
     session    only when the tab/app goes away (sessionStorage does that for
                us, so nothing to time out)
   `away` is true when the chat is closed or the app is backgrounded. */
export function relockDue(mode, unlockedAt, now = Date.now(), { away = false } = {}) {
  // `=== null` and not `!unlockedAt`: 0 is a legal epoch, and treating it as
  // "never unlocked" is exactly the kind of falsy-check bug that makes a lock
  // look like it works while it re-prompts (or worse, does not) at the edges.
  if (unlockedAt === null || unlockedAt === undefined || Number.isNaN(Number(unlockedAt))) return true;
  const idle = now - unlockedAt;
  switch (mode) {
    case 'immediate': return !!away;
    case '1m': return idle >= 60_000;
    case '15m': return idle >= 15 * 60_000;
    case 'session':
    default: return false;
  }
}

/* Sweep of the whole unlocked set, used by the timer and by visibilitychange.
   Returns the chat ids that should be forgotten. */
export function expiredUnlocks(unlockedMap, chatsById, now = Date.now(), { away = false } = {}) {
  const out = [];
  for (const [chatId, at] of unlockedMap) {
    const chat = chatsById.get ? chatsById.get(chatId) : chatsById[chatId];
    if (!chat) continue;
    if (!chat.locked) { out.push(chatId); continue; }
    if (relockDue(chat.lock_relock, at, now, { away })) out.push(chatId);
  }
  return out;
}

/* Which chats a locked-chat-aware list should show. `Locked` is its own tab,
   the way WhatsApp does it, and a chat with hide_in_list on appears nowhere
   else — including search-as-you-type, which is why this is shared. */
export function visibleInList(chat, { folder = null, unlockedIds = new Set() } = {}) {
  const hidden = chat?.locked && chat?.lock_hide_in_list && !unlockedIds.has(chat.chat_id);
  if (folder === 'locked') return !!chat?.locked;
  if (hidden) return false;
  return true;
}

/* Chat ids that may be searched server-side. Anything locked and not unlocked
   in this session is left out of the request entirely, so the reply cannot
   contain a snippet of it. */
export function searchableUnlocked(chats, unlockedIds) {
  return chats.filter(c => c.locked && unlockedIds.has(c.chat_id)).map(c => c.chat_id);
}

/* Turn the jsonb from verify_chat_lock() into something a human reads. */
export function attemptMessage(res) {
  if (!res) return 'Could not check that PIN.';
  if (res.ok) return '';
  const wait = Number(res.wait_seconds) || 0;
  if (wait > 0) {
    const mins = Math.floor(wait / 60), secs = wait % 60;
    const when = mins ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
    return `Too many wrong PINs. Try again in ${when}.`;
  }
  const left = Number(res.attempts_left);
  if (Number.isFinite(left) && left > 0) return `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
  return 'Wrong PIN.';
}

export const countdownText = secs => {
  const s = Math.max(0, Math.ceil(secs));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
};
