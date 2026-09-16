// Static checks over the actual files that ship. These are the tests that catch
// the class of bug you cannot unit test in a browserless sandbox: an import
// that does not exist, a $('#id') with no element behind it, an rpc() name that
// no migration defines, and the two places where a rule is written twice (once
// in JS, once in SQL) drifting apart.
import { describe, it, assert } from './harness.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cooldownFor, MAX_ATTEMPTS } from '../js/lockcore.js';
import { capacityFor } from '../js/callcore.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(path.join(root, p), 'utf8');
const jsFiles = readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js')).sort();
const html = read('index.html');
const css = read('lock-call.css');
const sqlFile = readdirSync(path.join(root, 'supabase/migrations'))
  .filter(f => f.endsWith('.sql')).sort().pop();
const sql = read(path.join('supabase/migrations', sqlFile));

/* Functions the base schema (supabase/schema.sql, already deployed) provides.
   Anything a shipped module calls has to be in here or in the migration. */
const BASE_RPCS = new Set([
  'get_or_create_dm', 'create_group', 'join_via_invite', 'reset_invite', 'leave_chat',
  'remove_member', 'set_member_role', 'mark_delivered', 'mark_read', 'edit_message',
  'delete_for_everyone', 'toggle_pin', 'mark_view_once_seen', 'clear_history',
  'forward_messages', 'search_messages', 'chat_digest', 'chat_overview', 'people_info',
  'search_people', 'heartbeat', 'go_offline', 'set_typing', 'block_user',
  'set_two_step_pin', 'verify_two_step_pin', 'set_chat_lock', 'verify_chat_lock',
  'set_disappearing', 'purge_expired_messages', 'dispatch_scheduled_messages',
  'export_my_data', 'delete_my_account', 'export_chat_text', 'shared_media',
  'unread_total', 'set_chat_e2ee',
]);

const exportsOf = src => {
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  const braces = /export\s*\{([^}]+)\}/g;
  while ((m = braces.exec(src))) {
    m[1].split(',').forEach(part => {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] || bits[0] || '').trim();
      if (name) names.add(name);
    });
  }
  return names;
};

const importsOf = src => {
  const out = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*'(\.\/[\w./-]+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ from: m[2], names });
  }
  return out;
};

/* ── the files parse at all ─────────────────────────────────────────── */
describe('static: syntax', () => {
  jsFiles.forEach(f => it(`js/${f} parses`, () => {
    execFileSync(process.execPath, ['--check', path.join(root, 'js', f)], { stdio: 'pipe' });
  }));
  it('the shipped modules are all present', () => {
    ['lockcore.js', 'callcore.js', 'chatlock.js', 'calls.js', 'chats.js', 'panels.js',
     'notify.js', 'app.js'].forEach(f => assert.ok(jsFiles.includes(f), f));
  });
});

/* ── imports resolve to real exports ─────────────────────────────────── */
describe('static: imports', () => {
  jsFiles.forEach(f => {
    const src = read(`js/${f}`);
    importsOf(src).forEach(imp => {
      const target = path.normalize(path.join('js', imp.from));
      if (!existsSync(path.join(root, target))) return;   // untouched module, not in this branch
      const exported = exportsOf(read(target));
      it(`js/${f} imports from ${imp.from} that exist`, () => {
        imp.names.forEach(n => assert.ok(exported.has(n), `${n} is not exported by ${imp.from}`));
      });
    });
  });

  it('no shipped module imports the other one in a way that makes a cycle at load time', () => {
    // chats.js <-> calls.js and chatlock.js <-> chats.js are deliberately
    // one-directional statically; the return trip is a dynamic import().
    const calls = read('js/calls.js');
    const lock = read('js/chatlock.js');
    assert.not(/^import .*from '\.\/chats\.js'/m.test(calls), 'calls.js must not statically import chats.js');
    assert.not(/^import .*from '\.\/chats\.js'/m.test(lock), 'chatlock.js must not statically import chats.js');
    assert.ok(/await import\('\.\/chats\.js'\)/.test(calls));
  });
});

/* ── every $('#id') has an element ───────────────────────────────────── */
describe('static: dom ids', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  // Created at runtime by util.js modal()/popMenu() or by the app itself.
  const RUNTIME_IDS = new Set(['fatal']);
  jsFiles.forEach(f => {
    const src = read(`js/${f}`);
    const used = new Set([...src.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));
    if (!used.size) return;
    it(`js/${f} only reaches for ids that exist in index.html`, () => {
      [...used].forEach(id => assert.ok(htmlIds.has(id) || RUNTIME_IDS.has(id), `#${id} is not in index.html`));
    });
  });
  it('the new call and lock markup is present', () => {
    ['call-grid', 'call-count', 'call-decline', 'call-banner', 'badge-live-call']
      .forEach(id => assert.ok(htmlIds.has(id), `#${id} missing`));
  });
  it('index.html loads the new stylesheet', () => {
    assert.match(html, /href="\/lock-call\.css"/);
  });
  it('the stylesheet still comes after call.css, which it overrides', () => {
    assert.ok(html.indexOf('/call.css') < html.indexOf('/lock-call.css'));
  });
});

/* ── every class the new code adds is actually styled ──────────────────── */
describe('static: styles', () => {
  const NEW_CLASSES = ['call-grid', 'call-tile', 'call-tile-face', 'call-tile-foot', 'call-tile-name',
    'call-tile-mute', 'call-count', 'join-banner', 'join-ico', 'join-text', 'pin-sheet', 'pin-badge',
    'pin-dots', 'pin-err', 'pin-pad', 'pin-key', 'pin-back', 'pin-ghost', 'row-join', 'row-lock',
    'is-speaking', 'is-cam-off', 'has-video', 'lock-note', 'is-live'];
  NEW_CLASSES.forEach(cls => it(`.${cls} is styled`, () => {
    assert.ok(css.includes('.' + cls), `.${cls} is used by the new code but has no rule`);
  }));
  it('the grid video rule is strong enough to beat the old #call-remote rule', () => {
    assert.match(css, /\.call-grid video[\s\S]*?position: static !important/);
  });
});

/* ── every rpc() has a function behind it ────────────────────────────── */
describe('static: rpc names', () => {
  const defined = new Set([...sql.matchAll(/create or replace function\s+([a-z_]+)\s*\(/g)].map(m => m[1]));
  jsFiles.forEach(f => {
    const src = read(`js/${f}`);
    const used = [...src.matchAll(/rpc\('([\w_]+)'/g)].map(m => m[1]);
    if (!used.length) return;
    it(`js/${f} only calls RPCs that exist`, () => {
      used.forEach(n => assert.ok(defined.has(n) || BASE_RPCS.has(n), `${n}() is called but never defined`));
    });
  });
  it('the migration defines everything the two new features need', () => {
    ['set_chat_lock', 'verify_chat_lock', 'reset_chat_lock', 'set_chat_lock_prefs',
     'chat_overview', 'search_messages', 'start_call', 'join_call', 'leave_call',
     'decline_call', 'end_call_for_all', 'call_heartbeat', 'call_roster', 'live_calls',
     'sweep_stale_calls', 'finalize_call', 'call_capacity', 'verify_account_password']
      .forEach(n => assert.ok(defined.has(n), `${n}() missing from the migration`));
  });
});

/* ── the migration is safe to paste ─────────────────────────────────── */
describe('static: migration', () => {
  it('dollar quotes are balanced', () => {
    assert.eq((sql.match(/\$fn\$/g) || []).length % 2, 0, '$fn$ blocks are unbalanced');
    assert.eq((sql.match(/\$do\$/g) || []).length % 2, 0, '$do$ blocks are unbalanced');
  });
  it('no enum value is added (it cannot be, inside one transaction)', () => {
    assert.not(/alter\s+type\s+\w+\s+add\s+value/i.test(sql));
  });
  it('every function whose signature or return type changed is dropped first', () => {
    [['set_chat_lock(uuid, text)', 'set_chat_lock'],
     ['verify_chat_lock(uuid, text)', 'verify_chat_lock'],
     ['chat_overview()', 'chat_overview'],
     ['search_messages(text, uuid, int)', 'search_messages']].forEach(([sig, name]) => {
      const drop = sql.indexOf(`drop function if exists ${sig}`);
      const create = sql.indexOf(`create or replace function ${name}(`);
      assert.ok(drop >= 0, `missing drop for ${sig}`);
      assert.ok(drop < create, `${name} is recreated before the old signature is dropped`);
    });
  });
  it('every new table has RLS turned on and policies', () => {
    assert.match(sql, /create table if not exists call_participants/);
    assert.match(sql, /alter table call_participants enable row level security/);
    ['cp_read', 'cp_write', 'cp_insert'].forEach(p => {
      assert.ok(sql.includes(`drop policy if exists ${p} on call_participants`), `${p} not dropped first`);
      assert.ok(sql.includes(`create policy ${p} on call_participants`), `${p} not created`);
    });
  });
  it('new columns are all "add column if not exists", so a re-run is a no-op', () => {
    const adds = [...sql.matchAll(/alter table (\w+) add column ([^;]+);/g)];
    assert.ok(adds.length >= 10);
    adds.forEach(m => assert.match(m[2], /^if not exists/, `not idempotent: ${m[0].slice(0, 70)}`));
  });
  it('the lock columns and the call columns are all there', () => {
    ['lock_fails', 'lock_until', 'lock_relock', 'lock_hide_preview', 'lock_hide_in_list', 'lock_set_at']
      .forEach(c => assert.ok(sql.includes(c), c));
    ['host_id', 'join_open', 'ended_reason', 'last_activity_at']
      .forEach(c => assert.ok(sql.includes(c), c));
  });
  it('the summary bubble is written once, guarded against two clients racing', () => {
    assert.match(sql, /where id = p_call and ended_at is null;/);
    assert.match(sql, /if not found then return false; end if;/);
    assert.eq((sql.match(/insert into messages \(chat_id, sender_id, kind, body, meta\)/g) || []).length, 1);
  });
  it('a locked chat is redacted inside chat_overview, not just in the client', () => {
    assert.match(sql, /case when me\.locked and me\.lock_hide_preview then null else/);
  });
  it('search_messages leaves locked chats out unless they are passed in', () => {
    assert.match(sql, /p_unlocked uuid\[\] default '\{\}'/);
    assert.match(sql, /lk\.locked\s*\n?\s*and not \(m\.chat_id = any\(coalesce\(p_unlocked/);
  });
  it('the account-password check is read-only and never returns the hash', () => {
    const fn = sql.slice(sql.indexOf('function verify_account_password'), sql.indexOf('-- ============================================================================\n-- 3.'));
    assert.match(fn, /stable/);
    assert.match(fn, /returns boolean/);
    assert.not(/return h;/.test(fn));
  });
});

/* ── the rules written twice agree ──────────────────────────────────── */
describe('static: SQL and JS agree', () => {
  it('chat_lock_cooldown() in SQL equals cooldownFor() in JS', () => {
    const body = sql.slice(sql.indexOf('function chat_lock_cooldown'), sql.indexOf('function chat_lock_pin_ok'));
    const pairs = [...body.matchAll(/when p_fails = (\d+)\s+then (\d+)/g)].map(m => [Number(m[1]), Number(m[2])]);
    assert.ok(pairs.length >= 3, 'could not parse the SQL ladder');
    pairs.forEach(([fails, secs]) => assert.eq(cooldownFor(fails), secs, `fails=${fails}`));
    const below = /when coalesce\(p_fails,0\) < (\d+) then 0/.exec(body);
    assert.ok(below, 'no free-attempt clause found');
    assert.eq(Number(below[1]), MAX_ATTEMPTS);
    assert.eq(cooldownFor(MAX_ATTEMPTS - 1), 0);
    const tail = /else (\d+)\s*\n?\s*end;/.exec(body);
    assert.eq(cooldownFor(99), Number(tail[1]));
  });
  it('call_capacity() in SQL equals capacityFor() in JS', () => {
    const m = /case when p_kind = 'video' then (\d+) else (\d+) end/.exec(sql);
    assert.ok(m, 'could not parse call_capacity()');
    assert.eq(capacityFor('video'), Number(m[1]));
    assert.eq(capacityFor('audio'), Number(m[2]));
  });
  it('the PIN shape SQL enforces is the shape JS offers (4-8 digits)', () => {
    assert.match(sql, /\^\[0-9\]\{4,8\}\$/);
    assert.match(read('js/lockcore.js'), /s\.length < 4 \|\| s\.length > 8/);
  });
  it('the relock modes in JS are exactly the ones the check constraint allows', () => {
    const m = /check \(lock_relock in \(([^)]+)\)\)/.exec(sql);
    const sqlModes = m[1].split(',').map(s => s.trim().replace(/'/g, '')).sort();
    const jsModes = /RELOCK_MODES = \[([^\]]+)\]/.exec(read('js/lockcore.js'))[1]
      .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort();
    assert.deep(sqlModes, jsModes);
  });
  it('the heartbeat interval is inside the window the sweep uses', () => {
    const m = /heartbeat_at < now\(\) - interval '(\d+) seconds'/.exec(sql);
    const staleSecs = Number(m[1]);
    const beatMs = Number(/HEARTBEAT_MS = ([\d_]+)/.exec(read('js/callcore.js'))[1].replace(/_/g, ''));
    assert.ok(beatMs * 2 < staleSecs * 1000, `beat ${beatMs}ms vs stale ${staleSecs}s`);
  });
});

/* ── the leaks that used to exist stay closed ──────────────────────────── */
describe('static: no regressions', () => {
  it('nothing builds a notification body outside lockcore', () => {
    const notify = read('js/notify.js');
    assert.match(notify, /notifyPayload\(chat, m/);
    assert.not(/mode === 'full'\s*\n?\s*\?\s*\(m\.body/.test(notify), 'the old inline body logic is back');
  });
  it('the chat list preview goes through lockcore', () => {
    const chats = read('js/chats.js');
    assert.match(chats, /previewFor\(c, \{ unlocked: isUnlocked\(c\.chat_id\) \}\)/);
    assert.not(/if \(c\.locked\) return 'Locked chat';/.test(chats), 'the old local preview logic is back');
  });
  it('openChat gates through chatlock rather than a bare prompt', () => {
    const chats = read('js/chats.js');
    assert.match(chats, /if \(!await gateChat\(chatId\)\) return;/);
    assert.not(/promptBox\('Locked chat'/.test(chats), 'the one-shot PIN prompt is back');
  });
  it('search always passes the unlocked list', () => {
    const panels = read('js/panels.js');
    const calls = [...panels.matchAll(/rpc\('search_messages',\s*\{[^}]*\}/g)].map(m => m[0]);
    assert.ok(calls.length >= 2);
    calls.forEach(c => assert.match(c, /p_unlocked/));
  });
  it('every incoming signal is checked before it reaches a peer connection', () => {
    const calls = read('js/calls.js');
    assert.match(calls, /signalAccepted\(s, \{/);
    assert.ok(calls.indexOf('signalAccepted') < calls.indexOf('await onSignal(s.sender_id, p)'));
  });
  it('the client no longer writes its own call-ended message', () => {
    const calls = read('js/calls.js');
    assert.not(/ins\('messages'/.test(calls), 'calls.js is writing message rows again');
  });
  it('the 4-person cap is no longer hard-coded in the client', () => {
    assert.not(/others\.length > 3/.test(read('js/calls.js')));
  });
  it('push-notify redacts locked chats too', () => {
    const fn = read('supabase/functions/push-notify/index.ts');
    assert.match(fn, /mute_forever, locked/);
    assert.match(fn, /Message in a locked chat/);
    assert.match(fn, /chat_id: locked \? '' :/);
  });
});
