// 1:1 and small-mesh WebRTC. Signaling rides on the call_signals table via
// Realtime, so there is no extra server to run. Beyond ~4 participants a mesh
// stops being viable: you need an SFU (LiveKit / mediasoup). Not built here,
// and the UI says so instead of pretending.
//
// Negotiation follows the standard "perfect negotiation" shape: every offer
// comes out of onnegotiationneeded rather than being hand-rolled at one call
// site. That is what makes screen sharing work at all — starting a share adds
// or replaces a video track mid-call, which needs a fresh offer/answer round.
//
// How a group call is wired (this is the part that used to be a star, not a mesh):
//   * The caller opens one peer connection per invitee and offers to each.
//   * Anyone who accepts broadcasts `ready`. Everyone already in the call
//     answers that by opening a connection to the newcomer, so two invitees end
//     up connected to EACH OTHER and not only to the caller. If both sides
//     happen to offer at once, polite/impolite resolves it.
//   * Every person gets their own tile (own <video>, own MediaStream). The old
//     single shared <video> meant each new peer's stream replaced the last
//     one's, so in a 3-way call you only ever heard one person.
//   * One person dropping, declining or losing signal removes THEIR tile only.
//     The call ends for you when nobody is left.
//   * A callee that accepts re-reads call_signals from the database, so an
//     offer sent before their subscription finished is not lost for good.
import { sb, rpc, ins, upd, sel, channel, drop } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, h, clear, toast, oops, dur, iconEl, initials, swapIcon, modal, closeModal, clock, dayLabel, avatarData } from './util.js';
import { playCallTone, startRing, stopRing, notifyIncomingCall } from './notify.js';

let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
export function setIceServers(list) { if (list?.length) ice = list; }

const MAX_REMOTE = 3;         // 3 others + you = 4 people. A mesh uploads once per person; past this phones melt.
const RING_MS = 45000;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

const peers = new Map();      // user_id -> { id, pc, polite, makingOffer, ignoreOffer, ice[], iceOut[], camTrack, shareSender, everConnected, retried, level, ... }
const tiles = new Map();      // user_id -> { el, inner, video, stream, status, label, img }
const earlyIce = new Map();   // user_id -> candidates that beat their peer connection into existence
const meters = new Map();     // 'me' | user_id -> { an, buf, on, hold }   (who is talking)
let call = null;              // { id, chat_id, kind, role, group, callerId, joined:Set, seen:Set, gate, queued[], timer, t0 }
let local = null;
let screenTrack = null;
let shareStream = null;
let statsTimer = null;
let speakTimer = null;
let actx = null;              // one AudioContext per call, only ever used for level metering
let revealTimer = null;       // FaceTime-style "tap to bring controls back" during video calls
let onSpeaker = true;         // only meaningful where setSinkId exists (see toggleSpeaker)
let sinkId = null;            // chosen output device, re-applied to tiles that appear later

/* The control-bar glyphs are the filled variants at 26px, and the mic and
   camera each have a slashed twin for their off state. Size lives here as
   well as in the markup because swapIcon() redraws the glyph from scratch. */
const GLYPH = 26;

const ui = {
  root: () => $('#call'), stage: () => $('.call-stage'), grid: () => $('#call-grid'), self: () => $('#call-local'),
  who: () => $('#call-who'), state: () => $('#call-state'), timer: () => $('#call-timer'), q: () => $('#call-quality'),
  avatar: () => $('#call-avatar'), bg: () => $('#call-audio-bg'),
};

// Small inline fallback so the voice-call avatar/backdrop always has
// something to show even when the chat has no photo set.
const avatarFallback = name => {
  const svg = mark => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#8a8578"/><text x="48" y="58" font-family="sans-serif" font-size="34" fill="#f4f1ea" text-anchor="middle">${mark}</text></svg>`;
  try {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg(initials(name)));
  } catch {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg('?'));
  }
};

function setPeerVisual(name, url) {
  const src = url || avatarFallback(name);
  ui.avatar().src = src;
  ui.bg().style.backgroundImage = `url("${src}")`;
}

/* Every call starts from the same visual state: live mic, live camera,
   not sharing, on speaker. Without this a call that ended muted would open
   the next one showing a slashed mic over a perfectly live microphone. */
function resetControls() {
  onSpeaker = true;
  sinkId = null;
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
  ui.root().hidden = !on;
  ui.root().classList.toggle('video', call?.kind === 'video');
  ui.root().classList.toggle('audio', call?.kind === 'audio');
  $('#call-accept').style.display = call?.role === 'callee' && !call?.answered ? 'grid' : 'none';
}

async function getLocal(kind) {
  // A mesh sends your video once per person. Three links at 720p would swamp a
  // phone uplink, so a group call asks the camera for less up front.
  const group = !!call?.group;
  local = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: kind === 'video'
      ? (group ? { width: { ideal: 640 }, frameRate: { ideal: 24 }, facingMode: 'user' } : { width: { ideal: 1280 }, facingMode: 'user' })
      : false,
  });
  ui.self().srcObject = local;
  ui.self().hidden = kind !== 'video';
  return local;
}

/* ── participant tiles ───────────────────────────────────────────────────
   One tile per remote person. The grid animates with FLIP: measure every tile,
   change the layout, then play each tile from where it WAS to where it IS. The
   tile's contents are counter-scaled so video never looks squashed mid-move. */
const reduceMotion = () => document.documentElement.dataset.motion === 'reduce';
const speedOf = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--speed')) || 1;
const ms = base => base / speedOf();

function layout() {
  ui.grid().dataset.n = String(tiles.size);
  [...tiles.values()].forEach((t, i) => { t.el.dataset.i = String(i); });   // CSS places the odd tile by position, not DOM order
  ui.root().classList.toggle('multi', tiles.size > 1);
}

function flip(change) {
  if (reduceMotion() || !tiles.size) return change();
  const before = new Map([...tiles.values()].map(t => [t, t.el.getBoundingClientRect()]));
  change();
  for (const t of tiles.values()) {
    const a = before.get(t);
    if (!a) continue;                           // brand-new tile: it has its own entrance
    const b = t.el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    const opts = { duration: ms(480), easing: EASE };
    t.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }], opts);
    t.inner.animate([{ transform: `scale(${1 / sx}, ${1 / sy})` }, { transform: 'none' }], opts);
  }
}

function addTile(uid) {
  if (tiles.has(uid)) return tiles.get(uid);
  const name = nameOf(uid);
  const video = h('video', { autoplay: true, playsinline: true });
  const stream = new MediaStream();            // fed track-by-track in ontrack
  video.srcObject = stream;
  if (sinkId && video.setSinkId) video.setSinkId(sinkId).catch(() => {});
  const img = h('img', { class: 'tile-av', alt: '', src: person(uid)?.photo_url || avatarData(name) });
  const label = h('span', { class: 'tile-name' }, name);
  const status = h('span', { class: 'tile-status' });
  const inner = h('div', { class: 'tile-in' }, video, h('div', { class: 'tile-ph' }, img), label, status);
  const el = h('div', { class: 'tile', 'data-uid': uid }, inner);
  const t = { el, inner, video, stream, status, label, img };
  flip(() => { tiles.set(uid, t); ui.grid().append(el); layout(); });
  if (!reduceMotion()) {
    inner.animate([{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: ms(520), easing: EASE });
  }
  // Names/photos of people you have not chatted with yet are not loaded; fetch
  // them and patch the tile instead of leaving it on "Unknown".
  if (!person(uid)) {
    import('./chats.js').then(m => m.loadPeople([uid])).then(() => {
      label.textContent = nameOf(uid);
      img.src = person(uid)?.photo_url || avatarData(nameOf(uid));
    }).catch(() => {});
  }
  return t;
}

function removeTile(uid) {
  const t = tiles.get(uid);
  if (!t) return;
  // Pin the departing tile where it is (out of the grid flow) so the others can
  // glide into the space while it fades, instead of the layout snapping.
  const r = t.el.getBoundingClientRect(), g = ui.grid().getBoundingClientRect();
  flip(() => {
    tiles.delete(uid);
    Object.assign(t.el.style, { position: 'absolute', margin: '0', pointerEvents: 'none', zIndex: '0',
      left: `${r.left - g.left}px`, top: `${r.top - g.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    layout();
  });
  meters.delete(uid);
  const done = () => { try { t.video.srcObject = null; } catch {} t.el.remove(); };
  if (reduceMotion()) return done();
  t.inner.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.92)' }],
    { duration: ms(260), easing: 'ease-in', fill: 'forwards' }).onfinish = done;
}

function setTileStatus(uid, text) {
  const t = tiles.get(uid);
  if (!t) return;
  t.status.textContent = text || '';
  t.el.classList.toggle('has-status', !!text);
}

function resetGrid() {
  ui.grid().replaceChildren();
  tiles.clear();
  ui.grid().dataset.n = '0';
  ui.root().classList.remove('multi');
}

const anyTileVideo = () => [...tiles.values()].some(t => t.el.classList.contains('has-video'));

/* ── who is talking ──────────────────────────────────────────────────────
   An AnalyserNode per stream, polled ~8x/second. It only measures: the node is
   never connected to the speakers, so there is no double playback. */
function meter(key, stream) {
  try {
    if (!stream.getAudioTracks().length) return;
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    const an = actx.createAnalyser();
    an.fftSize = 256;
    actx.createMediaStreamSource(stream).connect(an);
    meters.set(key, { an, buf: new Uint8Array(an.fftSize), on: false, hold: 0 });
  } catch (e) { console.warn('meter', e); }
}

function pollSpeakers() {
  const now = performance.now();
  for (const [key, m] of meters) {
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) { const d = (v - 128) / 128; sum += d * d; }
    if (Math.sqrt(sum / m.buf.length) > 0.035) m.hold = now + 350;   // hang on briefly so the ring doesn't flicker between words
    const on = now < m.hold;
    if (on === m.on) continue;
    m.on = on;
    (key === 'me' ? ui.self() : tiles.get(key)?.el)?.classList.toggle('speaking', on);
  }
}

function startMeters() {
  clearInterval(speakTimer);
  speakTimer = setInterval(pollSpeakers, 120);
}

function stopMeters() {
  clearInterval(speakTimer);
  meters.clear();
  try { actx?.close(); } catch {}
  actx = null;
  ui.self()?.classList.remove('speaking');
}

/* ── peers ──────────────────────────────────────────────────────────────── */
const anyRemoteVideo = () => [...peers.values()].some(p =>
  p.pc.getReceivers().some(r => r.track?.kind === 'video' && r.track.readyState === 'live'));

// Trickle ICE through a database table is chatty: every candidate is a row.
// A group call has several links gathering at once, so candidates are batched
// into one row per ~120 ms instead of one row each.
function queueIce(p, cand) {
  p.iceOut.push(typeof cand.toJSON === 'function' ? cand.toJSON() : cand);
  if (p.iceTimer) return;
  p.iceTimer = setTimeout(() => {
    p.iceTimer = null;
    const batch = p.iceOut.splice(0);
    if (batch.length && call) signal({ type: 'ice', candidates: batch }, p.id);
  }, 120);
}

async function attachShare(p) {
  try {
    const sender = p.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) {
      p.camTrack = sender.track;                // remember the camera to come back to
      await sender.replaceTrack(screenTrack);
    } else {
      // Voice call: there is no video transceiver yet. addTrack creates one and
      // fires onnegotiationneeded, which is the renegotiation that makes the
      // other side learn the track exists.
      p.shareSender = p.pc.addTrack(screenTrack, shareStream);
    }
  } catch (e) { console.warn('share attach', e); }
}

function newPeer(otherId) {
  if (peers.has(otherId)) return peers.get(otherId);
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  // One side has to yield when both offer at once. Comparing ids is arbitrary
  // but stable, and both ends compute the same answer without talking.
  const p = {
    id: otherId, pc, polite: String(S.me.id) < String(otherId), makingOffer: false, ignoreOffer: false,
    ice: earlyIce.get(otherId) || [], iceOut: [], iceTimer: null, camTrack: null, shareSender: null,
    everConnected: false, retried: false, failTimer: null, level: 0, lastLost: 0, lastTotal: 0,
  };
  earlyIce.delete(otherId);
  peers.set(otherId, p);
  const tile = addTile(otherId);
  setTileStatus(otherId, call?.role === 'caller' ? 'Ringing…' : 'Connecting…');
  local?.getTracks().forEach(t => pc.addTrack(t, local));
  if (screenTrack) attachShare(p);              // someone joining mid-share should see the screen, not the camera
  pc.onicecandidate = e => { if (e.candidate) queueIce(p, e.candidate); };
  pc.ontrack = e => {
    // One MediaStream per person, fed track by track. A screen share arrives on
    // a different msid than the mic, and swapping srcObject to it (what the old
    // single <video> did) silenced the person's voice for the rest of the call.
    if (!tile.stream.getTracks().includes(e.track)) tile.stream.addTrack(e.track);
    if (e.track.kind === 'audio') meter(otherId, new MediaStream([e.track]));
    if (e.track.kind !== 'video') return;
    const sync = () => {
      const liveVideo = tile.stream.getVideoTracks().some(t => !t.muted && t.readyState === 'live');
      tile.el.classList.toggle('has-video', liveVideo);
      // A voice call that suddenly carries video is someone sharing a screen —
      // the overlay has to actually show it rather than keeping the avatar card.
      ui.root().classList.toggle('remote-video', anyTileVideo());
    };
    e.track.addEventListener('unmute', sync);
    e.track.addEventListener('mute', () => setTimeout(sync, 1500));   // grace: a network hiccup also mutes briefly
    e.track.addEventListener('ended', () => { tile.stream.removeTrack(e.track); sync(); });
    sync();
  };
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      signal({ type: 'offer', sdp: pc.localDescription }, otherId);
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      p.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    if (peers.get(otherId) !== p || !call) return;      // we already dropped this link
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(p.failTimer);
      p.retried = false; p.everConnected = true; call.answered = true;
      setTileStatus(otherId, '');
      ui.root().classList.add('connected');
      stopRing(); startTimer(); refreshState();
    } else if (st === 'disconnected') {
      setTileStatus(otherId, 'Reconnecting…');     // usually heals by itself
    } else if (st === 'failed') {
      // On a weak network a link often "fails" and then comes back with a fresh
      // ICE round. Try that once before giving up on this person — and give up
      // on THEM only, not on the whole call.
      if (p.retried) return dropPeer(otherId);
      p.retried = true;
      setTileStatus(otherId, 'Reconnecting…');
      try { pc.restartIce(); } catch {}
      clearTimeout(p.failTimer);
      p.failTimer = setTimeout(() => {
        if (peers.get(otherId) === p && pc.connectionState !== 'connected') dropPeer(otherId);
      }, 12000);
    }
  };
  return p;
}

function removePeer(uid, { reason = 'ended', note } = {}) {
  const p = peers.get(uid);
  if (!p && !tiles.has(uid)) return;            // never part of this call on our side: nothing to tear down
  if (p) {
    clearTimeout(p.iceTimer); clearTimeout(p.failTimer);
    try { p.pc.close(); } catch {}
    peers.delete(uid);
  }
  earlyIce.delete(uid);
  removeTile(uid);
  refreshState();
  if (note) toast(note);
  if (call && !peers.size) hangup(reason);      // the last person gone ends the call; anyone else leaving does not
}

const dropPeer = uid => removePeer(uid, { reason: 'failed', note: `${nameOf(uid)} lost connection` });

function refreshState() {
  if (!call || !ui.root().classList.contains('connected')) return;
  const n = [...peers.values()].filter(p => p.everConnected).length;
  ui.state().textContent = n > 1 ? `${n + 1} in call` : 'Connected';
}

const signal = (payload, target = null) =>
  ins('call_signals', { call_id: call.id, sender_id: S.me.id, target_id: target, payload }).catch(() => {});

function resetCallState(row, extra) {
  resetGrid();
  call = { id: row.id, chat_id: row.chat_id, kind: row.kind, answered: false, joined: new Set(), seen: new Set(), queued: [], chain: Promise.resolve(), ...extra };
}

export async function startCall(kind) {
  const chat = S.chat;
  if (!chat) return;
  if (call) return toast('You are already in a call.', true);
  const others = S.members.filter(m => m.user_id !== S.me.id).map(m => m.user_id);
  if (!others.length) return toast('Nobody to call.', true);
  if (others.length > MAX_REMOTE) return toast(`Group calls hold up to 4 people. This chat has ${others.length + 1}. More needs an SFU (LiveKit), which Wisp does not ship yet.`, true);
  try {
    const [row] = await ins('calls', { chat_id: chat.chat_id, caller_id: S.me.id, kind, state: 'ringing' });
    resetCallState(row, { role: 'caller', callerId: S.me.id, group: chat.type !== 'dm', gate: false });
    await getLocal(kind);
    meter('me', local); startMeters();
    ui.who().textContent = chat.name || 'Call';
    ui.state().textContent = 'Ringing…';
    setPeerVisual(chat.name, chat.icon_url);
    resetControls();
    show(true);
    listenSignals();
    startRing(3500); // ringback — stops the instant either side connects or the call ends
    // No hand-rolled offer here: adding the local tracks in newPeer() fires
    // onnegotiationneeded, which is also the path every later renegotiation
    // (screen share on, screen share off, camera added) travels down.
    for (const uid of others) newPeer(uid);
    call.missTimer = setTimeout(async () => {
      if (!call || call.id !== row.id) return;
      if (!call.answered) {
        try { await upd('calls', { state: 'missed', ended_at: new Date().toISOString() }, { id: call.id }); } catch {}
        return hangup('missed');
      }
      // Somebody picked up. Whoever never did simply stops being on the call.
      for (const [uid, p] of [...peers]) if (!p.everConnected) removePeer(uid, { note: `${nameOf(uid)} didn't answer` });
    }, RING_MS);
    watchQuality();
  } catch (e) { oops(e); hangup('failed'); }
}

export async function incoming(row) {
  if (call) return;                        // already busy
  if (row.caller_id === S.me.id) return;
  const chat = S.chats.find(c => c.chat_id === row.chat_id);
  resetCallState(row, { role: 'callee', callerId: row.caller_id, group: !!chat && chat.type !== 'dm', gate: true });
  const who = chat?.name || nameOf(row.caller_id);
  ui.who().textContent = who;
  ui.state().textContent = `Incoming ${row.kind} call`;
  setPeerVisual(who, chat?.icon_url);
  resetControls();
  show(true);
  startRing(2500);
  notifyIncomingCall(who, row.kind, row.chat_id);
  listenSignals();
  // If the caller vanishes (app killed, network gone) nothing would ever stop
  // this ring, so it gives up a little after the caller's own timeout.
  const id = row.id;
  call.ringTimer = setTimeout(() => { if (call?.id === id && call.gate) hangup('cancelled'); }, RING_MS + 8000);
}

async function accept() {
  if (!call) return;
  clearTimeout(call.ringTimer);
  stopRing();
  call.answered = true;
  try { await getLocal(call.kind); } catch (e) { oops(e); return hangup('failed'); }
  meter('me', local); startMeters();
  try { await upd('calls', { state: 'accepted', answered_at: new Date().toISOString() }, { id: call.id }); } catch (e) { console.warn(e); }
  ui.state().textContent = 'Connecting…';
  show(true);
  signal({ type: 'ready' });
  watchQuality();
  // Everything that was said while the phone was ringing. Live signals were
  // held in call.queued; the database is the source of truth for anything that
  // was sent before our subscription finished (the caller can offer within
  // milliseconds of creating the call). seen[] de-duplicates the two sources.
  try {
    const rows = await sel('call_signals', { eq: { call_id: call.id }, order: ['id', 'asc'] });
    // The read policy lets a sender see their own rows too, so filter exactly
    // like the live path does: nothing from me, nothing addressed to someone else.
    for (const r of rows) {
      if (r.sender_id === S.me.id || (r.target_id && r.target_id !== S.me.id)) continue;
      call.queued.push({ id: r.id, from: r.sender_id, target: r.target_id, payload: r.payload });
    }
  } catch (e) { console.warn('catch-up', e); }
  await drain();
}

/* Signals arrive from two places (live Realtime + the catch-up read) and may be
   interleaved; both go through here, in id order, exactly once. */
async function drain() {
  while (call && call.queued.length) {
    const batch = call.queued.splice(0).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    for (const s of batch) await dispatch(s);
  }
  if (call) call.gate = false;               // no await between the last check and this: nothing can slip past
}

function handle(s) {
  if (!call || s.from === S.me.id) return;
  if (s.target && s.target !== S.me.id) return;     // addressed to somebody else in the mesh
  const p = s.payload;
  if (!p || typeof p !== 'object' || typeof p.type !== 'string') return;   // malformed row: ignore, never throw into Realtime
  if (p.type === 'ready') call.joined.add(s.from);
  if (p.type === 'bye') {
    call.joined.delete(s.from);
    // The caller hung up before we answered and nobody else has joined: stop ringing.
    if (call.gate && s.from === call.callerId && !call.joined.size) return hangup('cancelled');
  }
  if (call.gate) { call.queued.push(s); return; }   // still ringing: hold everything, in order
  // One at a time. Two awaits on the same peer connection (an offer and a
  // renegotiation, say) must not interleave or setRemoteDescription races itself.
  call.chain = call.chain.then(() => dispatch(s)).catch(() => {});
}

async function dispatch(s) {
  if (!call || s.from === S.me.id) return;      // never open a connection to ourselves, whatever path the row took
  if (s.id != null) { if (call.seen.has(s.id)) return; call.seen.add(s.id); }
  const p = s.payload;
  if (p?.type === 'ready') call.joined.add(s.from);      // also reached via the catch-up read, which skips handle()
  try {
    // Only the caller and people who announced `ready` are in this call. Any
    // other chat member could otherwise push an offer at you and get a tile and
    // a live connection without ever having joined.
    if (p.type === 'offer' && !peers.has(s.from) && s.from !== call.callerId && !call.joined.has(s.from)) return;
    if (p.type === 'bye') {
      const q = peers.get(s.from);
      const note = call.group && q ? `${nameOf(s.from)} ${q.everConnected ? 'left the call' : 'declined'}` : null;
      return removePeer(s.from, { note });
    }
    if (p.type === 'ready') {
      // Someone joined: connect to them too. But exactly ONE side of each pair
      // may open the connection. When two invitees both reacted to each other's
      // `ready` they offered at the same instant, and the glare left one
      // direction of the link muted (B could hear C, C's video never reached B).
      // The caller always opens links to invitees; between two invitees the
      // higher id does. The other side simply answers when the offer arrives.
      const iOpen = call.role === 'caller' || (s.from !== call.callerId && String(S.me.id) > String(s.from));
      if (iOpen && !peers.has(s.from)) newPeer(s.from);
      return;
    }
    await onSignal(s.from, p);
  } catch (e) { console.warn('signal', e); }
}

async function onSignal(from, p) {
  const peer = peers.get(from) || (p.type === 'offer' ? newPeer(from) : null);
  if (!peer) {
    // ICE for a peer we have not created yet: keep it for when we do.
    if (p.type === 'ice') {
      const list = earlyIce.get(from) || [];
      list.push(...(p.candidates || [p.candidate]).filter(Boolean));
      earlyIce.set(from, list);
    }
    return;
  }
  const pc = peer.pc;

  if (p.type === 'offer' || p.type === 'answer') {
    const collision = p.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;                 // impolite side keeps its own offer
    await pc.setRemoteDescription(p.sdp);         // implicit rollback handles the polite case
    for (const c of peer.ice.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (e) { console.warn('late ice', e); }
    }
    if (p.type === 'offer') {
      await pc.setLocalDescription();
      signal({ type: 'answer', sdp: pc.localDescription }, from);
    } else {
      call.answered = true; stopRing();
      if (!peer.everConnected) setTileStatus(from, 'Connecting…');
    }
    return;
  }

  if (p.type === 'ice') {
    // Candidates routinely beat their description through the table.
    for (const c of p.candidates || [p.candidate]) {
      if (!c) continue;
      if (!pc.remoteDescription) { peer.ice.push(c); continue; }
      try { await pc.addIceCandidate(c); } catch (e) { if (!peer.ignoreOffer) console.warn('ice', e); }
    }
  }
}

function listenSignals() {
  channel('call', ch => ch.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'call_signals', filter: `call_id=eq.${call.id}` },
    ({ new: s }) => handle({ id: s.id, from: s.sender_id, target: s.target_id, payload: s.payload })));
}

function startTimer() {
  if (call.t0) return;
  call.t0 = Date.now();
  call.timer = setInterval(() => { ui.timer().textContent = dur((Date.now() - call.t0) / 1000); }, 500);
}

/* Adaptive bitrate: step video down instead of freezing. Each link keeps its
   own loss history (the old shared counters made every peer after the first
   compute nonsense), and because a mesh sends the same video once per person,
   each link only gets its share of the uplink. */
function watchQuality() {
  const steps = [2500e3, 1200e3, 600e3, 300e3, 120e3];
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    const linked = [...peers.values()].filter(p => p.pc.connectionState === 'connected');
    let worst = 0, worstAvail = null;
    for (const p of linked) {
      const { pc } = p;
      const stats = await pc.getStats();
      let lost = 0, total = 0, avail = null;
      stats.forEach(r => {
        if (r.type === 'remote-inbound-rtp') { lost += r.packetsLost || 0; }
        if (r.type === 'outbound-rtp') total += r.packetsSent || 0;
        if (r.type === 'candidate-pair' && r.state === 'succeeded') avail = r.availableOutgoingBitrate;
      });
      const dLost = lost - p.lastLost, dTotal = Math.max(1, total - p.lastTotal);
      p.lastLost = lost; p.lastTotal = total;
      const rate = dLost / dTotal;
      const bad = rate > 0.04 || (avail && avail < steps[p.level] * 0.6);
      const good = rate < 0.01 && (!avail || avail > steps[Math.max(0, p.level - 1)] * 1.2);
      if (bad && p.level < steps.length - 1) p.level++;
      else if (good && p.level > 0) p.level--;
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        const prm = sender.getParameters();
        prm.encodings = prm.encodings?.length ? prm.encodings : [{}];
        const cap = Math.max(steps[p.level] / linked.length, 100e3);
        // A shared screen that gets scaled down stops being readable, which is
        // the whole point of sharing it — cap the bitrate but keep it 1:1.
        prm.encodings[0].maxBitrate = screenTrack ? Math.max(cap, 600e3) : cap;
        prm.encodings[0].scaleResolutionDownBy = screenTrack ? 1 : 1 + p.level;
        try { await sender.setParameters(prm); } catch {}
      }
      if (p.level >= worst) { worst = p.level; worstAvail = avail; }
    }
    if (linked.length) ui.q().textContent = ['excellent', 'good', 'fair', 'poor', 'minimal'][worst] + (worstAvail ? ` · ${Math.round(worstAvail / 1000)} kbps` : '');
  }, 3000);
}

export async function hangup(reason = 'ended') {
  if (!call) return show(false);
  const c = call;
  const id = c.id, t0 = c.t0;
  clearTimeout(c.ringTimer); clearTimeout(c.missTimer);
  clearInterval(c.timer); clearInterval(statsTimer); stopMeters(); stopRing();
  // 'cancelled' = we are only dropping a ring that the caller already ended, so
  // there is nothing to announce and nothing for us to record.
  if (reason !== 'cancelled') { try { await signal({ type: 'bye' }); } catch {} }
  peers.forEach(p => { clearTimeout(p.iceTimer); clearTimeout(p.failTimer); try { p.pc.close(); } catch {} });
  peers.clear(); earlyIce.clear();
  local?.getTracks().forEach(t => t.stop());
  shareStream?.getTracks().forEach(t => { try { t.stop(); } catch {} });
  try { screenTrack?.stop(); } catch {}
  local = null; screenTrack = null; shareStream = null;
  const duration = t0 ? Math.round((Date.now() - t0) / 1000) : 0;
  // t0 is only set once media actually connected, so it (not the rounded
  // duration, which is 0 for anything under half a second) says "ended" vs "declined".
  const state = reason === 'missed' ? 'missed' : reason === 'failed' ? 'failed' : t0 ? 'ended' : 'declined';
  // In a group the call row and the "Voice call · ended" bubble describe the
  // whole call, so one person writes them (the caller) instead of every
  // participant overwriting the row and stacking duplicate bubbles.
  // A 1:1 callee only writes when it genuinely declined (never answered): if it
  // had accepted, the caller owns the final row, otherwise a callee leaving
  // mid-connect overwrote the caller's "ended" with "declined".
  const records = reason !== 'cancelled' && (c.role === 'caller' || (!c.group && !c.answered));
  if (records) {
    try {
      await upd('calls', { state, ended_at: new Date().toISOString(), duration }, { id });
      if (S.chat?.chat_id === c.chat_id) {
        await ins('messages', {
          chat_id: c.chat_id, sender_id: S.me.id, kind: 'call',
          body: `${c.kind === 'video' ? 'Video' : 'Voice'} call · ${state}${duration ? ' · ' + dur(duration) : ''}`,
          // call.kind travels in meta now (not just baked into the body text)
          // so the bubble's tap handler can rebuild a proper call-details view
          // — voice vs video, call back, etc. — without parsing the string.
          meta: { call_id: id, state, duration, kind: c.kind },
        });
      }
    } catch {}
  }
  call = null;
  drop('call');
  // let the "ending call" glow finish its spin around the pill before the
  // overlay actually disappears — media/tracks are already released above,
  // this is purely the visual sign-off, not a functional delay
  ui.root().classList.add('hanging-up');
  await new Promise(r => setTimeout(r, 650));
  ui.root().classList.remove('hanging-up');
  if (call) return;                              // a new call started during the sign-off: leave its overlay alone
  show(false);
  ui.root().classList.remove('connected', 'show-meta', 'sharing', 'remote-video', 'multi');
  ui.timer().textContent = ''; ui.q().textContent = '';
  resetGrid(); ui.self().srcObject = null;
  ui.avatar().src = ''; ui.bg().style.backgroundImage = '';
  resetControls();
}

/* ── screen share ────────────────────────────────────────────────── */
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
    return toast('This browser cannot capture a screen. Mobile Safari and Chrome on Android do not offer it to web apps at all — share from a laptop instead.', true);
  }
  let stream;
  try {
    stream = await md.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') oops(e);
    return;                                     // picker dismissed: nothing to report
  }
  const track = stream.getVideoTracks()[0];
  if (!track) { stream.getTracks().forEach(t => t.stop()); return toast('That capture had no video in it.', true); }
  screenTrack = track;
  shareStream = stream;
  for (const p of peers.values()) await attachShare(p);
  track.addEventListener('ended', () => { stopShare().catch(e => console.warn(e)); });
  ui.self().srcObject = stream;
  ui.self().hidden = false;
  ui.root().classList.add('sharing');
  markShare(true);
  toast('Sharing your screen.');
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
}

async function toggleShare() {
  if (!call) return;
  try { screenTrack ? await stopShare() : await startShare(); } catch (e) { oops(e); }
}

/* Output routing. The web has exactly one lever here, setSinkId, and only
   Chromium-based browsers ship it — iOS/Safari route call audio at the OS
   level and expose nothing to the page. So: switch the sink where that is
   possible, and where it isn't, say so once instead of leaving a dead
   permanently-disabled button in a bar that otherwise works. Every tile's
   <video> carries that person's audio (they are only visually hidden during
   voice calls, and hidden media still plays), so all of them are sinks. */
async function toggleSpeaker(btn) {
  const vids = [...tiles.values()].map(t => t.video);
  if (!vids.length || typeof vids[0].setSinkId !== 'function') {
    return toast('This browser leaves call audio to the phone — use the system output picker to move it.');
  }
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const next = onSpeaker
      ? outs.find(d => /receiver|earpiece|headset|headphone|bluetooth/i.test(d.label))
      : (outs.find(d => /speaker/i.test(d.label)) || outs.find(d => d.deviceId === 'default'));
    if (!next) return toast('No other audio output is available right now.');
    await Promise.all(vids.map(v => v.setSinkId(next.deviceId)));
    sinkId = next.deviceId;
    onSpeaker = !onSpeaker;
    btn.classList.toggle('off', !onSpeaker);
  } catch (e) { oops(e); }
}

export function mountCalls() {
  $('#btn-call-audio').onclick = () => startCall('audio');
  $('#btn-call-video').onclick = () => startCall('video');
  $('#call-hang').onclick = () => hangup('ended');
  $('#call-accept').onclick = accept;
  $('#call-share').onclick = toggleShare;
  $('#call-speaker').onclick = e => toggleSpeaker(e.currentTarget);
  $('#call-mute').onclick = e => {
    const t = local?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    swapIcon(e.currentTarget, t.enabled ? 'mic-fill' : 'mic-off-fill', GLYPH);
  };
  $('#call-cam').onclick = e => {
    const t = local?.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    swapIcon(e.currentTarget, t.enabled ? 'video-fill' : 'video-off-fill', GLYPH);
  };
  // FaceTime-style chrome: once a video call is connected, the name/timer
  // overlay fades out; tapping the video brings it back for a few seconds.
  ui.stage().addEventListener('click', () => {
    if (call?.kind !== 'video' || !ui.root().classList.contains('connected')) return;
    ui.root().classList.add('show-meta');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => ui.root().classList.remove('show-meta'), 3500);
  });
  channel('calls-in', ch => ch.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'calls' }, ({ new: row }) => incoming(row)));
  addEventListener('beforeunload', () => { if (call) hangup('ended'); });
}

export async function callHistory() {
  const rows = await sel('calls', { select: '*, chats(name, type)', order: ['started_at', 'desc'], limit: 80 });
  return rows;
}

/* ── call details sheet ──────────────────────────────────────────────────
   Both the Calls tab and the in-thread "Voice call · declined" bubble open
   this instead of just jumping into the chat: it shows exactly when the
   call happened, and offers the actions someone actually wants from a call
   log entry — message back, call back (audio or video), or schedule a
   message — as one tap each instead of two or three. */
const CALL_STATE_LABEL = { missed: 'Missed', declined: 'Declined', ended: 'Ended',
  accepted: 'In progress', ringing: 'Ringing', failed: 'Failed' };

export function openCallDetails({ name, kind, state, duration, startedAt, chatId, alreadyOpen }) {
  const isVideo = kind === 'video';
  const label = CALL_STATE_LABEL[state] || state || '';
  const chatStillThere = !chatId || S.chats.some(c => c.chat_id === chatId);

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
        h('p', { class: 'muted' }, `${isVideo ? 'Video' : 'Voice'} call${label ? ' · ' + label : ''}${duration ? ' · ' + dur(duration) : ''}`))),
    startedAt && h('p', { class: 'hint' }, `${dayLabel(startedAt)} at ${clock(startedAt)}`),
    h('div', { class: 'modal-actions call-detail-actions' },
      !alreadyOpen && h('button', { class: 'btn icon-label', onclick: () => withChatOpen(() => {}) }, iconEl('chat', 16), 'Message'),
      h('button', { class: 'btn icon-label', onclick: () => withChatOpen(() => startCall('audio')) }, iconEl('call', 16), 'Voice call'),
      h('button', { class: 'btn icon-label', onclick: () => withChatOpen(() => startCall('video')) }, iconEl('video', 16), 'Video call'),
      h('button', {
        class: 'btn icon-label',
        onclick: () => withChatOpen(async () => (await import('./composer.js')).scheduleDialog()),
      }, iconEl('clock', 16), 'Schedule message'),
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')),
  ].filter(Boolean));
}
