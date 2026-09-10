// 1:1 and small-mesh WebRTC. Signaling rides on the call_signals table via
// Realtime, so there is no extra server to run. Beyond ~4 participants a mesh
// stops being viable: you need an SFU (LiveKit / mediasoup). Not built here,
// and the UI says so instead of pretending.
//
// Negotiation follows the standard "perfect negotiation" shape: every offer
// comes out of onnegotiationneeded rather than being hand-rolled at one call
// site. That is what makes screen sharing work at all — starting a share adds
// or replaces a video track mid-call, which needs a fresh offer/answer round.
// The old code only ever offered once, at the very start, so a share during a
// voice call added a track nobody ever received, and a share during a video
// call could land mid-handshake with nothing to resolve the glare.
import { sb, rpc, ins, upd, sel, channel, drop } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, h, clear, toast, oops, dur, iconEl, initials, swapIcon } from './util.js';
import { playSound } from './notify.js';

let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
export function setIceServers(list) { if (list?.length) ice = list; }

const peers = new Map();      // user_id -> { pc, polite, makingOffer, ignoreOffer, ice[], camTrack, shareSender }
let call = null;              // { id, chat_id, kind, role, timer, t0 }
let local = null;
let screenTrack = null;
let shareStream = null;
let statsTimer = null;
let revealTimer = null;       // FaceTime-style "tap to bring controls back" during video calls
let onSpeaker = true;         // only meaningful where setSinkId exists (see toggleSpeaker)

/* The control-bar glyphs are the filled variants at 26px, and the mic and
   camera each have a slashed twin for their off state. Size lives here as
   well as in the markup because swapIcon() redraws the glyph from scratch. */
const GLYPH = 26;

const ui = {
  root: () => $('#call'), stage: () => $('.call-stage'), remote: () => $('#call-remote'), self: () => $('#call-local'),
  who: () => $('#call-who'), state: () => $('#call-state'), timer: () => $('#call-timer'), q: () => $('#call-quality'),
  avatar: () => $('#call-avatar'), bg: () => $('#call-audio-bg'),
};

// Small inline fallback so the voice-call avatar/backdrop always has
// something to show even when the chat has no photo set.
const avatarFallback = name => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#8a8578"/><text x="48" y="58" font-family="sans-serif" font-size="34" fill="#f4f1ea" text-anchor="middle">${initials(name)}</text></svg>`);

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
  local = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: kind === 'video' ? { width: { ideal: 1280 }, facingMode: 'user' } : false,
  });
  ui.self().srcObject = local;
  ui.self().hidden = kind !== 'video';
  return local;
}

const anyRemoteVideo = () => [...peers.values()].some(p =>
  p.pc.getReceivers().some(r => r.track?.kind === 'video' && r.track.readyState === 'live'));

function newPeer(otherId) {
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  // One side has to yield when both offer at once. Comparing ids is arbitrary
  // but stable, and both ends compute the same answer without talking.
  const p = { pc, polite: String(S.me.id) < String(otherId), makingOffer: false, ignoreOffer: false, ice: [], camTrack: null, shareSender: null };
  peers.set(otherId, p);
  local?.getTracks().forEach(t => pc.addTrack(t, local));
  pc.onicecandidate = e => e.candidate && signal({ type: 'ice', candidate: e.candidate }, otherId);
  pc.ontrack = e => {
    const v = ui.remote();
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
    if (e.track.kind !== 'video') return;
    // A voice call that suddenly carries video is someone sharing a screen —
    // the overlay has to actually show it rather than keeping the avatar card.
    ui.root().classList.add('remote-video');
    e.track.addEventListener('ended', () => {
      if (!anyRemoteVideo()) ui.root().classList.remove('remote-video');
    });
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
    if (pc.connectionState === 'connected') { ui.state().textContent = 'Connected'; startTimer(); ui.root().classList.add('connected'); }
    if (['failed', 'closed'].includes(pc.connectionState)) hangup('failed');
  };
  return p;
}

const signal = (payload, target = null) =>
  ins('call_signals', { call_id: call.id, sender_id: S.me.id, target_id: target, payload }).catch(() => {});

export async function startCall(kind) {
  const chat = S.chat;
  if (!chat) return;
  const others = S.members.filter(m => m.user_id !== S.me.id).map(m => m.user_id);
  if (!others.length) return toast('Nobody to call.', true);
  if (others.length > 3) return toast('Mesh calls cap at 4 people. An SFU is required past that, and Wisp does not ship one.', true);
  try {
    const [row] = await ins('calls', { chat_id: chat.chat_id, caller_id: S.me.id, kind, state: 'ringing' });
    call = { id: row.id, chat_id: chat.chat_id, kind, role: 'caller', answered: false };
    await getLocal(kind);
    ui.who().textContent = chat.name || 'Call';
    ui.state().textContent = 'Ringing\u2026';
    setPeerVisual(chat.name, chat.icon_url);
    resetControls();
    show(true);
    listenSignals();
    // No hand-rolled offer here: adding the local tracks in newPeer() fires
    // onnegotiationneeded, which is also the path every later renegotiation
    // (screen share on, screen share off, camera added) travels down.
    for (const uid of others) newPeer(uid);
    setTimeout(async () => {
      if (call && !call.answered) { await upd('calls', { state: 'missed', ended_at: new Date().toISOString() }, { id: call.id }); hangup('missed'); }
    }, 45000);
    watchQuality();
  } catch (e) { oops(e); hangup('failed'); }
}

export async function incoming(row) {
  if (call) return;                        // already busy
  if (row.caller_id === S.me.id) return;
  const chat = S.chats.find(c => c.chat_id === row.chat_id);
  call = { id: row.id, chat_id: row.chat_id, kind: row.kind, role: 'callee', answered: false, queued: [] };
  ui.who().textContent = chat?.name || nameOf(row.caller_id);
  ui.state().textContent = `Incoming ${row.kind} call`;
  setPeerVisual(chat?.name || nameOf(row.caller_id), chat?.icon_url);
  resetControls();
  show(true);
  playSound();
  const ring = setInterval(playSound, 2500);
  call.ring = ring;
  listenSignals();
}

async function accept() {
  if (!call) return;
  clearInterval(call.ring);
  call.answered = true;
  await getLocal(call.kind);
  await upd('calls', { state: 'accepted', answered_at: new Date().toISOString() }, { id: call.id });
  ui.state().textContent = 'Connecting\u2026';
  show(true);
  signal({ type: 'ready' });
  watchQuality();
  // Everything that arrived while the phone was still ringing — the offer, and
  // any ICE that raced ahead of it — replayed in the order it came in.
  const queued = call.queued || [];
  call.queued = [];
  for (const q of queued) await onSignal(q.from, q.payload).catch(e => console.warn('replay', e));
}

async function onSignal(from, p) {
  const peer = peers.get(from) || (p.type === 'offer' ? newPeer(from) : null);
  if (!peer) return;
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
      call.answered = true;
    }
    return;
  }

  if (p.type === 'ice') {
    // Candidates routinely beat their description through the table.
    if (!pc.remoteDescription) { peer.ice.push(p.candidate); return; }
    try { await pc.addIceCandidate(p.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn('ice', e); }
  }
}

function listenSignals() {
  channel('call', ch => ch.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'call_signals', filter: `call_id=eq.${call.id}` },
    async ({ new: s }) => {
      if (!call || s.sender_id === S.me.id) return;
      const p = s.payload;
      try {
        if (p.type === 'bye') return hangup('ended');
        if (p.type === 'ready') return;
        if (!local) { (call.queued = call.queued || []).push({ from: s.sender_id, payload: p }); return; }
        await onSignal(s.sender_id, p);
      } catch (e) { console.warn('signal', e); }
    }));
}

function startTimer() {
  if (call.t0) return;
  call.t0 = Date.now();
  call.timer = setInterval(() => { ui.timer().textContent = dur((Date.now() - call.t0) / 1000); }, 500);
}

/* Adaptive bitrate: step video down instead of freezing. */
function watchQuality() {
  const steps = [2500e3, 1200e3, 600e3, 300e3, 120e3];
  let level = 0, lastLost = 0, lastTotal = 0;
  statsTimer = setInterval(async () => {
    for (const { pc } of peers.values()) {
      const stats = await pc.getStats();
      let lost = 0, total = 0, avail = null;
      stats.forEach(r => {
        if (r.type === 'remote-inbound-rtp') { lost += r.packetsLost || 0; }
        if (r.type === 'outbound-rtp') total += r.packetsSent || 0;
        if (r.type === 'candidate-pair' && r.state === 'succeeded') avail = r.availableOutgoingBitrate;
      });
      const dLost = lost - lastLost, dTotal = Math.max(1, total - lastTotal);
      lastLost = lost; lastTotal = total;
      const rate = dLost / dTotal;
      const bad = rate > 0.04 || (avail && avail < steps[level] * 0.6);
      const good = rate < 0.01 && (!avail || avail > steps[Math.max(0, level - 1)] * 1.2);
      if (bad && level < steps.length - 1) level++;
      else if (good && level > 0) level--;
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        const prm = sender.getParameters();
        prm.encodings = prm.encodings?.length ? prm.encodings : [{}];
        // A shared screen that gets scaled down stops being readable, which is
        // the whole point of sharing it — cap the bitrate but keep it 1:1.
        prm.encodings[0].maxBitrate = screenTrack ? Math.max(steps[level], 800e3) : steps[level];
        prm.encodings[0].scaleResolutionDownBy = screenTrack ? 1 : 1 + level;
        try { await sender.setParameters(prm); } catch {}
      }
      ui.q().textContent = ['excellent', 'good', 'fair', 'poor', 'minimal'][level] + (avail ? ` · ${Math.round(avail / 1000)} kbps` : '');
    }
  }, 3000);
}

export async function hangup(reason = 'ended') {
  if (!call) return show(false);
  const id = call.id, t0 = call.t0;
  clearInterval(call.timer); clearInterval(call.ring); clearInterval(statsTimer);
  try { await signal({ type: 'bye' }); } catch {}
  peers.forEach(({ pc }) => pc.close());
  peers.clear();
  local?.getTracks().forEach(t => t.stop());
  shareStream?.getTracks().forEach(t => { try { t.stop(); } catch {} });
  try { screenTrack?.stop(); } catch {}
  local = null; screenTrack = null; shareStream = null;
  const duration = t0 ? Math.round((Date.now() - t0) / 1000) : 0;
  const state = reason === 'missed' ? 'missed' : reason === 'failed' ? 'failed' : duration ? 'ended' : 'declined';
  try {
    await upd('calls', { state, ended_at: new Date().toISOString(), duration }, { id });
    if (S.chat?.chat_id === call.chat_id) {
      await ins('messages', {
        chat_id: call.chat_id, sender_id: S.me.id, kind: 'call',
        body: `${call.kind === 'video' ? 'Video' : 'Voice'} call · ${state}${duration ? ' · ' + dur(duration) : ''}`,
        meta: { call_id: id, state, duration },
      });
    }
  } catch {}
  call = null;
  drop('call');
  // let the "ending call" glow finish its spin around the pill before the
  // overlay actually disappears — media/tracks are already released above,
  // this is purely the visual sign-off, not a functional delay
  ui.root().classList.add('hanging-up');
  await new Promise(r => setTimeout(r, 650));
  ui.root().classList.remove('hanging-up');
  show(false);
  ui.root().classList.remove('connected', 'show-meta', 'sharing', 'remote-video');
  ui.timer().textContent = ''; ui.q().textContent = '';
  ui.remote().srcObject = null; ui.self().srcObject = null;
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
  for (const p of peers.values()) {
    const sender = p.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) {
      p.camTrack = sender.track;                // remember the camera to come back to
      try { await sender.replaceTrack(track); } catch (e) { console.warn('replace', e); }
    } else {
      // Voice call: there is no video transceiver yet. addTrack creates one and
      // fires onnegotiationneeded, which is the renegotiation that used to be
      // missing — without it the other side never learned the track existed.
      p.shareSender = p.pc.addTrack(track, stream);
    }
  }
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
   permanently-disabled button in a bar that otherwise works. The remote
   <video> element carries the audio in both call kinds (it is only hidden
   during voice calls, and hidden media still plays), so it is the sink. */
async function toggleSpeaker(btn) {
  const el = ui.remote();
  if (typeof el.setSinkId !== 'function') {
    return toast('This browser leaves call audio to the phone — use the system output picker to move it.');
  }
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const next = onSpeaker
      ? outs.find(d => /receiver|earpiece|headset|headphone|bluetooth/i.test(d.label))
      : (outs.find(d => /speaker/i.test(d.label)) || outs.find(d => d.deviceId === 'default'));
    if (!next) return toast('No other audio output is available right now.');
    await el.setSinkId(next.deviceId);
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
