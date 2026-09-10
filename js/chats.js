import { sb, rpc, sel, upd, del, ins, channel, drop } from './db.js';
import { S, emit, person } from './state.js';
import { $, $$, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox, popMenu,
         longPress, shortWhen, initials, lastSeenText, iconEl, debounce, esc, setActiveNav, avatarData } from './util.js';
import { applyChatStyle, applyWallpaper, applySettings, rememberChatStyle } from './theme.js';
import { renderThread, appendMessage, patchStatus, patchReaction, loadMessages, applyCachedThread } from './thread.js';
import { notify } from './notify.js';
import { getMemThread, warmCache } from './cache.js';

export async function loadPeople(ids) {
  const need = [...new Set(ids.filter(Boolean))].filter(id => !S.people.has(id));
  if (!need.length) return;
  const rows = await rpc('people_info', { p_ids: need });
  rows.forEach(r => S.people.set(r.id, r));
}

export async function loadFolders() {
  S.folders = await sel('folders', { eq: { user_id: S.me.id }, order: ['position'] });
  renderFolders();
}

function renderFolders() {
  const wrap = clear($('#folders'));
  if (S.view !== 'chats') return;
  const chip = (label, key, count) => h('button', {
    class: 'chip' + (S.folder === key ? ' is-on' : ''),
    onclick: () => { S.folder = key; renderFolders(); renderChatList(); },
  }, count ? `${label} ${count}` : label);
  wrap.append(chip('All', null));
  const unread = S.chats.filter(c => c.unread > 0 && !c.archived).length;
  wrap.append(chip('Unread', 'unread', unread || ''));
  S.folders.forEach(f => {
    const c = wrap.appendChild(chip(f.name, f.id));
    c.oncontextmenu = async e => {
      e.preventDefault();
      if (await confirmBox(`Delete "${f.name}"?`, 'Chats inside it stay put, they just lose the tab.', 'Delete')) {
        await del('folders', { id: f.id });
        if (S.folder === f.id) S.folder = null;
        loadFolders();
      }
    };
  });
  wrap.append(chip('Archived', 'archived'));
  wrap.append(h('button', {
    class: 'chip add', onclick: async () => {
      const name = await promptBox('New tab', { label: 'Name', note: 'Drop chats into it from a chat\u2019s menu.' });
      if (!name) return;
      await ins('folders', { user_id: S.me.id, name, position: S.folders.length });
      loadFolders();
    },
  }, '+ Tab'));
}

export async function loadChats() {
  S.chats = await rpc('chat_overview');
  await loadPeople(S.chats.map(c => c.other_id));
  renderChatList();
  updateBadge();
  // Pull every chat's last-known thread up from disk into the synchronous
  // memory cache now, in the background — so by the time a chat actually
  // gets tapped, openChat() can paint it with no I/O wait at all.
  warmCache(S.chats.map(c => c.chat_id));
}

function matchesFolder(c) {
  if (S.folder === 'archived') return c.archived;
  if (c.archived) return false;
  if (S.folder === 'unread') return c.unread > 0;
  if (S.folder) return c.folder_id === S.folder;
  return true;
}

const previewText = c => {
  if (c.locked) return 'Locked chat';
  if (c.e2ee && !c.last_body) return 'Encrypted message';
  const kindWord = { image: '📷 Photo', video: '🎬 Video', voice: '🎙 Voice note', audio: '🎵 Audio',
    document: '📄 Document', location: '📍 Location', contact: '👤 Contact', poll: '📊 Poll', call: '📞 Call' };
  return c.last_body || kindWord[c.last_kind] || 'No messages yet';
};

export const chatPhoto = c => c.icon_url || (c.type === 'dm' ? person(c.other_id)?.photo_url : null) || null;

export function renderChatList() {
  if (S.view !== 'chats') return;
  const body = clear($('#list-body'));
  const rows = S.chats.filter(matchesFolder);
  if (!rows.length) {
    body.append(h('div', { class: 'empty' }, h('p', {}, 'Nothing here'),
      h('p', { class: 'hint' }, S.folder ? 'No chats in this tab yet.' : 'Find someone in People to start.')));
    return;
  }
  rows.forEach(c => {
    const p = person(c.other_id);
    const photo = chatPhoto(c);
    const av = photo
      ? h('img', { class: 'av', src: photo, alt: '' })
      : h('div', { class: 'av' }, initials(c.name));
    const row = h('button', {
      class: 'row' + (S.chat?.chat_id === c.chat_id ? ' is-on' : ''),
      // A long press that opened the menu must not also open the chat when the
      // finger lifts — longPress() flags the element, this clears the flag.
      onclick: e => {
        if (row.dataset.pressed) { delete row.dataset.pressed; return; }
        openChat(c.chat_id);
      },
      oncontextmenu: e => { e.preventDefault(); chatMenu(c, { x: e.clientX, y: e.clientY }); },
    },
      av,
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' },
          h('span', { class: 'row-name' }, c.pinned ? '📌 ' : '', c.name || 'Chat'),
          c.type !== 'dm' && h('small', { class: 'hint' }, `${c.member_count}`)),
        h('div', { class: 'row-prev' }, previewText(c))),
      h('div', { class: 'row-side' },
        h('span', {}, shortWhen(c.last_at)),
        h('div', { class: 'dot-row' },
          c.unread > 0 && h('b', { class: 'pill' }, String(c.unread)),
          c.muted && '🔇', c.locked && '🔒', c.disappear_seconds > 0 && '⏳',
          c.e2ee && '🔐')));
    longPress(row, at => chatMenu(c, at));
    body.append(row);
    if (p?.is_online) row.querySelector('.row-name').append(' ', h('span', { class: 'online-dot', title: 'online' }));
  });
}

/* A real context menu at the finger, not a full-width dialog in the middle of
   the screen. Only the things you'd actually reach for on a long press live
   here; the rest (chat lock, clearing history, moving to a tab) sits in the
   chat's own details panel, where there's room to explain what it does. */
function chatMenu(c, at = {}) {
  const me = { chat_id: c.chat_id, user_id: S.me.id };
  const items = [
    c.type === 'dm'
      ? { label: 'View profile', icon: 'person', onclick: async () => (await import('./panels.js')).openProfileCard(c.other_id) }
      : { label: 'Group info', icon: 'info', onclick: async () => { await openChat(c.chat_id); (await import('./panels.js')).openChatInfo(); } },
    { label: c.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', on: c.pinned,
      onclick: async () => { await upd('chat_members', { pinned: !c.pinned }, me); loadChats(); } },
    { label: c.muted ? 'Unmute' : 'Mute', icon: c.muted ? 'bell' : 'bell-off', on: c.muted,
      onclick: async () => {
        if (c.muted) { await upd('chat_members', { muted_until: null, mute_forever: false }, me); return loadChats(); }
        popMenu([
          { label: 'For 8 hours', icon: 'clock', onclick: async () => { await upd('chat_members', { muted_until: new Date(Date.now() + 8 * 3600e3).toISOString() }, me); loadChats(); } },
          { label: 'For a week', icon: 'clock', onclick: async () => { await upd('chat_members', { muted_until: new Date(Date.now() + 168 * 3600e3).toISOString() }, me); loadChats(); } },
          { label: 'Always', icon: 'bell-off', onclick: async () => { await upd('chat_members', { mute_forever: true }, me); loadChats(); } },
        ], { ...at, title: 'Mute ' + (c.name || 'chat') });
      } },
    c.unread > 0 && { label: 'Mark as read', icon: 'check',
      onclick: async () => { await rpc('mark_read', { p_chat: c.chat_id }); loadChats(); } },
    { label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', on: c.archived,
      onclick: async () => { await upd('chat_members', { archived: !c.archived }, me); loadChats(); } },
    { label: 'Theme & wallpaper', icon: 'palette',
      onclick: async () => { await openChat(c.chat_id); (await import('./panels.js')).openChatStyle(); } },
    { sep: true },
    { label: c.type === 'dm' ? 'Delete chat' : 'Leave group', icon: 'trash', danger: true,
      onclick: async () => {
        if (!await confirmBox(c.type === 'dm' ? 'Delete this chat?' : 'Leave this group?', 'You can always start over later.', 'Confirm')) return;
        await rpc('leave_chat', { p_chat: c.chat_id });
        if (S.chat?.chat_id === c.chat_id) closeChat();
        loadChats();
      } },
  ];
  popMenu(items, { ...at, title: c.name || 'Chat' });
}

export function closeChat() {
  S.chatToken++; // cancel any openChat() still resolving in the background
  S.chat = null; S.msgs = []; S.selection.clear(); S.msgsReady = false;
  drop('chat');
  $('#conv-inner').hidden = true;
  $('#conv-empty').hidden = false;
  $('#app').classList.remove('on-conv');
  applySettings();
  renderChatList();
}

export async function openChat(chatId) {
  const c = S.chats.find(x => x.chat_id === chatId);
  if (!c) { await loadChats(); return openChat(chatId); }

  // Every call gets its own token. If a newer openChat() (or closeChat())
  // starts before this one finishes, S.chatToken moves on and every check
  // below bails out — so a slow/racing load can never overwrite what the
  // user is actually looking at with a different chat's data.
  const myToken = ++S.chatToken;

  if (c.locked && !S.unlocked.has(chatId)) {
    const pin = await promptBox('Locked chat', { label: 'PIN', type: 'password' });
    if (myToken !== S.chatToken) return;
    if (!pin) return;
    if (!await rpc('verify_chat_lock', { p_chat: chatId, p_pin: pin })) return toast('Wrong PIN.', true);
    if (myToken !== S.chatToken) return;
    S.unlocked.add(chatId);
  }

  // Switch and blank the thread *before* any network round trip. Previously
  // the old messages stayed on screen — under the new chat's name — until
  // the fetch below resolved; on a slow connection that's the "opens Mercy,
  // shows the other chat's messages" bug. Now there's never a moment where
  // a chat you're not in is still visible.
  S.chat = c; S.msgs = []; S.members = []; S.selection.clear(); S.replyTo = null;
  S.msgsReady = false;
  // This chat's own accent and wallpaper, right now, synchronously, before
  // anything paints a pixel. Per-chat appearance lives on chat_members, which
  // hasn't loaded yet at this point — so applyChatStyle() falls back to the
  // small localStorage cache written the last time this chat was open on this
  // device, then to the contact accent, then to the account's. No flash of the
  // wrong colour and no flash of the wrong wallpaper.
  applyChatStyle();
  // Synchronous, zero-latency: if this chat is already warm in memory (see
  // warmCache()/warmAllCached()), paint its real history right now, in the
  // same tick as the tap — never a blank frame before it, not even briefly.
  applyCachedThread(getMemThread(chatId));
  $('#conv-empty').hidden = true;
  $('#conv-inner').hidden = false;
  $('#app').classList.add('on-conv');
  $('#select-bar').hidden = true;
  $('#reply-chip').hidden = true;
  renderConvHeader();
  renderThread(true);

  try {
    // Kick the message load off immediately, in parallel with the lookups
    // below, instead of behind them. loadMessages() paints cached history
    // (if any) with no network wait at all, so the chat's content shows up
    // the instant you tap it — member/star/bookmark context fills in
    // around it a beat later rather than gating the whole thread on itself.
    const messagesP = loadMessages();

    S.members = await sel('chat_members', { select: '*', eq: { chat_id: chatId } });
    if (myToken !== S.chatToken) return;
    rememberChatStyle();
    applyChatStyle();
    await loadPeople(S.members.map(m => m.user_id));
    const [stars, marks] = await Promise.all([
      sel('stars', { eq: { user_id: S.me.id } }),
      sel('bookmarks', { eq: { user_id: S.me.id } }),
    ]);
    if (myToken !== S.chatToken) return;
    S.starred = new Set(stars.map(s => s.message_id));
    S.bookmarked = new Set(marks.map(s => s.message_id));

    renderConvHeader();
    await messagesP;
    if (myToken !== S.chatToken) return;
    // Member/star/bookmark context may have landed after the first paint(s)
    // above — one cheap re-render (no re-scroll) makes sure author names,
    // stars, and bookmarks reflect it instead of waiting for the next change.
    renderThread(false);
    applyWallpaper();
    subscribeChat(chatId);
    await rpc('mark_delivered', { p_chat: chatId }).catch(() => {});
    await rpc('mark_read', { p_chat: chatId }).catch(() => {});
    if (myToken !== S.chatToken) return;
    c.unread = 0;
    renderChatList(); updateBadge();
  } catch (e) { oops(e); }
}

// Single source of truth for "who's typing right now" in a chat: entries
// older than 6s are treated as stale (in case a DELETE event was ever
// missed) so the indicator can't get stuck on forever.
function activeTypers(chatId) {
  const map = S.typing.get(chatId) || new Map();
  const now = Date.now();
  return [...map.entries()].filter(([u, ts]) => u !== S.me.id && now - ts < 6000).map(([u]) => u);
}

export function renderConvHeader() {
  const c = S.chat; if (!c) return;
  const p = person(c.other_id);
  $('#conv-name').textContent = c.name || 'Chat';
  const img = $('#conv-avatar');
  // Always something to look at, and always tappable: the header portrait is
  // the way into someone's photo and profile now, so it can't be missing.
  img.src = chatPhoto(c) || avatarData(c.name || 'Chat');
  const typers = activeTypers(c.chat_id);
  let sub;
  if (typers.length) sub = typers.length === 1 ? `${person(typers[0])?.display_name?.split(' ')[0] || 'Someone'} is typing\u2026` : `${typers.length} people typing\u2026`;
  else if (c.type === 'dm') sub = lastSeenText(p) || (p?.about ?? '');
  else sub = S.members.map(m => m.user_id === S.me.id ? 'You' : (person(m.user_id)?.display_name || '')).filter(Boolean).slice(0, 6).join(', ');
  $('#conv-sub').textContent = [c.e2ee ? '🔐' : '', c.disappear_seconds ? '⏳' : '', sub].filter(Boolean).join(' ');
  $('#btn-call-video').hidden = c.type === 'broadcast';
  $('#btn-call-audio').hidden = c.type === 'broadcast';
}

/* ── realtime ────────────────────────────────────────────────────────── */
export function subscribeChat(chatId) {
  channel('chat', ch => ch
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      async ({ new: m }) => {
        if (S.msgs.some(x => x.id === m.id)) return;
        await appendMessage(m);
        if (m.sender_id !== S.me.id) {
          rpc('mark_delivered', { p_chat: chatId }).catch(() => {});
          if (document.visibilityState === 'visible') rpc('mark_read', { p_chat: chatId }).catch(() => {});
        }
      })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      ({ new: m }) => { const i = S.msgs.findIndex(x => x.id === m.id); if (i >= 0) { S.msgs[i] = { ...S.msgs[i], ...m }; renderThread(false); } })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' },
      ({ old }) => { const i = S.msgs.findIndex(x => x.id === old.id); if (i >= 0) { S.msgs.splice(i, 1); renderThread(false); } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_status' }, patchStatus)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, patchReaction)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'typing', filter: `chat_id=eq.${chatId}` },
      ({ new: t, eventType }) => {
        if (!t?.user_id || t.user_id === S.me.id) return;
        const map = S.typing.get(chatId) || new Map();
        eventType === 'DELETE' ? map.delete(t.user_id) : map.set(t.user_id, Date.now());
        S.typing.set(chatId, map);
        renderConvHeader();
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes' }, () => renderThread(false)));
}

export function subscribeGlobal() {
  channel('global', ch => ch
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async ({ new: m }) => {
      await loadChats();
      if (m.sender_id === S.me.id) return;
      if (S.chat?.chat_id === m.chat_id && document.visibilityState === 'visible') return;
      const c = S.chats.find(x => x.chat_id === m.chat_id);
      if (!c || c.muted || S.settings.focus_mode || inQuietHours()) return;
      notify(c, m);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members', filter: `user_id=eq.${S.me.id}` }, () => loadChats())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'presence' }, async ({ new: p }) => {
      const old = S.people.get(p.user_id);
      if (old) { S.people.set(p.user_id, { ...old, is_online: p.is_online, last_seen: p.last_seen }); renderConvHeader(); }
    }));
}

export function inQuietHours() {
  const s = S.settings;
  if (!s?.quiet_from || !s?.quiet_to) return false;
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = s.quiet_from.split(':').map(Number), [th, tm] = s.quiet_to.split(':').map(Number);
  const a = fh * 60 + fm, b = th * 60 + tm;
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

// Sweeps the header's typing text away on its own once entries go stale,
// even if no DELETE event ever arrives for them.
setInterval(() => { if (S.chat) renderConvHeader(); }, 3000);

export function updateBadge() {
  const n = S.chats.filter(c => !c.muted && !c.archived).reduce((a, c) => a + (c.unread || 0), 0);
  const b = $('#badge-unread');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
  document.title = n ? `(${n}) Wisp` : 'Wisp';
  if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge?.();
}

/* ── starting chats ───────────────────────────────────────────────────── */
export async function startDm(userId) {
  const id = await rpc('get_or_create_dm', { p_other: userId });
  await loadChats();
  setActiveNav('chats');
  S.view = 'chats'; $('#list-title').textContent = 'Chats';
  renderFolders(); renderChatList();
  return openChat(id);
}

export async function newGroupFlow(type = 'group') {
  const picked = new Set();
  const nameIn = h('input', { placeholder: type === 'broadcast' ? 'List name' : 'Group name' });
  const results = h('div', { class: 'stack' });
  const search = h('input', { placeholder: 'Search people by name or email' });
  const draw = rows => {
    clear(results);
    rows.forEach(r => results.append(h('label', { class: 'member' },
      h('input', {
        type: 'checkbox', checked: picked.has(r.id),
        onchange: e => e.target.checked ? picked.add(r.id) : picked.delete(r.id),
      }), h('div', { class: 'av' }, initials(r.display_name)), r.display_name)));
  };
  search.oninput = debounce(async () => {
    if (search.value.trim().length < 1) return clear(results);
    draw(await rpc('search_people', { p_query: search.value.trim() }));
  }, 220);
  modal(
    h('h3', { class: 'display' }, type === 'broadcast' ? 'New broadcast list' : 'New group'),
    type === 'broadcast' && h('p', { class: 'hint' }, 'Everyone gets your message individually. Replies come back to you only.'),
    h('label', {}, 'Name', nameIn),
    h('label', {}, 'Members', search), results,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          if (!nameIn.value.trim()) return toast('Give it a name.', true);
          try {
            const id = await rpc('create_group', {
              p_name: nameIn.value.trim(), p_members: [...picked], p_type: type,
            });
            closeModal(); await loadChats(); openChat(id);
          } catch (e) { oops(e); }
        },
      }, 'Create')));
}

export const refreshChat = debounce(() => loadChats(), 400);
