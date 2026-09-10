import { initDb, sb, rpc } from './db.js';
import { saveEnvLocally, forgetEnvLocally, normalizeUrl, normalizeKey, envError } from './env.js';
import { S } from './state.js';
import { $, $$, h, clear, toast, oops, paintIcons, initials, modal, closeModal, promptBox, popMenu, closePop, setActiveNav } from './util.js';
import { mountAuthUI, loadMe, twoStepGate, initIdentity, startPresence, signOut } from './auth.js';
import { applySettings, saveSettings } from './theme.js';
import { loadChats, loadFolders, renderChatList, openChat, closeChat, subscribeGlobal,
         updateBadge, newGroupFlow, startDm, renderConvHeader, chatPhoto } from './chats.js';
import { warmAllCached } from './cache.js';
import { mountThread, loadMessages } from './thread.js';
import { mountComposer } from './composer.js';
import { mountCalls, setIceServers } from './calls.js';
import { openChatInfo, openDigest, searchInChat, runSearch, viewPeople, viewCalls,
         viewSaved, openSide, personRow, convMenu, openPhotoViewer, openProfileCard } from './panels.js';
import { openSettings } from './settings.js';
import { registerDevice, askPermission } from './notify.js';

/* iOS only defines window.Notification for web apps installed to the home
   screen — in plain mobile Safari it is absent entirely. Code that feature
   tests ('Notification' in window) was fine, but reading Notification.permission
   to render the notifications row in Settings threw a ReferenceError there,
   which meant tapping the gear on an iPhone did nothing at all: the whole
   panel died before it could open. A stand-in with permission set to
   'unsupported' keeps every existing check honest — nothing is ever granted,
   so nothing tries to show a notification — while letting the UI render. */
if (!('Notification' in window)) {
  class NotificationStub {
    static permission = 'unsupported';
    static requestPermission() { return Promise.resolve('denied'); }
    close() {}
  }
  try { window.Notification = NotificationStub; } catch { /* frozen global, nothing to do */ }
}

const boot = $('#boot');

/* Boot used to be able to hang forever: the splash is a fixed, full-screen
   layer, so anything that threw (or simply never resolved) between main()
   starting and boot.hidden = true left a live app underneath a curtain
   nobody could tap through — no error, no way out, not even a scroll. Every
   exit from boot now goes through hideBoot(), a watchdog covers the "never
   resolves" case, and fatal() always leaves something usable on screen. */
let bootTimer = setTimeout(() => {
  if (!boot.hidden) fatal(new Error('Still waiting on the network after 15 seconds.'));
}, 15000);
function hideBoot() { clearTimeout(bootTimer); boot.hidden = true; }

function fatal(e, note) {
  console.error('Wisp could not start', e);
  hideBoot();
  $('#fatal')?.remove();
  document.body.append(h('section', { id: 'fatal', class: 'pane-center' },
    h('div', { class: 'sheet' },
      h('h1', { class: 'display' }, 'Wisp could not start'),
      h('p', { class: 'muted' }, note || e?.message || 'Something went wrong on the way in.'),
      h('p', { class: 'hint' }, 'Reconnecting keeps your account and messages — it only clears the connection details stored in this browser.'),
      h('div', { class: 'modal-actions', style: { justifyContent: 'flex-start' } },
        h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again'),
        h('button', {
          class: 'btn', onclick: () => {
            forgetEnvLocally();
            try { sessionStorage.clear(); } catch {}
            location.replace('/');
          },
        }, 'Reset saved connection')))));
}

async function main() {
  paintIcons();
  // Fire-and-forget, and deliberately first: this only touches IndexedDB, not
  // the Supabase client, so there's no reason to wait for initDb()'s /api/config
  // round trip to start it. It runs in parallel with every network step below
  // (env, session, profile, folders, chat list) — by the time the chat list can
  // even render, this has almost always already finished, so the very first
  // chat tapped after signing back in is warm too, not just chats switched
  // between mid-session.
  warmAllCached();
  const client = await initDb();
  if (!client) return setupScreen();

  try {
    const r = await fetch('/api/config').then(r => r.ok ? r.json() : null);
    if (r?.iceServers) setIceServers(r.iceServers);
  } catch {}

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && !S.me) start();
    if (S.me && session?.user?.id && session.user.id !== S.me.id) location.reload();
    if (event === 'SIGNED_OUT') location.reload();
  });

  const { data: { session } } = await sb.auth.getSession();
  mountAuthUI();
  if (!session) { hideBoot(); $('#auth').hidden = false; return; }
  start();
}

async function start() {
  try {
    $('#auth').hidden = true;
    await loadMe();
    if (!await twoStepGate()) return;
    hideBoot();
    $('#app').hidden = false;

    mountThread(); mountComposer(); mountCalls(); wireChrome();
    await loadFolders();
    await loadChats();
    subscribeGlobal();
    startPresence();
    initIdentity();
    registerDevice();
    askPermission();
    routeHash();
    registerServiceWorker();
  } catch (e) {
    // Anything thrown before $('#app') was revealed (a failed profile load, a
    // rejected first query) used to leave the splash up with only a toast
    // behind it. If the app is already on screen a toast is the right call;
    // if it isn't, the person needs a way out.
    if ($('#app').hidden) fatal(e);
    else { hideBoot(); oops(e); }
  }
}

function cancelSearch() {
  const q = $('#q');
  q.value = '';
  runSearch('');
  $('#btn-search-cancel').classList.remove('is-shown');
  q.blur();
}

/* One tab bar, one job per tab. The avatar button that used to sit at the far
   end opened the very same Settings panel as the gear beside it — two controls
   for one destination. Your profile now lives at the top of Settings, which is
   where people already look for it. */
async function goto(nav) {
  setActiveNav(nav);
  if (nav === 'settings') return openSettings();
  S.view = nav;
  $('#q').value = '';
  $('#btn-search-cancel').classList.remove('is-shown');
  openSide(null);
  if (nav === 'chats') { $('#list-title').textContent = 'Chats'; await loadFolders(); renderChatList(); }
  if (nav === 'people') await viewPeople();
  if (nav === 'calls') await viewCalls();
  if (nav === 'saved') await viewSaved();
}

function wireChrome() {
  $$('.rail-btn[data-nav]').forEach(btn => btn.onclick = async () => {
    // Every one of these can touch the network, and an unhandled rejection in
    // a tab handler is a tab that silently does nothing when tapped.
    try { await goto(btn.dataset.nav); } catch (e) { oops(e); }
  });

  $('#btn-new-group').onclick = e => popMenu([
    { label: 'New group', icon: 'group-add', onclick: () => newGroupFlow('group') },
    { label: 'New broadcast list', icon: 'broadcast', onclick: () => newGroupFlow('broadcast') },
    { sep: true },
    { label: 'Join with an invite link', icon: 'globe', onclick: async () => {
      const code = await promptBox('Join with invite', { label: 'Invite code or link' });
      if (!code) return;
      const id = await rpc('join_via_invite', { p_code: inviteCode(code) });
      await loadChats(); openChat(id);
    } },
  ], { anchor: e.currentTarget, title: 'Start something' });

  $('#btn-new-chat').onclick = async () => {
    const results = h('div', { class: 'stack' });
    const search = h('input', { placeholder: 'Name or email', oninput: async e => {
      const q = e.target.value.trim();
      clear(results);
      if (q.length < 1) return;
      const rows = await rpc('search_people', { p_query: q });
      rows.forEach(p => results.append(h('button', {
        class: 'btn', onclick: () => { closeModal(); startDm(p.id); },
      }, p.display_name)));
      if (!rows.length) results.append(h('p', { class: 'hint' }, 'Nobody by that name or email.'));
    } });
    modal(h('h3', { class: 'display' }, 'New chat'), h('label', {}, 'Find someone', search), results);
    search.focus();
  };

  $('#q').oninput = e => {
    runSearch(e.target.value);
    $('#btn-search-cancel').classList.toggle('is-shown', e.target.value.length > 0);
  };
  $('#q').addEventListener('focus', () => {
    if ($('#q').value) $('#btn-search-cancel').classList.add('is-shown');
  });
  $('#q').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); cancelSearch(); }
  });
  $('#btn-search-cancel').onclick = cancelSearch;
  // Previously this only toggled the CSS class, so the panel looked closed
  // but S.chat/S.msgs and the realtime subscription stayed pointed at that
  // chat — closeChat() does the full teardown instead.
  $('#btn-back').onclick = closeChat;
  $('#conv-id').onclick = openChatInfo;
  $('#btn-conv-more').onclick = convMenu;
  // The portrait in the header is now the way into a photo and a profile,
  // which is what tapping a face is supposed to do everywhere else.
  $('#btn-conv-photo').onclick = () => {
    const c = S.chat;
    if (!c) return;
    if (c.type === 'dm' && c.other_id) return openProfileCard(c.other_id);
    const photo = chatPhoto(c);
    photo ? openPhotoViewer(photo, c.name || '') : openChatInfo();
  };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal').open) { if (!$('#side').hidden) openSide(null); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#q').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && S.chat) { e.preventDefault(); searchInChat(); }
  });
  addEventListener('hashchange', routeHash);
}

/* Invite links get handled after a trip through the outside world — pasted
   into a chat app, previewed, shortened, re-encoded, occasionally truncated.
   decodeURIComponent() throws URIError ("URI malformed") on a percent escape
   that lost a character on the way, which is how sharing a link ended in an
   error toast for whoever had just signed up. A code that survived intact is
   decoded as before; one that didn't is passed through raw so the server gets
   the chance to accept or reject it on its own terms. */
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const inviteCode = raw => safeDecode(String(raw).trim().split('#').pop().split('/').filter(Boolean).pop() || '');

async function routeHash() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('join/')) {
    try {
      const id = await rpc('join_via_invite', { p_code: safeDecode(hash.slice(5)) });
      history.replaceState(null, '', '/');
      await loadChats(); openChat(id);
    } catch (e) { oops(e); }
  }
  if (hash.startsWith('chat/')) { history.replaceState(null, '', '/'); openChat(hash.slice(5)); }
}

function setupScreen() {
  hideBoot();
  const sec = $('#setup');
  sec.hidden = false;
  const why = envError();
  if (why) {
    const note = sec.querySelector('.muted');
    if (note) note.textContent = `${why} Paste the project URL and anon key again, or set them in Vercel.`;
  }
  $('#setup-save').onclick = () => {
    const url = normalizeUrl($('#setup-url').value);
    const key = normalizeKey($('#setup-key').value);
    if (!url) return toast('That project URL is not usable — it should read like https://abcd1234.supabase.co', true);
    if (!key) return toast('The anon key is missing.', true);
    try { saveEnvLocally(url, key); } catch (e) { return oops(e); }
    location.reload();
  };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

main().catch(e => fatal(e));
