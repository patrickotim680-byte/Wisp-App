const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const HERE = __dirname, REPO = process.env.WISP_REPO || path.resolve(HERE, '../..');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };
const callBlock = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8').match(/<div id="call" class="call" hidden>[\s\S]*?\n<\/div>\n/)[0];
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/call.css"></head><body>
<button id="btn-call-audio"></button><button id="btn-call-video"></button>${callBlock}
<div id="toasts" class="toasts"></div><dialog id="modal"><div id="modal-body"></div></dialog>
<script type="module">import { S } from '/js/state.js'; import * as calls from '/js/calls.js'; window.__S = S; window.__calls = calls; calls.mountCalls(); window.__ready = true;</script></body></html>`;
const OVERRIDE = { '/js/db.js': 'dbstub.js', '/js/notify.js': 'notifystub.js', };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS); }
  const file = OVERRIDE[url] ? path.join(HERE, OVERRIDE[url]) : path.join(REPO, url);
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Node plays Supabase: tables, ids, and a delayed, ordered "Realtime" per page. */
class Bus {
  constructor() { this.nextId = 1; this.signals = []; this.calls = new Map(); this.msgs = []; this.users = new Map(); this.dropLiveTo = new Set(); }
  add(id, page) { this.users.set(id, { page, chain: Promise.resolve() }); }
  push(uid, table, row) {
    const u = this.users.get(uid);
    u.chain = u.chain.then(async () => { await sleep(35); await u.page.evaluate(([t, r]) => window.__deliver(t, r), [table, row]); }).catch(() => {});
  }
  visible(uid, s) { return s.target_id == null || s.target_id === uid || s.sender_id === uid; }
  ins(me, t, row) {
    if (t === 'calls') { row = { id: 'call-' + this.nextId++, started_at: new Date().toISOString(), state: 'ringing', ...row }; this.calls.set(row.id, row); for (const u of this.users.keys()) if (u !== me) this.push(u, 'calls', row); }
    else if (t === 'call_signals') {
      row = { id: this.nextId++, created_at: new Date().toISOString(), ...row }; this.signals.push(row);
      for (const u of this.users.keys()) if (u !== me && this.visible(u, row) && !this.dropLiveTo.has(u)) this.push(u, 'call_signals', row);
    } else if (t === 'messages') { row = { id: 'm' + this.nextId++, ...row }; this.msgs.push(row); }
    return [row];
  }
  upd(t, patch, match) { if (t === 'calls') { const c = this.calls.get(match.id); if (c) Object.assign(c, patch); } }
  sel(me, t, b) { return t === 'call_signals' ? this.signals.filter(s => s.call_id === b.eq.call_id && this.visible(me, s)).sort((a, b) => a.id - b.id) : []; }
}

async function scenario(name, browser, { users, type = 'group', kind = 'video' }, fn) {
  console.log(`\n■ ${name}`);
  const bus = new Bus();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(() => {
    window.__pcs = [];
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(T, a) { const pc = new T(...a); window.__pcs.push(pc); return pc; } });
  });
  const errors = [];
  const pages = {};
  const chat = { chat_id: 'chat1', name: type === 'dm' ? null : 'Team', type, icon_url: null };
  const people = users.map(u => ({ id: u, display_name: 'User ' + u, photo_url: null }));
  for (const u of users) {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${u}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') errors.push(`${u} [${m.type()}] ${m.text().slice(0, 140)}`); });
    await page.exposeFunction('__ins', (t, r) => bus.ins(u, t, r));
    await page.exposeFunction('__upd', (t, p, m) => bus.upd(t, p, m));
    await page.exposeFunction('__sel', (t, b) => bus.sel(u, t, b));
    await page.goto(`http://localhost:${server.address().port}/harness.html`);
    await page.waitForFunction(() => window.__ready);
    await page.evaluate(([me, chat, users, people]) => {
      const S = window.__S;
      S.me = { id: me }; S.chat = chat; S.chats = [chat];
      S.members = users.map(id => ({ user_id: id }));
      S.people = new Map(people.map(p => [p.id, p]));
    }, [u, chat, users, people]);
    bus.add(u, page); pages[u] = page;
  }
  const api = {
    bus, pages, errors,
    call: (u, k = kind) => pages[u].evaluate(k => window.__calls.startCall(k), k),
    accept: async u => { await pages[u].waitForSelector('#call-accept', { state: 'visible', timeout: 8000 }); await pages[u].evaluate(() => document.getElementById('call-accept').click()); },
    hang: u => pages[u].evaluate(() => document.getElementById('call-hang').click()),
    snap: u => pages[u].evaluate(() => ({
      n: document.getElementById('call-grid').dataset.n,
      multi: document.getElementById('call').classList.contains('multi'),
      hidden: document.getElementById('call').hidden,
      state: document.getElementById('call-state').textContent,
      tiles: [...document.querySelectorAll('#call-grid .tile')].map(t => { const v = t.querySelector('video'); return { uid: t.dataset.uid, hasVideo: t.classList.contains('has-video'), vw: v.videoWidth, tracks: (v.srcObject?.getTracks() || []).map(x => x.kind).sort().join('+'), name: t.querySelector('.tile-name').textContent }; }),
      pcs: window.__pcs.filter(p => p.connectionState !== 'closed').map(p => p.connectionState),
      toast: document.getElementById('toasts').textContent,
    })),
    until: async (label, u, pred, ms = 15000) => {
      const t0 = Date.now(); let s;
      while (Date.now() - t0 < ms) { s = await api.snap(u); if (pred(s)) return s; await sleep(250); }
      check(`${label} (timeout)`, false, JSON.stringify(s)); return s;
    },
    shot: (u, f) => pages[u].screenshot({ path: path.join(process.env.SHOTS || require('os').tmpdir(), f) }),
  };
  try { await fn(api); } catch (e) { check('scenario threw', false, e.stack); }
  if (errors.length) console.log('  console noise:', [...new Set(errors)].slice(0, 6));
  await ctx.close();
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });

  await scenario('S1  4-person video call: is it a real mesh?', browser, { users: ['A', 'B', 'C', 'D'] }, async t => {
    await t.call('A');
    await Promise.all(['B', 'C', 'D'].map(u => t.accept(u)));
    for (const u of ['A', 'B', 'C', 'D']) {
      const s = await t.until(`${u} reaches 3 connected links with video`, u, s => s.pcs.length === 3 && s.pcs.every(x => x === 'connected') && s.tiles.length === 3 && s.tiles.every(x => x.hasVideo && x.vw > 0));
      check(`${u}: 3 connected peer connections`, s.pcs.length === 3 && s.pcs.every(x => x === 'connected'), JSON.stringify(s.pcs));
      check(`${u}: 3 tiles, each with audio+video from a DIFFERENT person`, s.tiles.length === 3 && new Set(s.tiles.map(x => x.uid)).size === 3 && s.tiles.every(x => x.tracks === 'audio+video'), JSON.stringify(s.tiles));
      check(`${u}: grid laid out for 3 + multi class`, s.n === '3' && s.multi, `${s.n} ${s.multi}`);
    }
    const sb = await t.snap('B');
    check('B (an INVITEE) is connected to C and D, not just the caller', ['C', 'D'].every(x => sb.tiles.some(tl => tl.uid === x && tl.hasVideo)));
    check('header counts everyone', /4 in call/.test((await t.snap('A')).state), (await t.snap('A')).state);
    await sleep(1200); await t.shot('A', 'shot-4way.png');
    await t.hang('D');
    const a = await t.until('A drops to 2 tiles after D leaves', 'A', s => s.tiles.length === 2 && s.n === '2');
    check('call continues for A when one person leaves', !a.hidden && a.pcs.filter(x => x === 'connected').length === 2, JSON.stringify(a));
    check('D sees the call end', (await t.until('D hidden', 'D', s => s.hidden)).hidden);
    await sleep(900); await t.shot('A', 'shot-3way.png');
  });

  await scenario('S2  3-person call: leaving one by one', browser, { users: ['A', 'B', 'C'] }, async t => {
    await t.call('A'); await Promise.all(['B', 'C'].map(u => t.accept(u)));
    await t.until('all connected', 'C', s => s.pcs.length === 2 && s.pcs.every(x => x === 'connected') && s.tiles.every(x => x.hasVideo));
    await t.hang('B');
    const a = await t.until('A has 1 tile', 'A', s => s.tiles.length === 1 && s.n === '1');
    const c = await t.until('C has 1 tile', 'C', s => s.tiles.length === 1 && s.n === '1');
    check('A and C still in a live call (1:1 layout, not multi)', !a.hidden && !c.hidden && !a.multi && a.tiles[0].uid === 'C' && c.tiles[0].uid === 'A' && a.tiles[0].hasVideo);
    await t.hang('C');
    check('last person left: A\'s call ends', (await t.until('A hidden', 'A', s => s.hidden)).hidden);
    const row = [...t.bus.calls.values()][0];
    check('call row written once, by the caller, as ended', row.state === 'ended', row.state);
    check('exactly one call-log message in the group (not one per person)', t.bus.msgs.length <= 1, String(t.bus.msgs.length));
  });

  await scenario('S3  one invitee declines, the other still gets through', browser, { users: ['A', 'B', 'C'] }, async t => {
    await t.call('A');
    await t.pages.B.waitForSelector('#call-accept', { state: 'visible' }); await t.hang('B');
    const a = await t.until('A removes B\'s tile but keeps ringing', 'A', s => s.tiles.length === 1 && s.tiles[0].uid === 'C');
    check('A still in the call after one decline', !a.hidden);
    check('A told who declined', /User B declined/.test(a.toast), a.toast);
    await t.accept('C');
    const s = await t.until('A<->C connect', 'A', s => s.pcs.length === 1 && s.pcs[0] === 'connected' && s.tiles[0]?.hasVideo);
    check('A and C connected after B declined', s.pcs[0] === 'connected');
    const row = [...t.bus.calls.values()][0];
    check('B declining did NOT mark the whole call declined', row.state !== 'declined', row.state);
  });

  await scenario('S4  callee missed the live offer (subscribed too late)', browser, { users: ['A', 'B'], type: 'dm' }, async t => {
    t.bus.dropLiveTo.add('B');            // everything A signals before B accepts is "lost"
    await t.call('A');
    await t.pages.B.waitForSelector('#call-accept', { state: 'visible' });
    await sleep(800);
    t.bus.dropLiveTo.delete('B');
    await t.accept('B');
    const b = await t.until('B connects using the database catch-up', 'B', s => s.pcs.length === 1 && s.pcs[0] === 'connected' && s.tiles[0]?.hasVideo);
    check('call connects even though the live offer never arrived', b.pcs[0] === 'connected');
  });

  await scenario('S5  3-person VOICE call', browser, { users: ['A', 'B', 'C'], kind: 'audio' }, async t => {
    await t.call('A', 'audio'); await Promise.all(['B', 'C'].map(u => t.accept(u)));
    for (const u of ['A', 'B', 'C']) {
      const s = await t.until(`${u} connected to both`, u, s => s.pcs.length === 2 && s.pcs.every(x => x === 'connected') && s.tiles.length === 2);
      check(`${u}: two audio-only tiles, no video`, s.tiles.every(x => x.tracks === 'audio' && !x.hasVideo), JSON.stringify(s.tiles));
    }
    const pk = await t.pages.B.evaluate(async () => { let n = 0; for (const pc of window.__pcs) (await pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.packetsReceived; }); return n; });
    check('B actually receives audio packets (from both peers)', pk > 20, String(pk));
    let seen = false; for (let i = 0; i < 40 && !seen; i++) { seen = await t.pages.A.evaluate(() => !!document.querySelector('#call-grid .tile.speaking')); await sleep(250); }
    check('speaking ring appears on a tile when someone talks', seen);
    await t.shot('A', 'shot-audio3.png');
  });

  await scenario('S6  1:1 regression (a DM must behave exactly as before)', browser, { users: ['A', 'B'], type: 'dm' }, async t => {
    await t.call('A'); await t.accept('B');
    const a = await t.until('connected', 'A', s => s.pcs[0] === 'connected' && s.tiles[0]?.hasVideo);
    check('one full-bleed tile, no multi class, "Connected" label', a.n === '1' && !a.multi && a.state === 'Connected', JSON.stringify([a.n, a.multi, a.state]));
    await t.shot('A', 'shot-1to1.png');
    await t.hang('B');
    check('A\'s call ends when B hangs up', (await t.until('A hidden', 'A', s => s.hidden)).hidden);
    const row = [...t.bus.calls.values()][0];
    check('row ended with a duration', row.state === 'ended' && row.duration >= 0, JSON.stringify(row));
  });

  await scenario('S7  more than 4 people is refused cleanly', browser, { users: ['A', 'B', 'C', 'D', 'E'] }, async t => {
    await t.call('A');
    const s = await t.snap('A');
    check('no call started, overlay hidden', s.hidden && t.bus.calls.size === 0);
    check('user told why', /up to 4/.test(s.toast), s.toast);
  });

  await scenario('S8  hostile / invalid signals while a call is live', browser, { users: ['A', 'B', 'C'] }, async t => {
    await t.call('A'); await Promise.all(['B', 'C'].map(u => t.accept(u)));
    await t.until('connected', 'B', s => s.pcs.length === 2 && s.pcs.every(x => x === 'connected') && s.tiles.every(x => x.hasVideo));
    const before = await t.snap('B');
    const call_id = [...t.bus.calls.keys()][0];
    const inject = (row) => t.bus.push('B', 'call_signals', { id: t.bus.nextId++, call_id, created_at: '', ...row });
    inject({ sender_id: 'C', target_id: null, payload: null });                                         // null payload
    inject({ sender_id: 'C', target_id: null, payload: 'string' });                                     // wrong type
    inject({ sender_id: 'C', target_id: null, payload: { type: 42 } });                                 // type not a string
    inject({ sender_id: 'C', target_id: 'B', payload: { type: 'ice', candidates: 'garbage' } });         // candidates not an array
    inject({ sender_id: 'C', target_id: 'B', payload: { type: 'ice', candidates: [null, 5, {}] } });     // junk candidates
    inject({ sender_id: 'C', target_id: 'B', payload: { type: 'offer', sdp: 'not an sdp' } });            // unparseable offer from a real peer
    inject({ sender_id: 'C', target_id: 'B', payload: { type: 'answer', sdp: { type: 'answer', sdp: 'x' } } });
    inject({ sender_id: 'C', target_id: null, payload: { type: 'nonsense' } });                          // unknown type
    inject({ sender_id: 'Z', target_id: null, payload: { type: 'bye' } });                               // bye from someone never in the call
    inject({ sender_id: 'Z', target_id: 'B', payload: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });  // offer from a stranger
    inject({ sender_id: 'C', target_id: 'A', payload: { type: 'bye' } });                                // addressed to A, leaked to B: must be ignored
    inject({ sender_id: 'B', target_id: null, payload: { type: 'bye' } });                               // my own echo: must be ignored
    await sleep(2500);
    const after = await t.snap('B');
    check('B is still in the call', !after.hidden);
    check('B still has exactly its 2 real peers, all connected', after.pcs.filter(x => x === 'connected').length === 2, JSON.stringify(after.pcs));
    const real = after.tiles.filter(x => x.uid === 'A' || x.uid === 'C');
    check('no phantom tile for a stranger (Z) or for self (B)', after.tiles.every(x => ['A', 'C'].includes(x.uid)), JSON.stringify(after.tiles.map(x => x.uid)));
    check('both real tiles keep playing video', real.length === 2 && real.every(x => x.hasVideo), JSON.stringify(real));
    check('stranger\'s offer did not create a connection', after.pcs.length === before.pcs.length, `${before.pcs.length}->${after.pcs.length}`);
    // duplicate delivery of an already-seen row id is a no-op
    const dup = t.bus.signals.find(x => x.target_id === 'B' && x.payload.type === 'offer');
    if (dup) { t.bus.push('B', 'call_signals', dup); t.bus.push('B', 'call_signals', dup); await sleep(1200); check('duplicate rows are ignored', (await t.snap('B')).pcs.filter(x => x === 'connected').length === 2); }
  });

  await scenario('S9  caller disappears while callee is still ringing', browser, { users: ['A', 'B'], type: 'dm' }, async t => {
    await t.call('A');
    await t.pages.B.waitForSelector('#call-accept', { state: 'visible' });
    await t.hang('A');
    const b = await t.until('B stops ringing', 'B', s => s.hidden, 6000);
    check('callee ring is cancelled when the caller hangs up first', b.hidden);
    const row = [...t.bus.calls.values()][0];
    check('callee did not overwrite the row it never owned', row.state !== undefined && t.bus.msgs.filter(m => m.sender_id === 'B').length === 0);
  });

  console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail ? 1 : 0);
})();
