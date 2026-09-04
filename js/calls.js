// 1:1 and small-mesh WebRTC. Signaling rides on the call_signals table via
// Realtime, so there is no extra server to run. Beyond ~4 participants a mesh
// stops being viable: you need an SFU (LiveKit / mediasoup). Not built here,
// and the UI says so instead of pretending.
import { sb, rpc, ins, upd, sel, channel, drop } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, h, clear, toast, oops, dur, iconEl } from './util.js';
import { playSound } from './notify.js';

let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
export function setIceServers(list) { if (list?.length) ice = list; }

const peers = new Map();      // user_id -> { pc, senders }
let call = null;              // { id, chat_id, kind, role, timer, t0 }
let local = null;
let screenTrack = null;
let statsTimer = null;

const ui = {
  root: () => $('#call'), remote: () => $('#call-remote'), self: () => $('#call-local'),
  who: () => $('#call-who'), state: () => $('#call-state'), timer: () => $('#call-timer'), q: () => $('#call-quality'),
};

function show(on) {
  ui.root().hidden = !on;
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

function newPeer(otherId) {
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  local?.getTracks().forEach(t => pc.addTrack(t, local));
  pc.onicecandidate = e => e.candidate && signal({ type: 'ice', candidate: e.candidate }, otherId);
  pc.ontrack = e => {
    const v = ui.remote();
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { ui.state().textContent = 'Connected'; startTimer(); }
    if (['failed', 'closed'].includes(pc.connectionState)) hangup('failed');
  };
  peers.set(otherId, { pc });
  return pc;
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
    ui.state().textContent = 'Ringing…';
    show(true);
    listenSignals();
    for (const uid of others) {
      const pc = newPeer(uid);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal({ type: 'offer', sdp: pc.localDescription }, uid);
    }
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
  call = { id: row.id, chat_id: row.chat_id, kind: row.kind, role: 'callee', answered: false };
  ui.who().textContent = chat?.name || nameOf(row.caller_id);
  ui.state().textContent = `Incoming ${row.kind} call`;
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
  ui.state().textContent = 'Connecting…';
  show(true);
  signal({ type: 'ready' });
  watchQuality();
  // any offer that arrived while ringing is replayed by listenSignals()
  for (const pending of call.pendingOffers || []) await handleOffer(pending.from, pending.sdp);
}

async function handleOffer(from, sdp) {
  if (!local) { (call.pendingOffers = call.pendingOffers || []).push({ from, sdp }); return; }
  const pc = peers.get(from)?.pc || newPeer(from);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal({ type: 'answer', sdp: pc.localDescription }, from);
}

function listenSignals() {
  channel('call', ch => ch.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'call_signals', filter: `call_id=eq.${call.id}` },
    async ({ new: s }) => {
      if (s.sender_id === S.me.id) return;
      const p = s.payload;
      try {
        if (p.type === 'offer') await handleOffer(s.sender_id, p.sdp);
        else if (p.type === 'answer') { call.answered = true; await peers.get(s.sender_id)?.pc.setRemoteDescription(p.sdp); }
        else if (p.type === 'ice') await peers.get(s.sender_id)?.pc.addIceCandidate(p.candidate);
        else if (p.type === 'bye') hangup('ended');
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
        prm.encodings[0].maxBitrate = steps[level];
        prm.encodings[0].scaleResolutionDownBy = 1 + level;
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
  screenTrack?.stop();
  local = null; screenTrack = null;
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
  show(false);
  ui.timer().textContent = ''; ui.q().textContent = '';
  ui.remote().srcObject = null; ui.self().srcObject = null;
}

async function toggleShare() {
  if (!call) return;
  if (screenTrack) {
    screenTrack.stop(); screenTrack = null;
    const camTrack = local.getVideoTracks()[0];
    for (const { pc } of peers.values()) pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(camTrack || null);
    $('#call-share').classList.remove('off');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    screenTrack = stream.getVideoTracks()[0];
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      sender ? sender.replaceTrack(screenTrack) : pc.addTrack(screenTrack, stream);
    }
    screenTrack.onended = () => toggleShare();
    $('#call-share').classList.add('off');
  } catch (e) { oops(e); }
}

export function mountCalls() {
  $('#btn-call-audio').onclick = () => startCall('audio');
  $('#btn-call-video').onclick = () => startCall('video');
  $('#call-hang').onclick = () => hangup('ended');
  $('#call-accept').onclick = accept;
  $('#call-share').onclick = toggleShare;
  $('#call-mute').onclick = e => {
    const t = local?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
  };
  $('#call-cam').onclick = e => {
    const t = local?.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
  };
  channel('calls-in', ch => ch.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'calls' }, ({ new: row }) => incoming(row)));
  addEventListener('beforeunload', () => { if (call) hangup('ended'); });
}

export async function callHistory() {
  const rows = await sel('calls', { select: '*, chats(name, type)', order: ['started_at', 'desc'], limit: 80 });
  return rows;
}
