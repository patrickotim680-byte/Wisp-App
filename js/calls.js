// ── Calls: rooms, not rings ─────────────────────────────────────────────
// A call is a row in `calls` plus a row per person in `call_participants`.
// Anyone in the chat can join while it is live, everyone meshes with everyone,
// and the server closes the room and writes the single summary bubble.
//
// Three things were broken before, and all three were the same shape of bug —
// the code only ever modelled "the caller and the other end":
//   1. callee-to-callee never connected. In a group of three, B and C could
//      both hear A and never each other, because only the caller created peer
//      connections. Now every participant meshes with every other one, driven
//      off the roster instead of off "who called".
//   2. there was no way in. The 45s ring was the only door: miss it, decline
//      it, or be the fourth person to look at the chat, and there was nothing
//      to tap. Now a live call shows a Join banner in the chat, an entry in
//      the Calls tab, and it accepts a #call/<id> link.
//   3. every client wrote its own "call ended" message, so a three-way call
//      left three bubbles in the thread. finalize_call() writes exactly one.
//
// Negotiation is still standard perfect negotiation (every offer comes out of
// onnegotiationneeded), which is what makes mid-call renegotiation — a screen
// share starting, someone joining, a camera coming on — work at all. The
// polite/impolite split and "the newcomer offers" rule both come from
// callcore.js, so they are asserted in tests rather than assumed.
//
// The ceiling is honest: mesh, no SFU, so 6 audio / 4 video. join_call()
// refuses past that in Postgres, and the UI says why.
import { rpc, ins, sel, channel, drop } from './db.js';
import { S, person, nameOf, emit } from './state.js';
import { $, h, clear, toast, oops, dur, iconEl, initials, swapIcon, modal, closeModal,
         clock, dayLabel, avatarData, copyText, shareLink } from './util.js';
import { startRing, stopRing, notifyIncomingCall } from './notify.js';
import {
  capacityFor, peerRole, rosterReduce, liveIds, liveCount, gridLayout, speakingNext,
  qualityStep, signalAccepted, joinBannerText, HEARTBEAT_MS, RING_TIMEOUT_MS,
} from './callcore.js';

let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
export function setIceServers(list) { if (list?.length) ice = list; }

const peers = new Map();      // user_id -> peer record
let roster = new Map();       // user_id -> call_participants row (+ profile bits)
let call = null;              // { id, chat_id, kind, role, hostId, capacity, answered, joinedAt, memberIds }
let local = null;
let screenTrack = null;
let shareStream = null;
let statsTimer = null, beatTimer = null, ringTimer = null, levelTimer = null, revealTimer = null;
let quality = 0;
let onSpeaker = true;
let audioCtx = null;

const GLYPH = 26;

const ui = {
  root: () => $('#call'), stage: () => $('.call-stage'), grid: () => $('#call-grid'),
  remote: () => $('#call-remote'), self: () => $('#call-local'),
  who: () => $('#call-who'), state: () => $('#call-state'), timer: () => $('#call-timer'),
  q: () => $('#call-quality'), avatar: () => $('#call-avatar'), bg: () => $('#call-audio-bg'),
  count: () => $('#call-count'), banner: () => $('#call-banner'),
};

export const currentCallId = () => call?.id || null;
export const inCall = () => !!call;

/* ── small helpers ─────────────────────────────────────────────────── */
const avatarFallback = name => {
  const svg = mark => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#8a8578"/><text x="48" y="58" font-family="sans-serif" font-size="34" fill="#f4f1ea" text-anchor="middle">${mark}</text></svg>`;
  try { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg(initials(name))); }
  catch { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg('?')); }
};

function setPeerVisual(name, url) {
  const src = url || avatarFallback(name);
  ui.avatar().src = src;
  ui.bg().style.backgroundImage = `url("${src}")`;
}

function resetControls() {
  onSpeaker = true;
  for (const [id, glyph] of [['#call-mute', 'mic-fill'], ['#call-cam', 'video-fill'],
                             ['#call-share', 'screen-fill'], ['#call-speaker', 'speaker-fill']]) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.remove('off', 'is-live');
    swapIcon(btn, glyph, GLYPH);
  }
  const share = $('#call-share');
  if (share) share.title = 'Share screen';
}

function show(on) {
  const root = ui.root();
  root.hidden = !on;
  root.classList.toggle('video', call?.kind === 'video');
  root.classList.toggle('audio', call?.kind === 'audio');
  const ringing = call?.role === 'callee' && !call?.answered;
  $('#call-accept').style.display = ringing ? 'grid' : 'none';
  const decline = $('#call-decline');
  if (decline) decline.style.display = ringing ? 'grid' : 'none';
  $('#call-hang').style.display = ringing ? 'none' : 'grid';
}

const chatOf = chatId => S.chats.find(c => c.chat_id === chatId) || null;
const displayName = uid => roster.get(uid)?.display_name || person(uid)?.display_name || nameOf(uid);

/* ── tiles ─────────────────────────────────────────────────────────────
   One tile per remote participant. The very first remote tile adopts the
   existing #call-remote <video> so the 1:1 call keeps the exact element (and
   therefore the exact styling and the setSinkId speaker plumbing) it had
   before this file changed; everyone after that gets a fresh <video>. */
function tileFor(uid) {
  const grid = ui.grid();
  let tile = grid.querySelector(`[data-uid="${uid}"]`);
  if (tile) return tile;

  const legacy = ui.remote();
  const takeLegacy = legacy && !legacy.dataset.claimed;
  const video = takeLegacy ? legacy : h('video', { autoplay: true, playsinline: true });
  if (takeLegacy) legacy.dataset.claimed = uid;
  video.autoplay = true; video.playsInline = true;

  tile = h('div', { class: 'call-tile', dataset: { uid } },
    h('img', { class: 'call-tile-face', src: person(uid)?.photo_url || avatarData(displayName(uid)), alt: '' }),
    h('div', { class: 'call-tile-foot' },
      h('span', { class: 'call-tile-name' }, displayName(uid)),
      h('span', { class: 'call-tile-mute', hidden: true }, iconEl('mic-off-fill', 14))));
  tile.prepend(video);
  grid.append(tile);
  return tile;
}

function dropTile(uid) {
  const grid = ui.grid();
  const tile = grid?.querySelector(`[data-uid="${uid}"]`);
  if (!tile) return;
  const legacy = ui.remote();
  if (legacy && legacy.dataset.claimed === uid) {
    // hand the shared element back instead of deleting it with the tile
    delete legacy.dataset.claimed;
    legacy.srcObject = null;
    ui.stage().append(legacy);
  }
  tile.remove();
}

function paintGrid() {
  const ids = liveIds(roster, S.me.id);
  const grid = ui.grid();
  if (!grid) return;
  ids.forEach(uid => tileFor(uid));
  [...grid.querySelectorAll('.call-tile')].forEach(t => {
    if (!ids.includes(t.dataset.uid)) dropTile(t.dataset.uid);
  });
  const g = gridLayout(Math.max(1, ids.length));
  grid.style.setProperty('--cols', String(g.cols));
  grid.style.setProperty('--rows', String(g.rows));
  ui.root().classList.toggle('solo', ids.length <= 1);
  ui.root().classList.toggle('group', ids.length > 1);

  ids.forEach(uid => {
    const tile = grid.querySelector(`[data-uid="${uid}"]`);
    if (!tile) return;
    const p = roster.get(uid) || {};
    tile.querySelector('.call-tile-name').textContent = displayName(uid) + (p.sharing ? ' \u00b7 sharing' : '');
    tile.querySelector('.call-tile-mute').hidden = !p.muted;
    tile.classList.toggle('is-muted', !!p.muted);
  });

  const n = liveCount(roster);
  if (ui.count()) {
    ui.count().hidden = n < 2;
    ui.count().textContent = `${n}`;
    ui.count().title = [...roster.values()].filter(r => !r.left_at).map(r => displayName(r.user_id)).join(', ');
  }
  const who = ui.who();
  if (who && call) {
    const chat = chatOf(call.chat_id);
    who.textContent = n > 2
      ? `${chat?.name || 'Group'} \u00b7 ${n} people`
      : (chat?.name || displayName(ids[0]) || 'Call');
  }
}

/* ── local media ──────────────────────────────────────────────────── */
async function getLocal(kind) {
  if (local) return local;
  local = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: kind === 'video' ? { width: { ideal: 1280 }, facingMode: 'user' } : false,
  });
  ui.self().srcObject = local;
  ui.self().hidden = kind !== 'video';
  return local;
}

/* ── peers ──────────────────────────────────────────────────────── */
function newPeer(otherId) {
  if (peers.has(otherId)) return peers.get(otherId);
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  const role = peerRole(S.me.id, otherId, {
    myJoinedAt: call?.joinedAt || 0,
    theirJoinedAt: roster.get(otherId)?.joined_at || 0,
  });
  const p = {
    pc, polite: role.polite, initiator: role.initiator, makingOffer: false,
    ignoreOffer: false, ice: [], camTrack: null, shareSender: null, speak: null, analyser: null,
  };
  peers.set(otherId, p);

  local?.getTracks().forEach(t => pc.addTrack(t, local));
  pc.onicecandidate = e => e.candidate && signal({ type: 'ice', candidate: e.candidate.toJSON?.() || e.candidate }, otherId);

  pc.ontrack = e => {
    const tile = tileFor(otherId);
    const video = tile.querySelector('video');
    const stream = e.streams[0];
    if (video && stream && video.srcObject !== stream) video.srcObject = stream;
    if (stream) watchLevel(otherId, stream);
    if (e.track.kind === 'video') {
      tile.classList.add('has-video');
      ui.root().classList.add('remote-video');
      e.track.addEventListener('ended', () => {
        tile.classList.remove('has-video');
        if (!anyRemoteVideo()) ui.root().classList.remove('remote-video');
      });
      e.track.addEventListener('mute', () => tile.classList.add('is-cam-off'));
      e.track.addEventListener('unmute', () => tile.classList.remove('is-cam-off'));
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      // The incumbent waits a beat: the newcomer's offer is the one that should
      // land, and glare costs a full round trip even when it is resolved.
      if (!p.initiator) await new Promise(r => setTimeout(r, 150));
      if (!peers.has(otherId)) return;
      p.makingOffer = true;
      await pc.setLocalDescription();
      signal({ type: 'offer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, otherId);
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      p.makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      ui.state().textContent = liveCount(roster) > 2 ? 'In the call' : 'Connected';
      startTimer();
      ui.root().classList.add('connected');
      stopRing();
    }
    // One peer failing is one peer, not the call. Only the last one going down
    // ends things — that is the difference between a group call and a 1:1.
    if (['failed', 'closed'].includes(pc.connectionState)) {
      dropPeer(otherId);
      if (!peers.size && liveCount(roster) <= 1) leaveCall('failed');
    }
  };
  return p;
}

function dropPeer(uid) {
  const p = peers.get(uid);
  if (!p) return;
  try { p.pc.close(); } catch {}
  try { p.analyser?.disconnect?.(); } catch {}
  peers.delete(uid);
  dropTile(uid);
  paintGrid();
}

const anyRemoteVideo = () => [...peers.values()].some(p =>
  p.pc.getReceivers().some(r => r.track?.kind === 'video' && r.track.readyState === 'live'));

function syncPeers() {
  const ids = liveIds(roster, S.me.id);
  ids.forEach(uid => { if (!peers.has(uid)) newPeer(uid); });
  [...peers.keys()].forEach(uid => { if (!ids.includes(uid)) dropPeer(uid); });
  paintGrid();
}

/* ── signalling ──────────────────────────────────────────────────── */
const signal = (payload, target = null) => {
  if (!call) return Promise.resolve();
  return ins('call_signals', { call_id: call.id, sender_id: S.me.id, target_id: target, payload })
    .catch(() => {});
};

async function onSignal(from, p) {
  const peer = peers.get(from) || (p.type === 'offer' ? newPeer(from) : null);
  if (!peer) return;
  const pc = peer.pc;

  if (p.type === 'offer' || p.type === 'answer') {
    const collision = p.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(p.sdp);
    for (const c of peer.ice.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (e) { console.warn('late ice', e); }
    }
    if (p.type === 'offer') {
      await pc.setLocalDescription();
      signal({ type: 'answer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, from);
    } else {
      call.answered = true; stopRing();
    }
    return;
  }

  if (p.type === 'ice') {
    if (!pc.remoteDescription) { peer.ice.push(p.candidate); return; }
    try { await pc.addIceCandidate(p.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn('ice', e); }
  }
}

function listenCall(callId) {
  channel('call', ch => ch
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'call_signals', filter: `call_id=eq.${callId}` },
      async ({ new: s }) => {
        if (!call || call.id !== callId) return;
        // Any member of the chat can insert into call_signals — that is what
        // lets a late joiner signal before its participant row lands. It also
        // means a member who is not in the call can post an "offer" at a live
        // one, so nothing reaches a peer connection without passing this.
        const verdict = signalAccepted(s, {
          meId: S.me.id, roster, chatMemberIds: call.memberIds, inCall: !!call,
        });
        if (!verdict.ok) {
          if (!['own signal', 'addressed elsewhere'].includes(verdict.reason)) {
            console.warn('dropped call signal:', verdict.reason);
          }
          return;
        }
        const p = s.payload;
        try {
          if (p.type === 'bye') return void dropPeer(s.sender_id);
          if (p.type === 'ready' || p.type === 'state') return;
          if (!local) { (call.queued = call.queued || []).push({ from: s.sender_id, payload: p }); return; }
          await onSignal(s.sender_id, p);
        } catch (e) { console.warn('signal', e); }
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'call_participants', filter: `call_id=eq.${callId}` },
      ({ new: row, old, eventType }) => {
        if (!call || call.id !== callId) return;
        const r = row?.user_id ? row : old;
        if (!r?.user_id) return;
        roster = rosterReduce(roster, {
          type: eventType === 'DELETE' ? 'remove' : 'upsert',
          row: eventType === 'DELETE' ? r : row,
        });
        if (row?.user_id && row.user_id !== S.me.id && !row.left_at && !peers.has(row.user_id)) {
          toast(`${displayName(row.user_id)} joined the call`);
        }
        if (local) syncPeers(); else paintGrid();
      })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` },
      ({ new: row }) => {
        if (!call || call.id !== callId) return;
        if (row.ended_at) { toast('Call ended.'); teardown(); return; }
        if (row.state === 'accepted') call.answered = true;
      }));
}

async function refreshRoster(callId) {
  try {
    const rows = await rpc('call_roster', { p_call: callId });
    roster = new Map();
    (rows || []).forEach(r => { roster = rosterReduce(roster, { type: 'upsert', row: r }); });
    const me = roster.get(S.me.id);
    if (me?.joined_at) call.joinedAt = new Date(me.joined_at).getTime();
  } catch (e) { console.warn('roster', e); }
}

/* ── starting, ringing, joining ────────────────────────────────────── */
export async function startCall(kind = 'audio') {
  const chat = S.chat;
  if (!chat) return;
  if (call) return toast('You are already in a call.', true);
  if (chat.type === 'broadcast') return toast('Broadcast lists cannot be called.', true);
  try {
    const res = await rpc('start_call', { p_chat: chat.chat_id, p_kind: kind });
    await enter(res, { role: res.reused ? 'joiner' : 'caller', kind: res.kind || kind, chatId: chat.chat_id });
    if (!res.reused) {
      ui.state().textContent = 'Ringing\u2026';
      startRing(3500);
      clearTimeout(ringTimer);
      ringTimer = setTimeout(() => {
        if (call && liveCount(roster) <= 1) {
          toast('Nobody picked up.');
          leaveCall('missed');
        }
      }, RING_TIMEOUT_MS);
    } else {
      toast('Joined the call already in progress.');
    }
  } catch (e) {
    if (/call_full/.test(e?.message || '')) toast(e.message.replace(/^.*call_full:\s*/, ''), true);
    else if (/nobody to call/.test(e?.message || '')) toast('Nobody to call.', true);
    else oops(e);
    await teardown();
  }
}

/* Someone else started one. In a DM this rings and offers accept/decline; in a
   group it rings too, but declining only silences your own ring — the room
   stays open and the Join banner takes over. */
export async function incoming(row) {
  if (call) return;
  if (!row?.id || row.caller_id === S.me.id) return;
  if (row.ended_at) return;
  const chat = chatOf(row.chat_id);
  const who = chat?.name || nameOf(row.caller_id);
  call = {
    id: row.id, chat_id: row.chat_id, kind: row.kind, role: 'callee', hostId: row.host_id || row.caller_id,
    capacity: capacityFor(row.kind), answered: false, queued: [], joinedAt: 0, memberIds: new Set(),
  };
  call.memberIds = await memberIdsOf(row.chat_id);
  await refreshRoster(row.id);
  ui.who().textContent = who;
  ui.state().textContent = `Incoming ${row.kind} call`;
  setPeerVisual(who, chat?.icon_url);
  resetControls();
  show(true);
  paintGrid();
  startRing(2500);
  notifyIncomingCall(who, row.kind, row.chat_id);
  listenCall(row.id);
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    if (call?.id === row.id && !call.answered) { stopRing(); teardown(); refreshLiveCalls(); }
  }, RING_TIMEOUT_MS);
}

async function memberIdsOf(chatId) {
  try {
    const rows = await sel('chat_members', { select: 'user_id', eq: { chat_id: chatId } });
    return new Set((rows || []).map(r => r.user_id));
  } catch { return new Set(); }
}

/* Shared by start, accept and join: media, overlay, subscriptions, mesh. */
async function enter(res, { role, kind, chatId }) {
  call = {
    id: res.call_id, chat_id: res.chat_id || chatId, kind: res.kind || kind, role,
    hostId: res.host_id, capacity: res.capacity || capacityFor(kind), answered: role !== 'caller',
    queued: [], joinedAt: Date.now(), memberIds: new Set(),
  };
  const chat = chatOf(call.chat_id);
  ui.who().textContent = chat?.name || 'Call';
  ui.state().textContent = role === 'caller' ? 'Ringing\u2026' : 'Connecting\u2026';
  setPeerVisual(chat?.name, chat?.icon_url);
  resetControls();
  show(true);

  call.memberIds = await memberIdsOf(call.chat_id);
  await getLocal(call.kind);
  await refreshRoster(call.id);
  listenCall(call.id);
  syncPeers();
  watchQuality();
  startHeartbeat();
  refreshLiveCalls();

  const queued = call.queued || [];
  call.queued = [];
  for (const q of queued) await onSignal(q.from, q.payload).catch(e => console.warn('replay', e));
}

export async function acceptCall() {
  if (!call || call.answered) return;
  stopRing();
  clearTimeout(ringTimer);
  const id = call.id, kind = call.kind, chatId = call.chat_id, queued = call.queued || [];
  try {
    const res = await rpc('join_call', { p_call: id });
    call.answered = true;
    await enter({ ...res, call_id: id }, { role: 'callee', kind, chatId });
    call.queued = queued;
    const q = call.queued.splice(0);
    for (const s of q) await onSignal(s.from, s.payload).catch(e => console.warn('replay', e));
    show(true);
  } catch (e) {
    if (/call_ended/.test(e?.message || '')) toast('That call already ended.', true);
    else if (/call_full/.test(e?.message || '')) toast(e.message.replace(/^.*call_full:\s*/, ''), true);
    else oops(e);
    await teardown();
  }
}

/* The public door: the Join banner, the Calls tab and #call/<id> all land here. */
export async function joinCall(callId, { kind = 'audio' } = {}) {
  if (call?.id === callId) return;
  if (call) return toast('Leave the call you are in first.', true);
  try {
    const res = await rpc('join_call', { p_call: callId });
    await enter(res, { role: 'joiner', kind: res.kind || kind, chatId: res.chat_id });
    toast('You are in.');
  } catch (e) {
    if (/call_ended/.test(e?.message || '')) toast('That call has already ended.', true);
    else if (/call_full/.test(e?.message || '')) toast(e.message.replace(/^.*call_full:\s*/, ''), true);
    else if (/not a member/.test(e?.message || '')) toast('That call is in a chat you are not in.', true);
    else oops(e);
    await teardown();
    refreshLiveCalls();
  }
}

export async function declineCall() {
  if (!call) return;
  const id = call.id;
  stopRing();
  try { await rpc('decline_call', { p_call: id }); } catch (e) { console.warn('decline', e); }
  await teardown();
  refreshLiveCalls();
}

/* ── timers ─────────────────────────────────────────────────────── */
function startTimer() {
  if (!call || call.t0) return;
  call.t0 = Date.now();
  call.timer = setInterval(() => { ui.timer().textContent = dur((Date.now() - call.t0) / 1000); }, 500);
}

function startHeartbeat() {
  clearInterval(beatTimer);
  const beat = () => {
    if (!call) return;
    rpc('call_heartbeat', {
      p_call: call.id,
      p_muted: !(local?.getAudioTracks()[0]?.enabled ?? true),
      p_cam_on: !!(local?.getVideoTracks()[0]?.enabled),
      p_sharing: !!screenTrack,
    }).catch(() => {});
  };
  beat();
  beatTimer = setInterval(beat, HEARTBEAT_MS);
}

/* Speaking rings. One analyser per remote stream, sampled five times a second;
   the on/off decision (and its hysteresis) lives in callcore.speakingNext. */
function watchLevel(uid, stream) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const p = peers.get(uid);
    if (!p || p.analyser) return;
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    p.analyser = an;
    p.buf = new Uint8Array(an.frequencyBinCount);
    if (!levelTimer) levelTimer = setInterval(sampleLevels, 200);
  } catch (e) { console.warn('level', e); }
}

function sampleLevels() {
  if (!call) return;
  const now = Date.now();
  peers.forEach((p, uid) => {
    if (!p.analyser || !p.buf) return;
    p.analyser.getByteTimeDomainData(p.buf);
    let sum = 0;
    for (let i = 0; i < p.buf.length; i++) { const v = (p.buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / p.buf.length);
    const next = speakingNext(p.speak, rms, now);
    const changed = (p.speak?.on || false) !== next.on;
    p.speak = next;
    if (changed) {
      const tile = ui.grid()?.querySelector(`[data-uid="${uid}"]`);
      tile?.classList.toggle('is-speaking', next.on);
    }
  });
}

function watchQuality() {
  clearInterval(statsTimer);
  let lastLost = 0, lastTotal = 0;
  statsTimer = setInterval(async () => {
    if (!call) return;
    let lost = 0, total = 0, avail = null;
    for (const { pc } of peers.values()) {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'remote-inbound-rtp') lost += r.packetsLost || 0;
        if (r.type === 'outbound-rtp') total += r.packetsSent || 0;
        if (r.type === 'candidate-pair' && r.state === 'succeeded') {
          avail = Math.max(avail ?? 0, r.availableOutgoingBitrate || 0) || avail;
        }
      });
    }
    const dLost = lost - lastLost, dTotal = Math.max(1, total - lastTotal);
    lastLost = lost; lastTotal = total;
    const step = qualityStep(quality, { lossRate: dLost / dTotal, available: avail, sharing: !!screenTrack });
    quality = step.level;
    // Mesh: the upstream is shared between every peer, so the ladder is applied
    // per sender and the cap divided by however many people are listening.
    const share = Math.max(1, peers.size);
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (!sender) continue;
      const prm = sender.getParameters();
      prm.encodings = prm.encodings?.length ? prm.encodings : [{}];
      prm.encodings[0].maxBitrate = Math.max(80e3, Math.round(step.maxBitrate / share));
      prm.encodings[0].scaleResolutionDownBy = step.scaleResolutionDownBy;
      try { await sender.setParameters(prm); } catch {}
    }
    ui.q().textContent = step.label + (avail ? ` \u00b7 ${Math.round(avail / 1000)} kbps` : '');
  }, 3000);
}

/* ── leaving ───────────────────────────────────────────────────── */
export async function leaveCall(reason = 'ended') {
  if (!call) return show(false);
  const id = call.id;
  try { await signal({ type: 'bye' }); } catch {}
  try {
    if (reason === 'missed' || reason === 'ended' || reason === 'failed') await rpc('leave_call', { p_call: id });
  } catch (e) { console.warn('leave', e); }
  await teardown();
  refreshLiveCalls();
}

/* Host (or a chat admin) closing the room for everyone. */
export async function endCallForAll() {
  if (!call) return;
  try { await rpc('end_call_for_all', { p_call: call.id }); } catch (e) { oops(e); }
  await teardown();
  refreshLiveCalls();
}

/* Kept as the name every other module already calls. */
export async function hangup(reason = 'ended') { return leaveCall(reason); }

async function teardown() {
  clearInterval(call?.timer); clearInterval(statsTimer); clearInterval(beatTimer);
  clearInterval(levelTimer); clearTimeout(ringTimer);
  statsTimer = beatTimer = levelTimer = ringTimer = null;
  stopRing();
  peers.forEach(({ pc }) => { try { pc.close(); } catch {} });
  [...peers.keys()].forEach(dropTile);
  peers.clear();
  roster = new Map();
  quality = 0;
  local?.getTracks().forEach(t => t.stop());
  shareStream?.getTracks().forEach(t => { try { t.stop(); } catch {} });
  try { screenTrack?.stop(); } catch {}
  local = null; screenTrack = null; shareStream = null;
  call = null;
  drop('call');
  ui.root().classList.add('hanging-up');
  await new Promise(r => setTimeout(r, 650));
  ui.root().classList.remove('hanging-up');
  show(false);
  ui.root().classList.remove('connected', 'show-meta', 'sharing', 'remote-video', 'solo', 'group');
  ui.timer().textContent = ''; ui.q().textContent = '';
  if (ui.remote()) { ui.remote().srcObject = null; delete ui.remote().dataset.claimed; }
  ui.self().srcObject = null;
  ui.avatar().src = ''; ui.bg().style.backgroundImage = '';
  clear(ui.grid());
  if (ui.remote()) ui.stage().append(ui.remote());
  if (ui.count()) ui.count().hidden = true;
  resetControls();
}

/* ── screen share ───────────────────────────────────────────────── */
function markShare(on) {
  const btn = $('#call-share');
  if (!btn) return;
  btn.classList.toggle('is-live', on);
  btn.title = on ? 'Stop sharing' : 'Share screen';
  swapIcon(btn, on ? 'screen-off-fill' : 'screen-fill', GLYPH);
}

async function startShare() {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia) {
    return toast('This browser cannot capture a screen. Mobile Safari and Chrome on Android do not offer it to web apps at all \u2014 share from a laptop instead.', true);
  }
  let stream;
  try {
    stream = await md.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') oops(e);
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) { stream.getTracks().forEach(t => t.stop()); return toast('That capture had no video in it.', true); }
  screenTrack = track;
  shareStream = stream;
  for (const p of peers.values()) {
    const sender = p.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) {
      p.camTrack = sender.track;
      try { await sender.replaceTrack(track); } catch (e) { console.warn('replace', e); }
    } else {
      p.shareSender = p.pc.addTrack(track, stream);
    }
  }
  track.addEventListener('ended', () => { stopShare().catch(e => console.warn(e)); });
  ui.self().srcObject = stream;
  ui.self().hidden = false;
  ui.root().classList.add('sharing');
  markShare(true);
  rpc('call_heartbeat', { p_call: call.id, p_sharing: true }).catch(() => {});
  toast('Sharing your screen with everyone in the call.');
}

async function stopShare() {
  const track = screenTrack;
  if (!track) return;
  screenTrack = null;
  for (const p of peers.values()) {
    if (p.shareSender) {
      try { p.pc.removeTrack(p.shareSender); } catch (e) { console.warn('removeTrack', e); }
      p.shareSender = null;
      continue;
    }
    const sender = p.pc.getSenders().find(s => s.track === track);
    if (sender) { try { await sender.replaceTrack(p.camTrack || null); } catch (e) { console.warn('restore', e); } }
    p.camTrack = null;
  }
  try { track.stop(); } catch {}
  shareStream?.getTracks().forEach(t => { try { t.stop(); } catch {} });
  shareStream = null;
  ui.self().srcObject = local;
  ui.self().hidden = call?.kind !== 'video';
  ui.root().classList.remove('sharing');
  markShare(false);
  if (call) rpc('call_heartbeat', { p_call: call.id, p_sharing: false }).catch(() => {});
}

async function toggleShare() {
  if (!call) return;
  try { screenTrack ? await stopShare() : await startShare(); } catch (e) { oops(e); }
}

/* Output routing. setSinkId is the web's only lever and only Chromium ships
   it; every remote element has to be moved, not just the first one. */
async function toggleSpeaker(btn) {
  const els = [...(ui.grid()?.querySelectorAll('video') || [])];
  const probe = els[0] || ui.remote();
  if (!probe || typeof probe.setSinkId !== 'function') {
    return toast('This browser leaves call audio to the phone \u2014 use the system output picker to move it.');
  }
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const next = onSpeaker
      ? outs.find(d => /receiver|earpiece|headset|headphone|bluetooth/i.test(d.label))
      : (outs.find(d => /speaker/i.test(d.label)) || outs.find(d => d.deviceId === 'default'));
    if (!next) return toast('No other audio output is available right now.');
    for (const el of els) { try { await el.setSinkId(next.deviceId); } catch {} }
    onSpeaker = !onSpeaker;
    btn.classList.toggle('off', !onSpeaker);
  } catch (e) { oops(e); }
}

/* ── the people sheet ────────────────────────────────────────────── */
export function openCallPeople() {
  if (!call) return;
  const rows = [...roster.values()].filter(r => !r.left_at);
  const iAmHost = call.hostId === S.me.id;
  modal(
    h('h3', { class: 'display' }, `In this call \u00b7 ${rows.length}/${call.capacity}`),
    h('div', { class: 'stack' }, rows.map(r => h('div', { class: 'member' },
      h('img', { class: 'av', src: person(r.user_id)?.photo_url || avatarData(displayName(r.user_id)), alt: '' }),
      h('span', {}, r.user_id === S.me.id ? 'You' : displayName(r.user_id)),
      r.sharing && h('small', { class: 'hint' }, 'sharing'),
      r.muted && iconEl('mic-off-fill', 14)))),
    h('p', { class: 'hint' }, `Mesh call: everyone sends to everyone, so this caps at ${call.capacity} for ${call.kind}. An SFU is the only way past that and Wisp does not ship one.`),
    h('div', { class: 'modal-actions' },
      h('button', {
        class: 'btn', onclick: () => {
          const link = `${location.origin}/#call/${call.id}`;
          shareLink(link, 'Join my Wisp call').catch(() => copyText(link));
        },
      }, iconEl('copy', 16), 'Copy join link'),
      iAmHost && h('button', { class: 'btn danger', onclick: () => { closeModal(); endCallForAll(); } }, 'End for everyone'),
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

/* ── live calls elsewhere in the app ─────────────────────────────────────
   One query, cached on S, and an event so the chat list, the thread banner and
   the Calls tab all draw from the same answer. */
export async function refreshLiveCalls() {
  try {
    S.liveCalls = await rpc('live_calls');
  } catch (e) { S.liveCalls = []; }
  emit('livecalls', S.liveCalls);
  paintThreadBanner();
  return S.liveCalls;
}

export const liveCallFor = chatId => (S.liveCalls || []).find(c => c.chat_id === chatId) || null;

export function paintThreadBanner() {
  const el = ui.banner();
  if (!el) return;
  const live = S.chat ? liveCallFor(S.chat.chat_id) : null;
  if (!live || call?.id === live.call_id) { el.hidden = true; clear(el); return; }
  clear(el);
  el.hidden = false;
  el.append(
    h('span', { class: 'join-ico' }, iconEl(live.kind === 'video' ? 'video' : 'call', 16)),
    h('span', { class: 'join-text' }, joinBannerText({
      kind: live.kind, names: live.names || [], participants: live.participants,
      capacity: live.capacity, iAmIn: live.i_am_in,
    })),
    h('button', {
      class: 'btn small primary',
      onclick: () => joinCall(live.call_id, { kind: live.kind }),
    }, live.participants >= live.capacity ? 'Full' : 'Join'));
}

/* ── mount ─────────────────────────────────────────────────────── */
export function mountCalls() {
  $('#btn-call-audio').onclick = () => startCall('audio');
  $('#btn-call-video').onclick = () => startCall('video');
  $('#call-hang').onclick = () => leaveCall('ended');
  $('#call-accept').onclick = acceptCall;
  const decline = $('#call-decline');
  if (decline) decline.onclick = declineCall;
  $('#call-share').onclick = toggleShare;
  $('#call-speaker').onclick = e => toggleSpeaker(e.currentTarget);
  if (ui.count()) ui.count().onclick = openCallPeople;

  $('#call-mute').onclick = e => {
    const t = local?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    swapIcon(e.currentTarget, t.enabled ? 'mic-fill' : 'mic-off-fill', GLYPH);
    if (call) rpc('call_heartbeat', { p_call: call.id, p_muted: !t.enabled }).catch(() => {});
  };
  $('#call-cam').onclick = e => {
    const t = local?.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    swapIcon(e.currentTarget, t.enabled ? 'video-fill' : 'video-off-fill', GLYPH);
    if (call) rpc('call_heartbeat', { p_call: call.id, p_cam_on: t.enabled }).catch(() => {});
  };

  ui.stage().addEventListener('click', () => {
    if (call?.kind !== 'video' || !ui.root().classList.contains('connected')) return;
    ui.root().classList.add('show-meta');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => ui.root().classList.remove('show-meta'), 3500);
  });

  channel('calls-in', ch => ch
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls' },
      async ({ new: row }) => { await refreshLiveCalls(); incoming(row); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' },
      () => refreshLiveCalls())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'call_participants' },
      () => refreshLiveCalls()));

  refreshLiveCalls();
  // A live room stops advertising itself after two minutes of silence, so this
  // keeps the banner honest without a subscription per call.
  setInterval(() => { if (!document.hidden) refreshLiveCalls(); }, 30_000);
  // A closing tab gets one best-effort leave in. If it does not make it out,
  // sweep_stale_calls() picks the room up 75 seconds later instead of leaving
  // a "call in progress" that nobody is in.
  addEventListener('pagehide', () => { if (call) leaveCall('ended'); });
}

export async function callHistory() {
  return sel('calls', { select: '*, chats(name, type)', order: ['started_at', 'desc'], limit: 80 });
}

/* ── call details sheet ───────────────────────────────────────────── */
const CALL_STATE_LABEL = { missed: 'Missed', declined: 'Declined', ended: 'Ended',
  accepted: 'In progress', ringing: 'Ringing', failed: 'Failed' };

export function openCallDetails({ name, kind, state, duration, startedAt, chatId, alreadyOpen, callId }) {
  const isVideo = kind === 'video';
  const label = CALL_STATE_LABEL[state] || state || '';
  const chatStillThere = !chatId || S.chats.some(c => c.chat_id === chatId);
  const live = chatId ? liveCallFor(chatId) : null;

  const withChatOpen = async fn => {
    closeModal();
    if (!chatStillThere) return toast('That chat is no longer available.', true);
    if (!alreadyOpen) await (await import('./chats.js')).openChat(chatId);
    fn();
  };

  modal(...[
    h('div', { class: 'call-detail-head' },
      h('div', { class: 'av lg' }, iconEl(isVideo ? 'video' : 'call', 22)),
      h('div', {},
        h('h3', { class: 'display' }, name || 'Call'),
        h('p', { class: 'muted' }, `${isVideo ? 'Video' : 'Voice'} call${label ? ' \u00b7 ' + label : ''}${duration ? ' \u00b7 ' + dur(duration) : ''}`))),
    startedAt && h('p', { class: 'hint' }, `${dayLabel(startedAt)} at ${clock(startedAt)}`),
    live && h('p', { class: 'hint' }, joinBannerText({
      kind: live.kind, names: live.names || [], participants: live.participants,
      capacity: live.capacity, iAmIn: live.i_am_in,
    })),
    h('div', { class: 'modal-actions call-detail-actions' },
      live && !live.i_am_in && h('button', {
        class: 'btn primary', onclick: () => { closeModal(); joinCall(live.call_id, { kind: live.kind }); },
      }, iconEl(live.kind === 'video' ? 'video' : 'call', 16), 'Join call'),
      !alreadyOpen && h('button', { class: 'btn icon-label', onclick: () => withChatOpen(() => {}) }, iconEl('chat', 16), 'Message'),
      !live && h('button', { class: 'btn icon-label', onclick: () => withChatOpen(() => startCall('audio')) }, iconEl('call', 16), 'Voice call'),
      !live && h('button', { class: 'btn icon-label', onclick: () => withChatOpen(() => startCall('video')) }, iconEl('video', 16), 'Video call'),
      h('button', {
        class: 'btn icon-label',
        onclick: () => withChatOpen(async () => (await import('./composer.js')).scheduleDialog()),
      }, iconEl('clock', 16), 'Schedule message'),
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')),
  ].filter(Boolean));
}
