import { sb, rpc, sel, dropAll } from './db.js';
import { S, emit } from './state.js';
import { $, h, toast, oops, modal, closeModal, clear } from './util.js';
import { applySettings } from './theme.js';
import { unlockIdentity, createIdentity, forgetKeys } from './crypto.js';

const msg = (t, ok = false) => { const el = $('#auth-msg'); el.textContent = t; el.className = 'auth-msg' + (ok ? ' ok' : ''); };

export function mountAuthUI() {
  document.querySelectorAll('[data-authtab]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-authtab]').forEach(x => x.classList.toggle('is-on', x === b));
    $('#form-in').hidden = b.dataset.authtab !== 'in';
    $('#form-up').hidden = b.dataset.authtab !== 'up';
    msg('');
  });

  $('#form-in').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    msg('Signing in…');
    const { error } = await sb.auth.signInWithPassword({
      email: f.get('email').trim(), password: f.get('password') });
    if (error) return msg(error.message);
    sessionStorage.setItem('wisp.pw', f.get('password'));   // kept in memory for key unwrap only
    msg('');
  };

  $('#form-up').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    msg('Creating account…');
    const { data, error } = await sb.auth.signUp({
      email: f.get('email').trim(), password: f.get('password'),
      options: { data: { display_name: f.get('display_name') }, emailRedirectTo: location.origin },
    });
    if (error) return msg(error.message);
    sessionStorage.setItem('wisp.pw', f.get('password'));
    if (!data.session) msg('Check your inbox to verify the address, then sign in.', true);
  };

  $('#link-forgot').onclick = async () => {
    const email = new FormData($('#form-in')).get('email');
    if (!email) return msg('Type your email above first.');
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + '/#reset' });
    msg(error ? error.message : 'Reset link sent.', !error);
  };

  if (location.hash.includes('reset') || location.hash.includes('type=recovery')) {
    setTimeout(async () => {
      const pw = await new Promise(res => {
        const i = h('input', { type: 'password', minlength: 8 });
        modal(h('h3', { class: 'display' }, 'Set a new password'), h('label', {}, 'New password', i),
          h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: () => { closeModal(); res(i.value); } }, 'Save')));
      });
      if (pw) {
        const { error } = await sb.auth.updateUser({ password: pw });
        error ? oops(error) : toast('Password updated. Note: encrypted chats need their key re-created.');
      }
    }, 400);
  }
}

export async function loadMe() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  let [profile] = await sel('profiles', { eq: { id: user.id } });
  if (!profile) {   // handles the rare case where the signup trigger ran late
    await sb.from('profiles').insert({ id: user.id, email: user.email, display_name: user.email.split('@')[0] });
    [profile] = await sel('profiles', { eq: { id: user.id } });
  }
  let [settings] = await sel('user_settings', { eq: { user_id: user.id } });
  if (!settings) { await sb.from('user_settings').insert({ user_id: user.id }); [settings] = await sel('user_settings', { eq: { user_id: user.id } }); }
  S.me = profile; S.settings = settings;
  applySettings();
  return profile;
}

/* Two-step verification: a PIN layered on top of the password, checked in SQL
   with bcrypt. It gates the UI on this device; it is not a second factor for
   the Supabase session itself (documented in the README). */
export async function twoStepGate() {
  if (!S.settings?.two_step_pin) return true;
  return new Promise(res => {
    const wrap = $('#lock');
    wrap.hidden = false;
    const input = h('input', { type: 'password', inputmode: 'numeric', placeholder: '••••' });
    const err = h('p', { class: 'hint' });
    clear(wrap).append(h('div', { class: 'sheet' },
      h('h1', { class: 'display' }, 'Enter your PIN'),
      h('p', { class: 'muted' }, 'Two-step verification is on for this account.'),
      h('label', {}, 'PIN', input), err,
      h('button', {
        class: 'btn primary', onclick: async () => {
          if (await rpc('verify_two_step_pin', { p_pin: input.value })) { wrap.hidden = true; res(true); }
          else err.textContent = 'Wrong PIN.';
        },
      }, 'Unlock')));
    input.focus();
  });
}

export async function ensureKeys() {
  const pw = sessionStorage.getItem('wisp.pw');
  const ok = await unlockIdentity(pw);
  if (!ok) {
    // password not in this session (e.g. refreshed tab): ask only when needed
    S.keys = null;
  }
}
export async function unlockKeysInteractive() {
  const pw = await new Promise(res => {
    const i = h('input', { type: 'password' });
    modal(h('h3', { class: 'display' }, 'Unlock encryption key'),
      h('p', { class: 'hint' }, 'Your private key is wrapped with your password. It never leaves this device unwrapped.'),
      h('label', {}, 'Account password', i),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); res(i.value); } }, 'Unlock')));
  });
  if (!pw) return false;
  sessionStorage.setItem('wisp.pw', pw);
  const ok = await unlockIdentity(pw);
  if (!ok) toast('Could not unwrap the key with that password.', true);
  return ok;
}
export async function initIdentity() {
  const pw = sessionStorage.getItem('wisp.pw');
  const { data } = await sb.from('user_keys').select('user_id').eq('user_id', S.me.id).maybeSingle();
  if (!data && pw) { try { await createIdentity(pw); } catch (e) { console.warn(e); } }
  else await ensureKeys();
}

/* Sessions / devices */
export async function signOut() {
  try { await rpc('go_offline'); } catch {}
  forgetKeys();
  sessionStorage.removeItem('wisp.pw');
  dropAll();
  await sb.auth.signOut();
  location.reload();
}
export async function signOutEverywhere() {
  try { await rpc('go_offline'); } catch {}
  forgetKeys();
  await sb.auth.signOut({ scope: 'global' });
  location.reload();
}

let hb;
export function startPresence() {
  const beat = () => { if (document.visibilityState === 'visible') rpc('heartbeat').catch(() => {}); };
  beat();
  hb = setInterval(beat, 25000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' ? beat() : rpc('go_offline').catch(() => {}));
  addEventListener('pagehide', () => { try { rpc('go_offline'); } catch {} });
}
export const stopPresence = () => clearInterval(hb);
