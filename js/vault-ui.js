// ── Private Vault — the part people actually touch ─────────────────────────
//
// Wisp → Private Vault → authenticate → your private conversations, looking and
// behaving exactly like normal conversations once you are inside.
//
// Deliberately not here: no disguise, no fake calculator, no secret code that
// launches Wisp from another app, nothing pretending Wisp is not installed. The
// vault is a visible, explainable part of the app. What is hidden is which
// conversations are in it and what they say — not the existence of the feature.
//
// No emoji in this interface, no cryptography jargon on screen, no animation
// beyond what the rest of the app already does. One idea to get across:
// "Private Vault = my sensitive conversations are behind another
// authentication layer."

import { rpc } from './db.js';
import { S, on } from './state.js';
import { $, h, clear, toast, oops, modal, closeModal, confirmBox, iconEl, initials,
         shortWhen, debounce, longPress, popMenu, setActiveNav, paintIcons } from './util.js';
import { saveSettings } from './theme.js';
import {
  vaultState, isUnlocked, setupVault, unlockWithCode, unlockWithBiometric, lockVault,
  changeCode, biometricSupport, biometricEnrolled, enrolBiometric, dropBiometric,
  eraseLocalVault, guardStatus, setWipeAfterFails, wipeAfterFailsOn, setVaultVisible,
  noteVaultActivity, loadVaultIds, AUTOLOCK_OPTIONS, AUTOLOCK_DEFAULT, WIPE_AFTER,
} from './vault.js';
import { loadChats, renderChatList, openChat, closeChat, chatPhoto } from './chats.js';
import { dropCached } from './cache.js';
import { jumpTo } from './thread.js';

/* ── small shared bits ──────────────────────────────────────────────── */

const row = (label, control, note) => h('div', { class: 'kv' },
  h('div', {}, h('span', { style: { color: 'var(--ink)' } }, label), note && h('div', { class: 'hint' }, note)), control);

const toggle = (value, onchange) => {
  const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!value) });
  b.onclick = async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    try { await onchange(next); } catch (e) { oops(e); b.setAttribute('aria-checked', String(!next)); }
  };
  return b;
};

const waitText = ms => {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const hr = Math.ceil(m / 60);
  return `${hr} hour${hr === 1 ? '' : 's'}`;
};

/** Ask for a code without ever putting it in a URL, a title or a log. */
function codePrompt(title, { label = 'Vault code', note = '', okLabel = 'Continue' } = {}) {
  return new Promise(res => {
    const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
    const go = () => { closeModal(); res(input.value); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    modal(
      h('h3', { class: 'display', text: title }),
      note && h('p', { class: 'hint', text: note }),
      h('label', {}, label, input),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: go }, okLabel)));
    input.focus();
  });
}

/* ── entering the vault ────────────────────────────────────────────── */

export async function openVault() {
  S.view = 'vault';
  S.folder = null;
  setActiveNav('chats');
  $('#list-title').textContent = 'Private Vault';
  $('#q').value = '';
  $('#q').placeholder = 'Search private conversations';
  $('#btn-search-cancel').classList.remove('is-shown');

  const chips = clear($('#folders'));
  chips.append(h('button', { class: 'chip', onclick: leaveVault }, 'Back to Chats'));

  const state = await vaultState();
  if (state === 'unlocked') return void renderVaultList();
  renderGate(state);
}

/** Leave the vault section. Starts the auto-relock countdown. */
export async function leaveVault() {
  S.view = 'chats';
  setVaultVisible(false);
  $('#q').value = '';
  $('#q').placeholder = 'Search messages, people, files';
  $('#list-title').textContent = 'Chats';
  const { loadFolders } = await import('./chats.js');
  await loadFolders();
  renderChatList();
  syncVaultChrome();
}

/* ── the authentication screen ──────────────────────────────────────── */

async function renderGate(state) {
  const body = clear($('#list-body'));
  setVaultVisible(false);
  syncVaultChrome();

  if (state === 'absent') return void body.append(await setupCard());

  const err = h('p', { class: 'vault-err', role: 'alert' });
  const input = h('input', {
    type: 'password', inputmode: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Vault code', 'aria-label': 'Vault code',
  });
  const unlockBtn = h('button', { class: 'btn primary', onclick: () => submit() }, 'Unlock');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  let ticking = null;
  const showWait = ms => {
    clearInterval(ticking);
    input.disabled = unlockBtn.disabled = true;
    const paint = () => {
      const left = ms - (Date.now() - t0);
      if (left <= 0) {
        clearInterval(ticking);
        input.disabled = unlockBtn.disabled = false;
        err.textContent = '';
        return;
      }
      err.textContent = `Too many wrong codes. Try again in ${waitText(left)}.`;
    };
    const t0 = Date.now();
    paint();
    ticking = setInterval(paint, 1000);
  };

  async function submit() {
    const code = input.value;
    if (!code) return;
    unlockBtn.disabled = true;
    err.textContent = 'Checking…';
    const r = await unlockWithCode(code);
    input.value = '';
    unlockBtn.disabled = false;
    if (r.ok) { err.textContent = ''; return void afterUnlock(); }
    if (r.erased) { err.textContent = r.error; return void renderGate('absent'); }
    err.textContent = r.error + (r.fails ? ` (${r.fails} wrong so far)` : '');
    if (r.waitMs > 0) showWait(r.waitMs);
  }

  const enrolled = await biometricEnrolled();
  const bioBtn = enrolled && h('button', {
    class: 'btn', onclick: async () => {
      err.textContent = 'Waiting for the device check…';
      const r = await unlockWithBiometric();
      if (r.ok) { err.textContent = ''; return void afterUnlock(); }
      err.textContent = r.error;
      if (r.waitMs > 0) showWait(r.waitMs);
      input.focus();
    },
  }, iconEl('key', 17), 'Unlock with this device');

  const { waitMs } = await guardStatus();

  body.append(h('div', { class: 'vault-gate' },
    h('div', { class: 'vault-mark' }, iconEl('lock', 26)),
    h('h3', { class: 'display' }, 'Private Vault'),
    h('p', { class: 'muted' }, 'Authenticate to open your private conversations.'),
    bioBtn || null,
    h('div', { class: 'vault-code' }, input, unlockBtn),
    err,
    h('p', { class: 'hint' }, 'Your vault code is not your Wisp account password, and there is no way to reset it from your account — that would defeat the point.')));

  if (waitMs > 0) showWait(waitMs);
  else if (enrolled) bioBtn.click();
  else input.focus();
}

async function afterUnlock() {
  await loadChats();          // merges vault_overview() into the live list
  await renderVaultList();
  syncVaultChrome();
  toast('Private Vault unlocked.');
}

/* ── first-time setup ──────────────────────────────────────────────── */

async function setupCard() {
  return h('div', { class: 'vault-gate' },
    h('div', { class: 'vault-mark' }, iconEl('shield', 26)),
    h('h3', { class: 'display' }, 'Private Vault'),
    h('p', { class: 'muted' }, 'Private Vault gives your most sensitive Wisp conversations an additional security boundary, protecting conversations, notifications and media behind dedicated authentication.'),
    h('ul', { class: 'vault-points' },
      h('li', {}, 'Private conversations leave the normal chat list, normal search and normal media browsing.'),
      h('li', {}, 'Notifications for them never show a sender or a message.'),
      h('li', {}, 'Their local copy on this device is encrypted with a key that only exists while the vault is open.')),
    h('button', { class: 'btn primary', onclick: startSetup }, 'Set up Private Vault'),
    h('p', { class: 'hint' }, 'Set up per device. Nothing about the vault code ever leaves this device.'));
}

export async function startSetup() {
  const first = await codePrompt('Choose a vault code', {
    note: 'At least 6 characters. Different from your Wisp account password. It is not stored anywhere — if you forget it, the private copy on this device cannot be opened, by you or by anyone else.',
    okLabel: 'Next',
  });
  if (!first) return;
  const again = await codePrompt('Confirm the code', { label: 'Type it again', okLabel: 'Create vault' });
  if (again === null) return;
  if (first !== again) return toast('Those did not match. Nothing was created.', true);

  const r = await setupVault(first, { accountPassword: sessionStorage.getItem('wisp.pw') });
  if (!r.ok) return toast(r.error, true);

  await saveSettings({
    vault_autolock: S.settings?.vault_autolock || AUTOLOCK_DEFAULT,
    vault_screen_guard: true,
  }).catch(() => {});

  toast('Private Vault is ready.');
  await loadChats();
  if (S.view === 'vault') await renderVaultList();
  syncVaultChrome();
  offerBiometric(first);
}

async function offerBiometric(code) {
  const support = await biometricSupport();
  if (support === 'unsupported') return;
  if (!await confirmBox('Use this device to unlock?',
    'Fingerprint, face or your device passcode, instead of typing the vault code every time. Your code keeps working either way.',
    'Set it up')) return;
  const r = await enrolBiometric(code);
  toast(r.ok ? 'Device unlock is on.' : r.error, !r.ok);
}

/* ── the private conversation list ───────────────────────────────────── */

export async function renderVaultList() {
  if (S.view !== 'vault') return;
  if (!isUnlocked()) return renderGate('locked');
  setVaultVisible(true);

  const body = clear($('#list-body'));
  const rows = S.vault.chats || [];

  body.append(h('div', { class: 'vault-bar' },
    h('span', { class: 'vault-bar-label' }, iconEl('lock', 15), 'Private Vault · open'),
    h('button', { class: 'btn small', onclick: pickToVault }, 'Add conversation'),
    h('button', { class: 'btn small danger', onclick: lockNow }, 'Lock')));

  if (!rows.length) {
    body.append(h('div', { class: 'empty' },
      h('p', {}, 'Nothing in the vault yet'),
      h('p', { class: 'hint' }, 'Add a conversation here, or use a conversation\u2019s own menu → Move to Private Vault.')));
    return;
  }

  rows.forEach(c => {
    const photo = chatPhoto(c);
    const av = photo ? h('img', { class: 'av', src: photo, alt: '' }) : h('div', { class: 'av' }, initials(c.name));
    const el = h('button', {
      class: 'row' + (S.chat?.chat_id === c.chat_id ? ' is-on' : ''),
      onclick: () => {
        if (el.dataset.pressed) { delete el.dataset.pressed; return; }
        noteVaultActivity();
        openChat(c.chat_id);
      },
      oncontextmenu: e => { e.preventDefault(); vaultRowMenu(c, { x: e.clientX, y: e.clientY }); },
    },
      av,
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, c.name || 'Chat')),
        h('div', { class: 'row-prev' }, c.last_body || 'Encrypted message')),
      h('div', { class: 'row-side' },
        h('span', {}, shortWhen(c.last_at)),
        c.unread > 0 && h('div', { class: 'dot-row' }, h('b', { class: 'pill' }, String(c.unread)))));
    longPress(el, at => vaultRowMenu(c, at));
    body.append(el);
  });
}

function vaultRowMenu(c, at) {
  popMenu([
    { label: 'Open', icon: 'chat', onclick: () => openChat(c.chat_id) },
    { label: 'Move out of Private Vault', icon: 'lock', onclick: () => moveOutOfVault(c) },
  ], { ...at, title: c.name || 'Private conversation' });
}

/* ── in-vault search ───────────────────────────────────────────────── */

/**
 * Searching inside the vault, after authentication. A separate server function
 * that only ever looks at private conversations, so the normal search box and
 * this one cannot bleed into each other.
 */
export const vaultSearch = debounce(async q => {
  if (S.view !== 'vault') return;
  if (!isUnlocked()) return renderGate('locked');
  if (!q.trim()) return void renderVaultList();
  noteVaultActivity();

  const body = clear($('#list-body'));
  body.append(h('div', { class: 'vault-bar' },
    h('span', { class: 'vault-bar-label' }, iconEl('lock', 15), `“${q}” in Private Vault`),
    h('button', { class: 'btn small', onclick: () => { $('#q').value = ''; renderVaultList(); } }, 'Clear')));
  try {
    const rows = await rpc('search_vault_messages', { p_query: q, p_chat: null });
    const hits = (rows || []).filter(r => r.body);
    if (!hits.length) {
      body.append(h('p', { class: 'hint', style: { padding: '0 16px' } },
        'No match. Private conversations are end-to-end encrypted, so their message text is not searchable on the server — open a conversation and search inside it instead.'));
    }
    hits.forEach(m => {
      const meta = (S.vault.chats || []).find(c => c.chat_id === m.chat_id);
      body.append(h('button', {
        class: 'result', onclick: async () => {
          await openChat(m.chat_id);
          setTimeout(() => jumpTo(m.message_id), 400);
        },
      }, h('b', {}, meta?.name || m.chat_name || 'Private conversation'),
        h('span', {}, (m.body || '').slice(0, 140)),
        h('small', {}, shortWhen(m.created_at))));
    });
  } catch (e) { oops(e); }
}, 300);

/* ── moving conversations in and out ───────────────────────────────────── */

/** Make sure the vault exists and is open, prompting if it is not. */
export async function requireVault() {
  const state = await vaultState();
  if (state === 'unlocked') return true;
  if (state === 'absent') {
    if (!await confirmBox('Set up Private Vault?',
      'A conversation can only be made private once this device has a vault code.', 'Set it up')) return false;
    await startSetup();
    return isUnlocked();
  }
  const enrolled = await biometricEnrolled();
  if (enrolled) {
    const r = await unlockWithBiometric();
    if (r.ok) { await loadChats(); return true; }
  }
  const code = await codePrompt('Unlock Private Vault', { okLabel: 'Unlock' });
  if (!code) return false;
  const r = await unlockWithCode(code);
  if (!r.ok) { toast(r.error + (r.waitMs ? ` Try again in ${waitText(r.waitMs)}.` : ''), true); return false; }
  await loadChats();
  return true;
}

/**
 * Move a conversation into the vault.
 *
 * Order matters. End-to-end encryption goes on first, so that from this point
 * the server holds ciphertext for this conversation rather than message text it
 * could search, summarise or put in a push payload. Then the server-side
 * `vaulted` flag, which takes it out of the normal list, normal search, digests
 * and exports at the source. Then the plaintext copy this device already had is
 * scrubbed — without that last step the "lock" would be a hidden row with the
 * messages still sitting in the clear in IndexedDB.
 */
export async function moveToVault(chat) {
  if (!chat) return;
  if (!await confirmBox(`Move “${chat.name || 'this conversation'}” to Private Vault?`,
    'It leaves your normal chat list, normal search and normal media browsing, its notifications stop showing any sender or message, and opening it needs vault authentication. End-to-end encryption is turned on for it if it is not already.',
    'Move to vault')) return;

  if (!await requireVault()) return;

  try {
    if (!chat.e2ee) {
      const { unlockKeysInteractive } = await import('./auth.js');
      if (!S.keys && !await unlockKeysInteractive()) {
        return toast('Your encryption key stayed locked, so nothing was moved. A private conversation has to be encrypted.', true);
      }
      const members = S.members?.length && S.chat?.chat_id === chat.chat_id
        ? S.members.map(m => m.user_id)
        : (await import('./db.js')).sel('chat_members', { select: 'user_id', eq: { chat_id: chat.chat_id } })
            .then(rows => rows.map(r => r.user_id));
      const ids = await members;
      const { chatKey } = await import('./crypto.js');
      await chatKey(chat.chat_id, ids);
      await rpc('set_chat_e2ee', { p_chat: chat.chat_id, p_on: true });
    }

    await rpc('set_chat_vaulted', { p_chat: chat.chat_id, p_on: true });
    S.vault.ids.add(chat.chat_id);
    await dropCached(chat.chat_id);

    if (S.chat?.chat_id === chat.chat_id) closeChat();
    await loadChats();
    if (S.view === 'vault') await renderVaultList(); else renderChatList();
    syncVaultChrome();
    toast('Moved to Private Vault.');
  } catch (e) { oops(e); }
}

/** Move it back to normal chats. Needs authentication, same as reading it. */
export async function moveOutOfVault(chat) {
  if (!chat) return;
  if (!await requireVault()) return;
  if (!await confirmBox(`Move “${chat.name || 'this conversation'}” back to normal chats?`,
    'It returns to your chat list, normal search and normal notifications. Encryption stays on. Its private local copy on this device is removed.',
    'Move out')) return;
  try {
    await rpc('set_chat_vaulted', { p_chat: chat.chat_id, p_on: false });
    await dropCached(chat.chat_id);       // drop the encrypted copy too
    S.vault.ids.delete(chat.chat_id);
    if (S.chat?.chat_id === chat.chat_id) closeChat();
    await loadChats();
    if (S.view === 'vault') await renderVaultList(); else renderChatList();
    toast('Back in normal chats.');
  } catch (e) { oops(e); }
}

async function pickToVault() {
  const candidates = (S.chats || []).filter(c => !c.vaulted && !c.archived);
  if (!candidates.length) return toast('No other conversations to add.');
  const list = h('div', { class: 'stack', style: { maxHeight: '46vh', overflowY: 'auto' } },
    candidates.map(c => h('button', {
      class: 'btn', onclick: () => { closeModal(); moveToVault(c); },
    }, h('div', { class: 'av', style: { width: '24px', height: '24px', fontSize: '10px' } }, initials(c.name)),
      c.name || 'Chat')));
  modal(h('h3', { class: 'display' }, 'Add to Private Vault'),
    h('p', { class: 'hint' }, 'The other person is not told. This only changes how Wisp handles the conversation on your side.'),
    list,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel')));
}

/* ── lock everything ────────────────────────────────────────────────── */

/**
 * The one-tap "about to hand my phone over" action. Reachable from the vault
 * bar, the list header button, Settings, and Ctrl/Cmd+Shift+L.
 *
 * lockVault() does the security part synchronously (keys and decrypted data out
 * of memory, blob URLs revoked). This does the visible part: close the private
 * conversation if one is open, take private conversations back out of the live
 * list, and put the gate back.
 */
export function lockNow(reason = 'manual') {
  const was = lockVault(reason);
  onLocked();
  if (was) toast('Private Vault locked.');
}

function onLocked() {
  if (S.chat && S.vault.ids.has(S.chat.chat_id)) closeChat();
  S.chats = (S.chats || []).filter(c => !c.vaulted);
  S.vault.chats = [];
  setVaultVisible(false);
  syncVaultChrome();
  if (S.view === 'vault') renderGate('locked');
  else renderChatList();
}

/** Show the header lock button only while there is something to lock. */
export function syncVaultChrome() {
  const btn = $('#btn-vault-lock');
  if (btn) btn.hidden = !isUnlocked();
}

/* ── the row that leads into the vault ─────────────────────────────────── */

/**
 * Sits at the end of the chat list. It says the vault exists; it does not say
 * what is in it. No count, no preview, no last-message time — those are all
 * ways of reporting on a private conversation from outside the vault.
 */
export function vaultEntryNode() {
  return h('button', {
    class: 'row vault-entry',
    onclick: () => openVault(),
  },
    h('div', { class: 'av vault-av' }, iconEl('lock', 18)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, 'Private Vault')),
      h('div', { class: 'row-prev' }, isUnlocked() ? 'Open' : 'Authentication required')),
    h('div', { class: 'row-side' }, iconEl('chevron', 16)));
}

/* ── settings ───────────────────────────────────────────────────────── */

export async function vaultSettingsSection() {
  const state = await vaultState();
  const support = await biometricSupport();
  const enrolled = await biometricEnrolled();
  const wipe = await wipeAfterFailsOn();
  const s = S.settings || {};
  const refresh = async () => (await import('./settings.js')).openSettings();

  const statusText = { absent: 'Not set up on this device', locked: 'Locked', unlocked: 'Open' }[state];

  const head = h('section', {},
    h('h3', {}, 'Private Vault'),
    h('p', { class: 'hint' }, 'Private Vault gives your most sensitive Wisp conversations an additional security boundary, protecting conversations, notifications and media behind dedicated authentication.'),
    row('This device', h('b', {}, statusText)),
    state === 'absent'
      ? h('button', { class: 'btn small primary', onclick: startSetup }, 'Set up Private Vault')
      : h('div', { class: 'row-btns' },
        state === 'unlocked'
          ? h('button', { class: 'btn small danger', onclick: () => { lockNow(); refresh(); } }, 'Lock Private Vault')
          : h('button', { class: 'btn small', onclick: () => openVault() }, 'Open Private Vault'),
        h('button', {
          class: 'btn small', onclick: async () => {
            const cur = await codePrompt('Change vault code', { label: 'Current code', okLabel: 'Next' });
            if (!cur) return;
            const next = await codePrompt('New vault code', { label: 'New code', note: 'At least 6 characters, and not your Wisp account password.', okLabel: 'Next' });
            if (!next) return;
            const again = await codePrompt('Confirm', { label: 'Type it again', okLabel: 'Change code' });
            if (again !== next) return toast('Those did not match. Your code is unchanged.', true);
            const r = await changeCode(cur, next);
            toast(r.ok ? 'Vault code changed.' : r.error, !r.ok);
          },
        }, 'Change code')));

  if (state === 'absent') return head;

  const bioControl = support === 'unsupported'
    ? h('small', { class: 'hint' }, 'No device authentication here')
    : support === 'no-prf'
      ? h('small', { class: 'hint' }, 'Not available in this browser')
      : toggle(enrolled, async on => {
        if (!on) { await dropBiometric(); toast('Device unlock off. Your code still works.'); return refresh(); }
        const code = await codePrompt('Confirm your vault code', {
          note: 'Needed once, to re-wrap the vault key for this device. Wisp never keeps the key in a form it could re-wrap without you.',
          okLabel: 'Turn on',
        });
        if (!code) throw new Error('Cancelled, nothing changed.');
        const r = await enrolBiometric(code);
        if (!r.ok) throw new Error(r.error);
        toast('Device unlock is on.');
        refresh();
      });

  const bioNote = support === 'unsupported'
    ? 'This device has no fingerprint, face or device-passcode authenticator available to the browser.'
    : support === 'no-prf'
      ? 'This browser can check your fingerprint or face but cannot derive a key from it. Wisp will not pretend otherwise: a biometric prompt that unlocked a key stored in the clear next to it would look like security and provide none. Your code is the way in here.'
      : 'Fingerprint, face or device passcode, instead of typing the code. The key is derived from the authenticator itself, so the device check is doing real work.';

  return h('div', { class: 'stack' },
    head,
    h('section', {},
      h('h3', {}, 'Authentication'),
      row('Unlock with this device', bioControl, bioNote),
      row('Lock automatically', h('select', {
        onchange: e => saveSettings({ vault_autolock: e.target.value }),
      }, AUTOLOCK_OPTIONS.map(([v, l]) =>
        h('option', { value: v, selected: String(s.vault_autolock ?? AUTOLOCK_DEFAULT) === v }, l))),
        'The countdown starts when Wisp goes to the background or you leave the vault, not while you are reading. A reload or a restart always locks it.'),
      row('Hide vault content when Wisp is not in front', toggle(s.vault_screen_guard !== false, v => saveSettings({ vault_screen_guard: v })),
        'Covers the screen the moment Wisp is backgrounded, so the app-switcher preview shows the cover instead of a conversation. Browsers give no way to guarantee the operating system did not already capture a frame.'),
      row(`Erase this device\u2019s vault after ${WIPE_AFTER} wrong codes`, toggle(wipe, async v => {
        if (v && !await confirmBox('Erase after repeated wrong codes?',
          `After ${WIPE_AFTER} wrong codes, the encrypted copy of your private conversations on this device is deleted along with the vault key. Your conversations stay in the vault and can be read again after setting a new code. Somebody guessing badly can trigger this.`,
          'Turn on')) throw new Error('Left off.');
        await setWipeAfterFails(v);
      }), 'Off by default. Wrong codes already get slower and slower to try.')),
    h('section', {},
      h('h3', {}, 'Notifications for private conversations'),
      h('p', { class: 'hint' }, 'Always “Wisp — New private message”: no sender, no message text, no conversation in the payload, and tapping it opens the vault rather than a conversation. This is not adjustable, because a preview setting somebody forgot to change is how a private conversation ends up on a lock screen. The Standard / Private / Maximum privacy tiers under Notifications apply to your other conversations.')),
    h('section', {},
      h('h3', {}, 'What this does and does not do'),
      h('ul', { class: 'vault-points' },
        h('li', {}, 'It protects Wisp\u2019s data on this device from somebody who gets hold of your phone while it is unlocked.'),
        h('li', {}, 'It does not protect against a compromised device, malware running with your privileges, or an operating system that has been tampered with.'),
        h('li', {}, 'It cannot stop someone photographing the screen, and it cannot stop the person you are talking to from saving or screenshotting what you send them.'),
        h('li', {}, 'Screenshots are not blocked and are not claimed to be.'),
        h('li', {}, 'Nothing here is unhackable, and nothing here is claimed to be.')),
      h('p', { class: 'hint' }, 'Vault key material stays on this device. Setting up Private Vault on another device is a separate setup with its own code; conversations stay private on both because the flag travels with your account, but the vault key does not.')),
    h('section', {},
      h('h3', {}, 'This device'),
      h('button', {
        class: 'btn small danger', onclick: async () => {
          if (!await confirmBox('Erase Private Vault on this device?',
            'Deletes the vault key and the encrypted local copies of your private conversations from this browser. It cannot reveal anything and it is not a way in. Your conversations stay in the vault — set a new code here to read them on this device again.',
            'Erase')) return;
          await eraseLocalVault();
          await loadVaultIds();
          await loadChats();
          onLocked();
          toast('This device\u2019s vault data was erased.');
          refresh();
        },
      }, 'Erase vault data on this device')));
}

/* ── wiring ────────────────────────────────────────────────────────── */

export function mountVault() {
  const btn = $('#btn-vault-lock');
  if (btn) {
    btn.onclick = () => lockNow('button');
    paintIcons(btn);
  }
  syncVaultChrome();

  // Anything that locks the vault — the timer, backgrounding, the quick action,
  // signing out — comes back through here, so the UI can never be left showing
  // private content after the keys are gone.
  on('vault', ({ unlocked }) => { if (!unlocked) onLocked(); else syncVaultChrome(); });

  // Real interaction inside the vault keeps it open; the countdown only runs
  // when private content is not on screen.
  ['pointerdown', 'keydown'].forEach(evt =>
    document.addEventListener(evt, () => { if (S.vault.visible) noteVaultActivity(); }, { passive: true }));
}
