import { initDb, sb, rpc } from './db.js';
import { saveEnvLocally } from './env.js';
import { S } from './state.js';
import { $, $$, h, clear, toast, oops, paintIcons, initials, modal, closeModal, promptBox, setActiveNav } from './util.js';
import { mountAuthUI, loadMe, twoStepGate, initIdentity, startPresence, signOut } from './auth.js';
import { applySettings, saveSettings } from './theme.js';
import { loadChats, loadFolders, renderChatList, openChat, closeChat, subscribeGlobal,
         updateBadge, newGroupFlow, startDm, renderConvHeader } from './chats.js';
import { warmAllCached } from './cache.js';
import { mountThread, loadMessages } from './thread.js';
import { mountComposer } from './composer.js';
import { mountCalls, setIceServers } from './calls.js';
import { openChatInfo, openDigest, searchInChat, runSearch, viewPeople, viewCalls,
         viewSaved, viewScheduled, openSide, personRow } from './panels.js';
import { openSettings } from './settings.js';
import { registerDevice, askPermission } from './notify.js';

const boot = $('#boot');

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
  if (!session) { boot.hidden = true; $('#auth').hidden = false; return; }
  start();
}

async function start() {
  try {
    $('#auth').hidden = true;
    await loadMe();
    if (!await twoStepGate()) return;
    boot.hidden = true;
    $('#app').hidden = false;

    $('#me-avatar').src = S.me.photo_url || avatarFallback(S.me.display_name);

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
  } catch (e) { oops(e); }
}

const avatarFallback = name => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#d9d2c7"/><text x="32" y="40" font-family="sans-serif" font-size="24" fill="#4a4438" text-anchor="middle">${initials(name)}</text></svg>`);

function cancelSearch() {
  const q = $('#q');
  q.value = '';
  runSearch('');
  $('#btn-search-cancel').classList.remove('is-shown');
  q.blur();
}

function wireChrome() {
  $$('.rail-btn[data-nav]').forEach(btn => btn.onclick = async () => {
    const nav = btn.dataset.nav;
    setActiveNav(nav);
    if (nav === 'settings') return openSettings();
    S.view = nav;
    $('#q').value = '';
    $('#btn-search-cancel').classList.remove('is-shown');
    openSide(null);
    if (nav === 'chats') { $('#list-title').textContent = 'Chats'; await loadFolders(); renderChatList(); }
    if (nav === 'people') viewPeople();
    if (nav === 'calls') viewCalls();
    if (nav === 'saved') viewSaved();
    if (nav === 'scheduled') viewScheduled();
  });

  $('#btn-me').onclick = openSettings;
  $('#btn-new-group').onclick = () => modal(h('h3', { class: 'display' }, 'Start something'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn', onclick: () => { closeModal(); newGroupFlow('group'); } }, 'New group'),
      h('button', { class: 'btn', onclick: () => { closeModal(); newGroupFlow('broadcast'); } }, 'New broadcast list'),
      h('button', {
        class: 'btn ghost', onclick: async () => {
          closeModal();
          const code = await promptBox('Join with invite', { label: 'Invite code or link' });
          if (!code) return;
          try {
            const id = await rpc('join_via_invite', { p_code: code.split('/').pop() });
            await loadChats(); openChat(id);
          } catch (e) { oops(e); }
        },
      }, 'Join with an invite link')));

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
  $('#btn-info').onclick = openChatInfo;
  $('#conv-id').onclick = openChatInfo;
  $('#btn-digest').onclick = () => openDigest();
  $('#btn-search-in').onclick = searchInChat;

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal').open) { if (!$('#side').hidden) openSide(null); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#q').focus(); }
  });
  addEventListener('hashchange', routeHash);
}

async function routeHash() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('join/')) {
    try {
      const id = await rpc('join_via_invite', { p_code: decodeURIComponent(hash.slice(5)) });
      history.replaceState(null, '', '/');
      await loadChats(); openChat(id);
    } catch (e) { oops(e); }
  }
  if (hash.startsWith('chat/')) { history.replaceState(null, '', '/'); openChat(hash.slice(5)); }
}

function setupScreen() {
  boot.hidden = true;
  $('#setup').hidden = false;
  $('#setup-save').onclick = () => {
    const url = $('#setup-url').value, key = $('#setup-key').value;
    if (!url || !key) return toast('Both fields, please.', true);
    saveEnvLocally(url, key);
    location.reload();
  };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

main();
