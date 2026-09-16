// Chat lock — every rule from js/lockcore.js, including the ones that exist
// only because the old implementation leaked.
import { describe, it, assert } from './harness.js';
import {
  cooldownFor, validatePin, previewFor, notifyPayload, needsGate, relockDue,
  expiredUnlocks, visibleInList, searchableUnlocked, attemptMessage, countdownText,
  RELOCK_MODES, MAX_ATTEMPTS,
} from '../js/lockcore.js';

const chat = (over = {}) => ({
  chat_id: 'c1', name: 'Mercy', locked: false, lock_hide_preview: true,
  lock_hide_in_list: false, lock_relock: 'session', last_body: 'see you at 6',
  last_kind: 'text', e2ee: false, ...over,
});

/* ── normal cases ───────────────────────────────────────────────── */
describe('lock: normal', () => {
  it('a good PIN is accepted', () => {
    assert.ok(validatePin('4820').ok);
    assert.ok(validatePin('80571').ok);
    assert.ok(validatePin('49182736').ok);
  });
  it('an unlocked chat shows its real preview', () => {
    assert.eq(previewFor(chat()), 'see you at 6');
  });
  it('a locked chat shows one fixed string and never the text', () => {
    assert.eq(previewFor(chat({ locked: true })), 'Locked chat');
    assert.eq(previewFor(chat({ locked: true, last_body: 'the transfer went through' })), 'Locked chat');
  });
  it('an unlocked-this-session locked chat shows its preview again', () => {
    assert.eq(previewFor(chat({ locked: true }), { unlocked: true }), 'see you at 6');
  });
  it('gate opens once unlocked and stays open for a session lock', () => {
    const c = chat({ locked: true, lock_relock: 'session' });
    assert.ok(needsGate(c, null));
    assert.ok(needsGate(c, undefined));
    assert.not(needsGate(c, 0, 5000), 'epoch 0 is a real timestamp, not "never unlocked"');
    assert.not(needsGate(c, 1000, 1000 + 60 * 60 * 1000));
  });
  it('a chat with no lock never gates', () => {
    assert.not(needsGate(chat(), null));
  });
  it('relock modes are exactly the four the SQL check constraint allows', () => {
    assert.deep(RELOCK_MODES, ['immediate', '1m', '15m', 'session']);
  });
});

/* ── edge cases ────────────────────────────────────────────────── */
describe('lock: edges', () => {
  it('kind words stand in for an attachment with no caption', () => {
    assert.eq(previewFor(chat({ last_body: null, last_kind: 'voice' })), 'Voice note');
    assert.eq(previewFor(chat({ last_body: null, last_kind: 'poll' })), 'Poll');
  });
  it('an empty chat says so', () => {
    assert.eq(previewFor(chat({ last_body: null, last_kind: null })), 'No messages yet');
  });
  it('e2ee with no plaintext is reported as encrypted, not as empty', () => {
    assert.eq(previewFor(chat({ e2ee: true, last_body: null })), 'Encrypted message');
  });
  it('locked wins over encrypted', () => {
    assert.eq(previewFor(chat({ locked: true, e2ee: true, last_body: null })), 'Locked chat');
  });
  it('immediate relock only fires once you are actually away', () => {
    assert.not(relockDue('immediate', 1000, 1001, { away: false }));
    assert.ok(relockDue('immediate', 1000, 1001, { away: true }));
  });
  it('1m relock fires at 60s, not at 59', () => {
    assert.not(relockDue('1m', 0, 59_999));
    assert.ok(relockDue('1m', 0, 60_000));
  });
  it('15m relock fires at 900s', () => {
    assert.not(relockDue('15m', 0, 899_000));
    assert.ok(relockDue('15m', 0, 900_000));
  });
  it('never-unlocked always relocks, whatever the mode', () => {
    RELOCK_MODES.forEach(m => assert.ok(relockDue(m, null, 0), m));
  });
  it('an unknown relock mode degrades to session rather than to "never lock"', () => {
    assert.not(relockDue('banana', 1000, 999_999_999));
    assert.ok(needsGate(chat({ locked: true, lock_relock: 'banana' }), null));
  });
  it('the sweep forgets exactly the chats whose policy expired', () => {
    const chats = new Map([
      ['a', chat({ chat_id: 'a', locked: true, lock_relock: '1m' })],
      ['b', chat({ chat_id: 'b', locked: true, lock_relock: 'session' })],
      ['c', chat({ chat_id: 'c', locked: false })],
      ['d', chat({ chat_id: 'd', locked: true, lock_relock: 'immediate' })],
    ]);
    const unlocked = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 0]]);
    assert.deep(expiredUnlocks(unlocked, chats, 61_000, { away: false }).sort(), ['a', 'c']);
    assert.deep(expiredUnlocks(unlocked, chats, 1_000, { away: true }).sort(), ['c', 'd']);
  });
  it('a chat that vanished from the list is left alone rather than crashing the sweep', () => {
    const out = expiredUnlocks(new Map([['gone', 0]]), new Map(), 10_000);
    assert.deep(out, []);
  });
  it('hide-in-list keeps a locked chat out of every tab but Locked', () => {
    const c = chat({ locked: true, lock_hide_in_list: true });
    assert.not(visibleInList(c, { folder: null }));
    assert.not(visibleInList(c, { folder: 'unread' }));
    assert.ok(visibleInList(c, { folder: 'locked' }));
  });
  it('the Locked tab only ever holds locked chats', () => {
    assert.not(visibleInList(chat(), { folder: 'locked' }));
  });
  it('countdown text reads as time, not as a number of seconds', () => {
    assert.eq(countdownText(30), '30s');
    assert.eq(countdownText(59.2), '1:00');
    assert.eq(countdownText(90), '1:30');
    assert.eq(countdownText(900), '15:00');
  });
});

/* ── invalid inputs ─────────────────────────────────────────────── */
describe('lock: invalid input', () => {
  it('a short PIN is refused', () => {
    assert.not(validatePin('123').ok);
    assert.match(validatePin('12').reason, /4 to 8/);
  });
  it('a long PIN is refused', () => assert.not(validatePin('123456789').ok));
  it('letters, spaces and symbols are refused', () => {
    ['12a4', '12 4', '', '  ', '1.23', '+1234', '\u0664\u0665\u0666\u0667'].forEach(v =>
      assert.not(validatePin(v).ok, `should reject ${JSON.stringify(v)}`));
  });
  it('null and undefined are refused, not treated as "no lock"', () => {
    assert.not(validatePin(null).ok);
    assert.not(validatePin(undefined).ok);
  });
  it('repeated digits are refused', () => {
    ['0000', '1111', '999999'].forEach(v => assert.not(validatePin(v).ok, v));
  });
  it('runs are refused in both directions', () => {
    ['1234', '4321', '3456', '9876', '01234567'].forEach(v => assert.not(validatePin(v).ok, v));
  });
  it('a number is coerced, not crashed on', () => {
    assert.ok(validatePin(4820).ok);
  });
  it('previewFor survives a missing chat object', () => {
    assert.eq(previewFor(null), 'No messages yet');
    assert.eq(previewFor(undefined), 'No messages yet');
  });
  it('attemptMessage survives a null response', () => {
    assert.match(attemptMessage(null), /Could not check/);
  });
});

/* ── security cases ─────────────────────────────────────────────── */
describe('lock: security', () => {
  it('the cooldown ladder matches chat_lock_cooldown() in the migration exactly', () => {
    const table = [[0, 0], [1, 0], [4, 0], [5, 30], [6, 60], [7, 300], [8, 900], [40, 900]];
    table.forEach(([fails, secs]) => assert.eq(cooldownFor(fails), secs, `fails=${fails}`));
  });
  it('five wrong PINs is where the cooldown starts, and MAX_ATTEMPTS says so', () => {
    assert.eq(MAX_ATTEMPTS, 5);
    assert.eq(cooldownFor(MAX_ATTEMPTS), 30);
    assert.eq(cooldownFor(MAX_ATTEMPTS - 1), 0);
  });
  it('brute forcing 4 digits is not a coffee break: 10k guesses costs days', () => {
    // 5 free guesses, then 30/60/300/900s and 900s forever after.
    let seconds = 0;
    for (let f = 1; f <= 10_000; f++) seconds += cooldownFor(f);
    assert.ok(seconds / 86_400 > 100, `expected > 100 days, got ${(seconds / 86400).toFixed(1)}`);
  });
  it('a notification for a locked chat carries neither sender nor text', () => {
    const p = notifyPayload(chat({ locked: true, name: 'Mercy' }), { body: 'the transfer went through' }, 'full');
    assert.eq(p.title, 'Wisp');
    assert.eq(p.body, 'Message in a locked chat');
    assert.ok(p.redacted);
  });
  it('a locked chat overrides even the most permissive preview setting', () => {
    ['full', 'sender_only', 'hidden'].forEach(mode => {
      const p = notifyPayload(chat({ locked: true }), { body: 'secret' }, mode);
      assert.not(/secret|Mercy/.test(p.title + p.body), mode);
    });
  });
  it('an unlocked chat still honours the account preview setting', () => {
    assert.eq(notifyPayload(chat(), { body: 'hi' }, 'full').body, 'hi');
    assert.eq(notifyPayload(chat(), { body: 'hi' }, 'sender_only').body, 'New message');
    assert.eq(notifyPayload(chat(), { body: 'hi' }, 'hidden').title, 'Wisp');
  });
  it('search never asks the server for a locked chat it has not unlocked', () => {
    const chats = [
      chat({ chat_id: 'a', locked: true }),
      chat({ chat_id: 'b', locked: true }),
      chat({ chat_id: 'c', locked: false }),
    ];
    assert.deep(searchableUnlocked(chats, new Set(['a'])), ['a']);
    assert.deep(searchableUnlocked(chats, new Set()), []);
    assert.deep(searchableUnlocked(chats, new Set(['a', 'b', 'c'])).sort(), ['a', 'b']);
  });
  it('a wrong PIN says how many tries are left, and a cooldown says how long', () => {
    assert.match(attemptMessage({ ok: false, attempts_left: 2, wait_seconds: 0 }), /2 tries left/);
    assert.match(attemptMessage({ ok: false, attempts_left: 1, wait_seconds: 0 }), /1 try left/);
    assert.match(attemptMessage({ ok: false, attempts_left: 0, wait_seconds: 30 }), /30s/);
    assert.match(attemptMessage({ ok: false, attempts_left: 0, wait_seconds: 900 }), /15m 00s/);
  });
  it('a successful unlock says nothing at all', () => {
    assert.eq(attemptMessage({ ok: true }), '');
  });
  it('hide_preview off is a choice about the list, never about notifications', () => {
    const c = chat({ locked: true, lock_hide_preview: false });
    assert.eq(previewFor(c), 'see you at 6');
    assert.eq(notifyPayload(c, { body: 'secret' }, 'full').body, 'Message in a locked chat');
  });
});
