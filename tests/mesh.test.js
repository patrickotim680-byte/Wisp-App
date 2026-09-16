// A simulated room. Three or four virtual clients run the same rules calls.js
// runs — roster reducer, peerRole, syncPeers, signalAccepted — over a fake
// signal bus, so the mesh can be checked for the things that were actually
// broken before: pairs that never connect, pairs that connect twice, offers
// from both ends at once, and a peer that lingers after its owner leaves.
//
// Honest about what it is: this exercises callcore.js and the algorithm around
// it, not RTCPeerConnection. Whether Chrome and Safari actually exchange media
// is what the manual pass in docs/TEST-PLAN.md is for.
import { describe, it, assert } from './harness.js';
import { rosterReduce, liveIds, peerRole, signalAccepted, canJoin, gridLayout } from '../js/callcore.js';

class Room {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.rows = new Map();      // the server's call_participants
    this.clients = new Map();
    this.bus = [];              // call_signals, in insert order
    this.t = 1000;
  }
  memberIds() { return new Set([...this.clients.keys(), 'lurker']); }
  join(id) {
    this.t += 1000;
    this.rows.set(id, { user_id: id, joined_at: this.t, left_at: null });
    const c = new Client(id, this);
    this.clients.set(id, c);
    // join_call() hands the joiner the whole roster back (calls.js then calls
    // refreshRoster()), so seed it before anyone else hears about the join —
    // otherwise the newcomer knows only about itself and meshes with nobody,
    // which is precisely the shape of the bug this file is here to catch.
    this.rows.forEach(r => c.onParticipant({ ...r }, false));
    c.sync();   // one pass over the whole roster, the way enter() does it
    // then the realtime fan-out: every other client sees one new row
    this.clients.forEach(x => { if (x.id !== id) x.onParticipant({ ...this.rows.get(id) }); });
    return c;
  }
  leave(id) {
    this.t += 1000;
    const row = { ...this.rows.get(id), left_at: this.t };
    this.rows.set(id, row);
    const gone = this.clients.get(id);
    this.clients.delete(id);
    gone?.peers.clear();
    this.clients.forEach(x => x.onParticipant({ ...row }));
  }
  post(signal) {
    this.bus.push(signal);
    this.clients.forEach(c => { if (c.id !== signal.sender_id) c.onSignal(signal); });
  }
}

class Client {
  constructor(id, room) {
    this.id = id;
    this.room = room;
    this.roster = new Map();
    this.peers = new Map();     // other_id -> { offersSent, answersSent, polite, initiator, state }
    this.dropped = [];
  }
  onParticipant(row, sync = true) {
    this.roster = rosterReduce(this.roster, { type: 'upsert', row });
    // The real client seeds the whole roster from join_call()'s reply and syncs
    // once (enter -> refreshRoster -> syncPeers); incremental realtime rows sync
    // as they land. Both paths matter, so both are simulated.
    if (sync) this.sync();
  }
  sync() {
    const ids = liveIds(this.roster, this.id);
    ids.forEach(other => {
      if (this.peers.has(other)) return;
      const role = peerRole(this.id, other, {
        myJoinedAt: this.roster.get(this.id)?.joined_at || 0,
        theirJoinedAt: this.roster.get(other)?.joined_at || 0,
      });
      const peer = { ...role, offersSent: 0, answersSent: 0, state: 'new', ice: 0 };
      this.peers.set(other, peer);
      // onnegotiationneeded: adding local tracks fires it on both ends. The
      // incumbent yields the first offer to the newcomer.
      if (role.initiator) this.offer(other);
    });
    [...this.peers.keys()].forEach(other => {
      if (!ids.includes(other)) { this.peers.delete(other); this.dropped.push(other); }
    });
  }
  offer(other) {
    const p = this.peers.get(other);
    p.offersSent++;
    p.state = 'have-local-offer';
    this.room.post({ sender_id: this.id, target_id: other, payload: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } } });
  }
  onSignal(s) {
    const verdict = signalAccepted(s, {
      meId: this.id, roster: this.roster, chatMemberIds: this.room.memberIds(), inCall: true,
    });
    if (!verdict.ok) { this.dropped.push(`signal:${verdict.reason}`); return; }
    const from = s.sender_id;
    let p = this.peers.get(from);
    if (!p && s.payload.type === 'offer') {
      const role = peerRole(this.id, from, {
        myJoinedAt: this.roster.get(this.id)?.joined_at || 0,
        theirJoinedAt: this.roster.get(from)?.joined_at || 0,
      });
      p = { ...role, offersSent: 0, answersSent: 0, state: 'new', ice: 0 };
      this.peers.set(from, p);
    }
    if (!p) return;
    if (s.payload.type === 'offer') {
      const collision = p.state === 'have-local-offer';
      if (!p.polite && collision) { p.ignored = true; return; }   // impolite keeps its own
      p.answersSent++;
      p.state = 'stable';
      this.room.post({ sender_id: this.id, target_id: from, payload: { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\n' } } });
    } else if (s.payload.type === 'answer') {
      p.state = 'stable';
    }
  }
}

const pairsOf = room => {
  const out = [];
  room.clients.forEach(c => c.peers.forEach((_, other) => out.push([c.id, other].sort().join('~'))));
  return out;
};

describe('mesh: three people', () => {
  const room = new Room('audio');
  const a = room.join('aaa');
  const b = room.join('bbb');
  const c = room.join('ccc');

  it('every pair exists on both sides', () => {
    assert.deep([...a.peers.keys()].sort(), ['bbb', 'ccc']);
    assert.deep([...b.peers.keys()].sort(), ['aaa', 'ccc']);
    assert.deep([...c.peers.keys()].sort(), ['aaa', 'bbb']);
  });
  it('callee-to-callee is connected, which is the bug this replaced', () => {
    assert.ok(b.peers.has('ccc') && c.peers.has('bbb'));
    assert.eq(b.peers.get('ccc').state, 'stable');
    assert.eq(c.peers.get('bbb').state, 'stable');
  });
  it('there are exactly three pairs, counted twice, and no duplicates', () => {
    const pairs = pairsOf(room);
    assert.eq(pairs.length, 6);
    assert.eq(new Set(pairs).size, 3);
  });
  it('exactly one offer per pair: the newcomer offers, the incumbent answers', () => {
    const offers = [...room.bus].filter(s => s.payload.type === 'offer');
    assert.eq(offers.length, 3, 'one offer per pair, no glare');
    assert.deep(offers.map(o => `${o.sender_id}->${o.target_id}`).sort(),
      ['bbb->aaa', 'ccc->aaa', 'ccc->bbb']);
  });
  it('every offer got exactly one answer', () => {
    assert.eq(room.bus.filter(s => s.payload.type === 'answer').length, 3);
  });
  it('everyone reaches a stable state', () => {
    room.clients.forEach(cl => cl.peers.forEach(p => assert.eq(p.state, 'stable', cl.id)));
  });
  it('the grid each client draws matches the people it can see', () => {
    assert.eq(gridLayout(liveIds(a.roster, 'aaa').length).cols, 2);
  });
});

describe('mesh: joining late and leaving', () => {
  it('a fourth person meshes with all three, and only they offer', () => {
    const room = new Room('audio');
    room.join('aaa'); room.join('bbb'); room.join('ccc');
    const before = room.bus.length;
    const d = room.join('ddd');
    assert.deep([...d.peers.keys()].sort(), ['aaa', 'bbb', 'ccc']);
    const fresh = room.bus.slice(before).filter(s => s.payload.type === 'offer');
    assert.eq(fresh.length, 3);
    fresh.forEach(o => assert.eq(o.sender_id, 'ddd', 'the newcomer is the one who offers'));
    room.clients.forEach(c => { if (c.id !== 'ddd') assert.ok(c.peers.has('ddd'), c.id); });
  });
  it('someone leaving takes only their own peer with them', () => {
    const room = new Room('audio');
    const a = room.join('aaa'); const b = room.join('bbb'); room.join('ccc');
    room.leave('ccc');
    assert.deep([...a.peers.keys()], ['bbb']);
    assert.deep([...b.peers.keys()], ['aaa']);
    assert.ok(a.dropped.includes('ccc'));
    assert.eq(a.peers.get('bbb').state, 'stable', 'the surviving pair is untouched');
  });
  it('rejoining after leaving rebuilds exactly one peer per pair', () => {
    const room = new Room('audio');
    const a = room.join('aaa'); room.join('bbb');
    room.leave('bbb');
    const b2 = room.join('bbb');
    assert.deep([...a.peers.keys()], ['bbb']);
    assert.deep([...b2.peers.keys()], ['aaa']);
    assert.eq(new Set(pairsOf(room)).size, 1);
  });
  it('a room fills up and then refuses, per kind', () => {
    const room = new Room('video');
    ['a', 'b', 'c', 'd'].forEach(id => room.join(id));
    const rosterView = room.clients.get('a').roster;
    assert.not(canJoin({ kind: 'video', roster: rosterView, meId: 'e' }).ok);
    assert.ok(canJoin({ kind: 'audio', roster: rosterView, meId: 'e' }).ok, 'audio has more room');
  });
});

describe('mesh: hostile signals', () => {
  it('a chat member who is not in the call cannot answer into it', () => {
    const room = new Room('audio');
    const a = room.join('aaa'); room.join('bbb');
    const before = JSON.stringify([...a.peers]);
    room.post({ sender_id: 'lurker', target_id: 'aaa', payload: { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\n' } } });
    assert.eq(JSON.stringify([...a.peers]), before, 'nothing changed');
    assert.ok(a.dropped.some(d => String(d).startsWith('signal:')));
  });
  it('a signal for somebody else is ignored by everyone it was not for', () => {
    const room = new Room('audio');
    const a = room.join('aaa'); const b = room.join('bbb'); room.join('ccc');
    const beforeA = a.dropped.length, beforeB = b.dropped.length;
    room.post({ sender_id: 'bbb', target_id: 'ccc', payload: { type: 'ice', candidate: { candidate: 'x' } } });
    assert.eq(a.dropped[a.dropped.length - 1], 'signal:addressed elsewhere');
    assert.ok(a.dropped.length > beforeA);
    assert.eq(b.dropped.length, beforeB, 'the sender never processes its own signal');
  });
  it('junk payloads never reach a peer', () => {
    const room = new Room('audio');
    const a = room.join('aaa'); room.join('bbb');
    [{ type: 'offer' }, { type: 'exec', cmd: 'rm' }, null, 'offer'].forEach(payload =>
      room.post({ sender_id: 'bbb', target_id: 'aaa', payload }));
    assert.ok(a.dropped.filter(d => d === 'signal:malformed payload').length >= 3);
  });
});
