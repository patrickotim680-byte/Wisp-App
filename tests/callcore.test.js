// Group calls — every rule from js/callcore.js. The cases that exist because
// the old 1:1-only implementation got them wrong are marked (regression).
import { describe, it, assert } from './harness.js';
import {
  CAPACITY, capacityFor, isPolite, peerRole, rosterReduce, liveIds, liveCount,
  canJoin, gridLayout, speakingNext, qualityStep, validSignal, signalAccepted,
  callSummary, durText, joinBannerText, ringTimedOut, isStale, declineEndsCall,
  BITRATE_STEPS, SPEAK_ON, SPEAK_OFF, RING_TIMEOUT_MS, HEARTBEAT_MS, STALE_AFTER_MS,
} from '../js/callcore.js';

const p = (id, over = {}) => ({ user_id: id, joined_at: '2026-09-16T10:00:00Z', left_at: null, muted: false, cam_on: false, sharing: false, ...over });
const rosterOf = (...rows) => new Map(rows.map(r => [r.user_id, r]));

/* ── normal cases ───────────────────────────────────────────────── */
describe('call: normal', () => {
  it('capacity is 6 audio / 4 video and matches call_capacity() in SQL', () => {
    assert.eq(capacityFor('audio'), 6);
    assert.eq(capacityFor('video'), 4);
    assert.deep(CAPACITY, { audio: 6, video: 4 });
  });
  it('a member can join a live call with room in it', () => {
    const r = canJoin({ kind: 'video', roster: rosterOf(p('a'), p('b')), meId: 'me' });
    assert.ok(r.ok);
    assert.not(r.already);
  });
  it('joining a call you are already in is a no-op, not an error', () => {
    const r = canJoin({ kind: 'audio', roster: rosterOf(p('me')), meId: 'me' });
    assert.ok(r.ok);
    assert.ok(r.already);
  });
  it('exactly one side of each pair is polite, and both compute the same answer', () => {
    assert.ok(isPolite('aaa', 'bbb'));
    assert.not(isPolite('bbb', 'aaa'));
    assert.eq(isPolite('aaa', 'bbb'), !isPolite('bbb', 'aaa'));
  });
  it('the person who just joined is the one who offers (regression: nobody did)', () => {
    const late = peerRole('late', 'early', { myJoinedAt: 2000, theirJoinedAt: 1000 });
    const early = peerRole('early', 'late', { myJoinedAt: 1000, theirJoinedAt: 2000 });
    assert.ok(late.initiator);
    assert.not(early.initiator);
    assert.eq(late.polite, !early.polite, 'polite must still be opposite');
  });
  it('every pair in a mesh gets a peer, including callee-to-callee (regression)', () => {
    const roster = rosterOf(p('a'), p('b'), p('c'));
    assert.deep(liveIds(roster, 'a').sort(), ['b', 'c']);
    assert.deep(liveIds(roster, 'b').sort(), ['a', 'c']);
    assert.deep(liveIds(roster, 'c').sort(), ['a', 'b']);
  });
  it('the roster tracks joins, mutes and leaves in whatever order they arrive', () => {
    let r = new Map();
    r = rosterReduce(r, { type: 'upsert', row: p('a') });
    r = rosterReduce(r, { type: 'upsert', row: p('b') });
    r = rosterReduce(r, { type: 'upsert', row: { user_id: 'a', muted: true } });
    assert.eq(liveCount(r), 2);
    assert.ok(r.get('a').muted);
    assert.eq(r.get('a').joined_at, '2026-09-16T10:00:00Z', 'a partial update must not wipe the row');
    r = rosterReduce(r, { type: 'upsert', row: { user_id: 'b', left_at: '2026-09-16T10:05:00Z' } });
    assert.eq(liveCount(r), 1);
    assert.deep(liveIds(r, 'a'), []);
  });
  it('a summary reads the same as the one the server writes', () => {
    assert.eq(callSummary({ kind: 'audio', state: 'ended', duration: 83, participants: 2 }), 'Voice call \u00b7 ended \u00b7 1:23');
    assert.eq(callSummary({ kind: 'video', state: 'ended', duration: 83, participants: 3 }), 'Video group call \u00b7 ended \u00b7 1:23');
    assert.eq(callSummary({ kind: 'audio', state: 'missed', duration: 0, participants: 1 }), 'Voice call \u00b7 missed');
  });
  it('the join banner names who is already in', () => {
    assert.match(joinBannerText({ kind: 'video', names: ['Mercy'], participants: 1 }), /^Mercy is on a video call$/);
    assert.match(joinBannerText({ kind: 'audio', names: ['Mercy', 'Ali'], participants: 2 }), /Mercy and Ali are on a voice call/);
    assert.match(joinBannerText({ kind: 'audio', names: ['A', 'B', 'C', 'D'], participants: 4 }), /A, B \+2/);
    assert.match(joinBannerText({ iAmIn: true }), /you are in it/);
  });
  it('heartbeat cadence leaves room for a missed beat before the server sweeps', () => {
    assert.ok(HEARTBEAT_MS * 2 < STALE_AFTER_MS, 'two missed beats must still be inside the window');
    assert.eq(STALE_AFTER_MS, 75_000);
  });
});

/* ── edge cases ────────────────────────────────────────────────── */
describe('call: edges', () => {
  it('a full audio call refuses the 7th person, with the reason', () => {
    const roster = rosterOf(...['a', 'b', 'c', 'd', 'e', 'f'].map(id => p(id)));
    const r = canJoin({ kind: 'audio', roster, meId: 'g' });
    assert.not(r.ok);
    assert.match(r.reason, /full at 6/);
    assert.match(r.reason, /SFU/, 'the refusal has to say why, not just no');
  });
  it('a full video call refuses the 5th', () => {
    const roster = rosterOf(...['a', 'b', 'c', 'd'].map(id => p(id)));
    assert.not(canJoin({ kind: 'video', roster, meId: 'e' }).ok);
  });
  it('someone who left frees their slot', () => {
    const roster = rosterOf(...['a', 'b', 'c', 'd'].map(id => p(id)));
    roster.set('d', p('d', { left_at: '2026-09-16T10:03:00Z' }));
    assert.ok(canJoin({ kind: 'video', roster, meId: 'e' }).ok);
  });
  it('a rejoin by someone already in the room does not count twice', () => {
    const roster = rosterOf(...['a', 'b', 'c', 'd'].map(id => p(id)));
    assert.ok(canJoin({ kind: 'video', roster, meId: 'd' }).already);
  });
  it('an ended or closed call cannot be joined', () => {
    assert.not(canJoin({ ended: true }).ok);
    assert.match(canJoin({ ended: true }).reason, /already ended/);
    assert.not(canJoin({ joinOpen: false }).ok);
  });
  it('two people who joined in the same millisecond still pick one initiator', () => {
    const a = peerRole('aaa', 'bbb', { myJoinedAt: 1000, theirJoinedAt: 1000 });
    const b = peerRole('bbb', 'aaa', { myJoinedAt: 1000, theirJoinedAt: 1000 });
    assert.eq(a.initiator, !b.initiator, 'exactly one initiator, never zero and never two');
  });
  it('the grid stays balanced from 1 to 8 tiles', () => {
    assert.deep(gridLayout(1), { cols: 1, rows: 1, tiles: 1 });
    assert.deep(gridLayout(2), { cols: 2, rows: 1, tiles: 2 });
    assert.deep(gridLayout(3), { cols: 2, rows: 2, tiles: 3 });
    assert.deep(gridLayout(4), { cols: 2, rows: 2, tiles: 4 });
    assert.deep(gridLayout(6), { cols: 3, rows: 2, tiles: 6 });
    assert.eq(gridLayout(8).cols, 3);
  });
  it('a nonsense tile count still yields a drawable grid', () => {
    [0, -3, null, undefined, NaN, 'x'].forEach(v => {
      const g = gridLayout(v);
      assert.ok(g.cols >= 1 && g.rows >= 1, String(v));
    });
  });
  it('speaking rises fast and falls slow instead of strobing', () => {
    let s = { on: false, since: 0 };
    s = speakingNext(s, 0.2, 1000); assert.not(s.on, 'not instant');
    s = speakingNext(s, 0.2, 1050); assert.not(s.on, 'still inside the 120ms rise');
    s = speakingNext(s, 0.2, 1200); assert.ok(s.on, 'on after 120ms of level');
    s = speakingNext(s, 0.0, 1300); assert.ok(s.on, 'a gap between words does not turn it off');
    s = speakingNext(s, 0.0, 1500); assert.ok(s.on);
    s = speakingNext(s, 0.2, 1600); assert.ok(s.on, 'talking again cancels the fall');
    s = speakingNext(s, 0.0, 2000);
    s = speakingNext(s, 0.0, 2800); assert.not(s.on, 'off after 700ms of silence');
  });
  it('a level between the two thresholds changes nothing (hysteresis)', () => {
    const mid = (SPEAK_ON + SPEAK_OFF) / 2;
    const before = { on: true, since: 500, pending: null };
    assert.deep(speakingNext(before, mid, 9999), before);
  });
  it('quality steps down on loss and back up when it clears', () => {
    let q = qualityStep(0, { lossRate: 0.09 });
    assert.eq(q.level, 1);
    q = qualityStep(q.level, { lossRate: 0.09 });
    assert.eq(q.level, 2);
    q = qualityStep(q.level, { lossRate: 0.001, available: 9e6 });
    assert.eq(q.level, 1);
  });
  it('quality cannot walk off either end of the ladder', () => {
    assert.eq(qualityStep(0, { lossRate: 0 }).level, 0);
    assert.eq(qualityStep(BITRATE_STEPS.length - 1, { lossRate: 0.5 }).level, BITRATE_STEPS.length - 1);
    assert.eq(qualityStep(99, { lossRate: 0.5 }).level, BITRATE_STEPS.length - 1);
    assert.eq(qualityStep(-5, { lossRate: 0 }).level, 0);
  });
  it('a shared screen is capped but never downscaled', () => {
    const q = qualityStep(4, { lossRate: 0.2, sharing: true });
    assert.eq(q.scaleResolutionDownBy, 1);
    assert.ok(q.maxBitrate >= 800e3);
  });
  it('declining a DM ends the call; declining a group ring does not', () => {
    assert.ok(declineEndsCall(2, null));
    assert.not(declineEndsCall(5, null));
    assert.not(declineEndsCall(2, '2026-09-16T10:00:00Z'), 'an answered call is not declined');
  });
  it('the ring gives up at 45s, and a dead tab is stale at 75s', () => {
    const t0 = Date.parse('2026-09-16T10:00:00Z');
    assert.not(ringTimedOut(t0, t0 + RING_TIMEOUT_MS - 1));
    assert.ok(ringTimedOut(t0, t0 + RING_TIMEOUT_MS));
    assert.not(isStale(t0, t0 + 70_000));
    assert.ok(isStale(t0, t0 + 80_000));
  });
  it('durText pads seconds and never goes negative', () => {
    assert.eq(durText(0), '0:00');
    assert.eq(durText(9), '0:09');
    assert.eq(durText(60), '1:00');
    assert.eq(durText(3599), '59:59');
    assert.eq(durText(-5), '0:00');
    assert.eq(durText('83'), '1:23');
    assert.eq(durText(undefined), '0:00');
  });
});

/* ── invalid inputs ─────────────────────────────────────────────── */
describe('call: invalid input', () => {
  it('an unknown call kind is treated as audio rather than crashing', () => {
    assert.eq(capacityFor('hologram'), 6);
    assert.eq(capacityFor(undefined), 6);
    assert.eq(capacityFor(null), 6);
  });
  it('the roster reducer ignores rows with no user', () => {
    const r = rosterReduce(new Map(), { type: 'upsert', row: { muted: true } });
    assert.eq(r.size, 0);
    assert.eq(rosterReduce(new Map(), null).size, 0);
    assert.eq(rosterReduce(new Map(), { type: 'upsert' }).size, 0);
  });
  it('a delete for someone who was never there is harmless', () => {
    const r = rosterReduce(rosterOf(p('a')), { type: 'remove', row: { user_id: 'zz' } });
    assert.eq(r.size, 1);
  });
  it('the reducer never mutates the map it was given', () => {
    const before = rosterOf(p('a'));
    const after = rosterReduce(before, { type: 'upsert', row: p('b') });
    assert.eq(before.size, 1);
    assert.eq(after.size, 2);
  });
  it('a signal payload that is not an object is rejected', () => {
    [null, undefined, 'offer', 42, [], true].forEach(v => assert.not(validSignal(v), String(v)));
  });
  it('an unknown signal type is rejected', () => {
    assert.not(validSignal({ type: 'exec' }));
    assert.not(validSignal({ type: '' }));
    assert.not(validSignal({}));
  });
  it('an offer with no SDP, or SDP of the wrong type, is rejected', () => {
    assert.not(validSignal({ type: 'offer' }));
    assert.not(validSignal({ type: 'offer', sdp: 'v=0' }));
    assert.not(validSignal({ type: 'offer', sdp: { type: 'answer', sdp: 'v=0\r\n' } }));
    assert.not(validSignal({ type: 'offer', sdp: { type: 'offer', sdp: 'not sdp' } }));
    assert.ok(validSignal({ type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' } }));
  });
  it('an ICE candidate with no candidate string is rejected', () => {
    assert.not(validSignal({ type: 'ice' }));
    assert.not(validSignal({ type: 'ice', candidate: {} }));
    assert.ok(validSignal({ type: 'ice', candidate: { candidate: 'candidate:1 1 UDP 1 1.2.3.4 1 typ host' } }));
  });
  it('bye and ready need nothing else', () => {
    assert.ok(validSignal({ type: 'bye' }));
    assert.ok(validSignal({ type: 'ready' }));
  });
});

/* ── security cases ─────────────────────────────────────────────── */
describe('call: security', () => {
  const members = new Set(['me', 'a', 'b', 'stranger-in-chat']);
  const roster = rosterOf(p('me'), p('a'), p('b'));
  const base = { meId: 'me', roster, chatMemberIds: members, inCall: true };
  const sig = (over = {}) => ({ sender_id: 'a', target_id: 'me', payload: { type: 'ice', candidate: { candidate: 'x' } }, ...over });

  it('a normal signal from a participant is accepted', () => {
    assert.ok(signalAccepted(sig(), base).ok);
  });
  it('a signal addressed to somebody else is dropped', () => {
    const r = signalAccepted(sig({ target_id: 'b' }), base);
    assert.not(r.ok);
    assert.match(r.reason, /addressed elsewhere/);
  });
  it('a broadcast signal (no target) is still accepted', () => {
    assert.ok(signalAccepted(sig({ target_id: null }), base).ok);
  });
  it('our own signal echoing back is ignored', () => {
    assert.not(signalAccepted(sig({ sender_id: 'me' }), base).ok);
  });
  it('a chat member who is not in the call cannot renegotiate a live call', () => {
    // The whole point: call_signals is insertable by any chat member, so an
    // ICE/answer from a non-participant must never reach a peer connection.
    const r = signalAccepted(sig({ sender_id: 'stranger-in-chat' }), base);
    assert.not(r.ok);
    assert.match(r.reason, /not in this call/);
  });
  it('but a first offer from a not-yet-rostered member is allowed (the join race)', () => {
    const offer = sig({ sender_id: 'stranger-in-chat', payload: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } } });
    assert.ok(signalAccepted(offer, base).ok);
  });
  it('somebody outside the chat entirely is dropped even with a perfect offer', () => {
    const offer = sig({ sender_id: 'outsider', payload: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } } });
    const r = signalAccepted(offer, base);
    assert.not(r.ok);
    assert.match(r.reason, /not in this chat/);
  });
  it('signals are ignored entirely when we are not in a call', () => {
    assert.not(signalAccepted(sig(), { ...base, inCall: false }).ok);
  });
  it('a malformed payload from a real participant is still dropped', () => {
    assert.not(signalAccepted(sig({ payload: { type: 'offer' } }), base).ok);
    assert.not(signalAccepted(sig({ payload: { type: 'drop table' } }), base).ok);
  });
  it('an oversized payload is dropped instead of being parsed', () => {
    const huge = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' + 'a'.repeat(70_000) } };
    assert.not(validSignal(huge));
    assert.not(signalAccepted(sig({ payload: huge }), base).ok);
  });
  it('a payload with a prototype-polluting key is not special-cased into acceptance', () => {
    assert.not(validSignal(JSON.parse('{"__proto__":{"type":"offer"}}')));
  });
  it('capacity is enforced on the shape of the data, not on trust in the caller', () => {
    // join_call() in SQL is the real gate; this asserts the client agrees so it
    // cannot show a 7th tile that the server refused.
    const full = rosterOf(...['a', 'b', 'c', 'd', 'e', 'f'].map(id => p(id)));
    assert.not(canJoin({ kind: 'audio', roster: full, meId: 'g' }).ok);
    assert.eq(liveCount(full), capacityFor('audio'));
  });
});
