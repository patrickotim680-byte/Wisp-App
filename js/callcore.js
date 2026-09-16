// ── Group calls: the decisions, with nothing attached ───────────────────────
// Same idea as lockcore.js — every rule a call depends on is a pure function
// here, so it can be tested without a browser, a camera or a second human.
// calls.js keeps the parts that genuinely need WebRTC and the DOM.
//
// The model, and why it changed:
//   Before, a call was a ring. One row in `calls`, the caller opened a peer
//   connection to each of the others, and that was the whole life of it. Three
//   consequences, all of them "it does not really work":
//     • callee-to-callee never connected. The caller made a peer for each
//       callee; no callee ever made one for another callee, so in a group of
//       three, B and C could both hear A and neither could hear the other.
//     • there was no way in. Miss the 45-second ring and the call was gone;
//       decline it and there was no second chance; join late — impossible.
//     • every client wrote its own "call ended" bubble, so a 3-way call left
//       three of them in the thread.
//   Now a call is a room: `calls` row + `call_participants`. Anyone in the chat
//   can join while it is live, everyone meshes with everyone, and the server
//   closes the room and writes exactly one bubble.
//
// The ceiling is real and stays honest: mesh means each participant uploads
// their own media once per other participant, so 4 video / 6 audio is where
// this stops being usable. An SFU (LiveKit, mediasoup) is the only fix and
// this repo does not ship one, so join_call() refuses past the cap instead of
// letting the call rot.

export const CAPACITY = { audio: 6, video: 4 };
export const RING_TIMEOUT_MS = 45_000;
export const HEARTBEAT_MS = 25_000;      // server sweeps at 75s of silence
export const STALE_AFTER_MS = 75_000;

export const capacityFor = kind => CAPACITY[kind === 'video' ? 'video' : 'audio'];

/* ── who offers, who yields ────────────────────────────────────────────────
   Perfect negotiation needs one polite side per pair, decided identically on
   both ends with no round trip: compare the two user ids. On top of that, the
   person who just walked in is the one who should offer — the people already
   talking have a working session and no reason to renegotiate it. Both facts
   are derivable on both sides, which is what makes them safe to rely on. */
export const isPolite = (meId, otherId) => String(meId) < String(otherId);

export function peerRole(meId, otherId, { myJoinedAt = 0, theirJoinedAt = 0 } = {}) {
  const mine = new Date(myJoinedAt).getTime() || 0;
  const theirs = new Date(theirJoinedAt).getTime() || 0;
  const initiator = mine === theirs ? String(meId) > String(otherId) : mine > theirs;
  return { polite: isPolite(meId, otherId), initiator };
}

/* ── roster ────────────────────────────────────────────────────────────────
   Realtime hands us one row at a time, out of order, sometimes twice. This is
   the reducer: last write wins per user, and "left" is a timestamp, not a
   delete, so a rejoin is just another upsert. */
export function rosterReduce(roster, event) {
  const next = new Map(roster);
  const row = event?.row;
  if (!row?.user_id) return next;
  if (event.type === 'remove') { next.delete(row.user_id); return next; }
  const prev = next.get(row.user_id) || {};
  next.set(row.user_id, { ...prev, ...row });
  return next;
}

export const liveIds = (roster, meId = null) =>
  [...roster.values()].filter(p => !p.left_at && p.user_id !== meId).map(p => p.user_id);

export const liveCount = roster => [...roster.values()].filter(p => !p.left_at).length;

export function canJoin({ kind = 'audio', roster = new Map(), meId = null, ended = false, joinOpen = true } = {}) {
  if (ended) return { ok: false, reason: 'That call already ended.' };
  if (!joinOpen) return { ok: false, reason: 'That call is closed to new people.' };
  const already = [...roster.values()].some(p => p.user_id === meId && !p.left_at);
  if (already) return { ok: true, reason: '', already: true };
  const cap = capacityFor(kind);
  if (liveCount(roster) >= cap) {
    return { ok: false, reason: `This ${kind} call is full at ${cap}. Wisp meshes peer to peer and does not ship an SFU, so past ${cap} it would break rather than degrade.` };
  }
  return { ok: true, reason: '', already: false };
}

/* ── grid ──────────────────────────────────────────────────────────────────
   Tiles are square-ish and the grid stays balanced: 1 -> 1x1, 2 -> 1x2,
   3/4 -> 2x2, 5/6 -> 2x3. Returned as plain numbers so CSS custom properties
   can do the work and this can be asserted in a test. */
export function gridLayout(tiles) {
  const n = Math.max(1, Number(tiles) || 1);
  if (n === 1) return { cols: 1, rows: 1, tiles: n };
  if (n === 2) return { cols: 2, rows: 1, tiles: n };
  if (n <= 4) return { cols: 2, rows: 2, tiles: n };
  if (n <= 6) return { cols: 3, rows: 2, tiles: n };
  if (n <= 9) return { cols: 3, rows: 3, tiles: n };
  return { cols: 4, rows: Math.ceil(n / 4), tiles: n };
}

/* ── who is talking ───────────────────────────────────────────────────────
   Straight thresholding makes the ring around a tile strobe on every syllable.
   Rise fast (120ms) so it feels instant, fall slow (700ms) so a breath between
   words does not switch it off. */
export const SPEAK_ON = 0.045, SPEAK_OFF = 0.02;
export function speakingNext(prev, level, now) {
  const p = prev || { on: false, since: 0 };
  if (level >= SPEAK_ON) {
    if (p.on) return { on: true, since: p.since };
    if (!p.since || p.pending !== 'on') return { on: false, since: now, pending: 'on' };
    return now - p.since >= 120 ? { on: true, since: now } : { ...p };
  }
  if (level <= SPEAK_OFF) {
    if (!p.on) return { on: false, since: p.since, pending: null };
    if (p.pending !== 'off') return { on: true, since: now, pending: 'off' };
    return now - p.since >= 700 ? { on: false, since: now } : { ...p };
  }
  return { ...p };
}

/* ── adaptive bitrate ─────────────────────────────────────────────────────
   Lifted out of the old inline loop so the ladder can be tested instead of
   observed. A shared screen is capped but never scaled: a downscaled screen
   share is unreadable, which defeats sharing it. */
export const BITRATE_STEPS = [2500e3, 1200e3, 600e3, 300e3, 120e3];
export function qualityStep(level, { lossRate = 0, available = null, sharing = false } = {}) {
  const l = Math.min(BITRATE_STEPS.length - 1, Math.max(0, Number(level) || 0));
  const bad = lossRate > 0.04 || (available != null && available < BITRATE_STEPS[l] * 0.6);
  const good = lossRate < 0.01 && (available == null || available > BITRATE_STEPS[Math.max(0, l - 1)] * 1.2);
  let next = l;
  if (bad && l < BITRATE_STEPS.length - 1) next = l + 1;
  else if (good && l > 0) next = l - 1;
  return {
    level: next,
    maxBitrate: sharing ? Math.max(BITRATE_STEPS[next], 800e3) : BITRATE_STEPS[next],
    scaleResolutionDownBy: sharing ? 1 : 1 + next,
    label: ['excellent', 'good', 'fair', 'poor', 'minimal'][next],
  };
}

/* ── signal hygiene ───────────────────────────────────────────────────────
   call_signals is insertable by any member of the chat, which is right — a
   late joiner has to be able to signal before it is in the roster. It also
   means a member who is not in the call can post an "offer" at a call in
   progress. Left unchecked, setRemoteDescription() on that offer renegotiates
   a live call with a stranger's SDP: at best a broken call, at worst media
   sent somewhere nobody agreed to. So: only payloads of a known shape, only
   from someone the roster (or a pending join) actually accounts for, only
   addressed to us or to everyone, and nothing large enough to be an attack in
   its own right. */
export const SIGNAL_TYPES = ['offer', 'answer', 'ice', 'ready', 'bye', 'state'];
export const MAX_SIGNAL_BYTES = 64 * 1024;

export function validSignal(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!SIGNAL_TYPES.includes(payload.type)) return false;
  let size = 0;
  try { size = JSON.stringify(payload).length; } catch { return false; }
  if (size > MAX_SIGNAL_BYTES) return false;
  if (payload.type === 'offer' || payload.type === 'answer') {
    const sdp = payload.sdp;
    if (!sdp || typeof sdp !== 'object') return false;
    if (sdp.type !== payload.type) return false;
    if (typeof sdp.sdp !== 'string' || !sdp.sdp.startsWith('v=')) return false;
  }
  if (payload.type === 'ice') {
    const c = payload.candidate;
    if (!c || typeof c !== 'object') return false;
    if (typeof c.candidate !== 'string') return false;
  }
  return true;
}

export function signalAccepted(signal, { meId, roster = new Map(), chatMemberIds = new Set(), inCall = true } = {}) {
  if (!inCall) return { ok: false, reason: 'not in a call' };
  if (!signal || signal.sender_id === meId) return { ok: false, reason: 'own signal' };
  if (signal.target_id && signal.target_id !== meId) return { ok: false, reason: 'addressed elsewhere' };
  if (!validSignal(signal.payload)) return { ok: false, reason: 'malformed payload' };
  const known = chatMemberIds.has ? chatMemberIds.has(signal.sender_id) : false;
  if (!known) return { ok: false, reason: 'sender is not in this chat' };
  const inRoster = roster.has(signal.sender_id) && !roster.get(signal.sender_id).left_at;
  // An offer from someone not in the roster yet is the normal late-join race:
  // their participant row and their offer arrive in either order. Anything
  // other than an offer from a non-participant is not.
  if (!inRoster && signal.payload.type !== 'offer') return { ok: false, reason: 'sender is not in this call' };
  return { ok: true, reason: '' };
}

/* ── copy ─────────────────────────────────────────────────────────────────
   Mirrors finalize_call()'s label so the client and the server describe the
   same call the same way (asserted in tests/callcore.test.js). */
export const durText = secs => {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function callSummary({ kind = 'audio', state = 'ended', duration = 0, participants = 2 } = {}) {
  const head = (kind === 'video' ? 'Video' : 'Voice') + (participants > 2 ? ' group' : '');
  return `${head} call \u00b7 ${state}${duration > 0 ? ' \u00b7 ' + durText(duration) : ''}`;
}

export function joinBannerText({ kind = 'audio', names = [], participants = 0, capacity = null, iAmIn = false } = {}) {
  const cap = capacity ?? capacityFor(kind);
  const word = kind === 'video' ? 'Video call' : 'Voice call';
  if (iAmIn) return `${word} in progress \u00b7 you are in it`;
  const who = names.filter(Boolean);
  const n = participants || who.length;
  if (!n) return `${word} starting`;
  const head = who.length === 1 ? who[0]
    : who.length === 2 ? `${who[0]} and ${who[1]}`
    : who.length > 2 ? `${who[0]}, ${who[1]} +${who.length - 2}`
    : `${n} people`;
  const full = n >= cap ? ' \u00b7 full' : '';
  return `${head} ${who.length === 1 ? 'is' : 'are'} on a ${kind === 'video' ? 'video' : 'voice'} call${full}`;
}

export const ringTimedOut = (startedAt, now = Date.now()) =>
  now - (new Date(startedAt).getTime() || 0) >= RING_TIMEOUT_MS;

export const isStale = (heartbeatAt, now = Date.now()) =>
  now - (new Date(heartbeatAt).getTime() || 0) > STALE_AFTER_MS;

/* A DM ring that is declined ends the call; a group ring that is declined only
   goes quiet for that person. Same rule the server applies in decline_call. */
export const declineEndsCall = (memberCount, answeredAt = null) =>
  Number(memberCount) <= 2 && !answeredAt;
