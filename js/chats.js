import { sb, rpc, sel, upd, del, ins, channel, drop } from './db.js';
import { S, emit, person } from './state.js';
import { $, $$, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox,
         shortWhen, initials, lastSeenText, icon, iconEl, inlineIcon, kindIcon, KIND_WORD,
         actionSheet, longPress, debounce, esc, setActiveNav } from './util.js';
import { applyWallpaper, applyContactAccent, applySettings } from './theme.js';
import { renderThread, appendMessage, patchStatus, patchReaction, loadMessages, applyCachedThread } from './thread.js';
import { notify } from './notify.js';
import { getMemThread, warmCache } from './cache.js';
import { renderChatBar, muteSheet } from './chatbar.js';

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
  const chip = (label, key, { count, glyph } = {}) => {
    const b = h('button', {
      class: 'chip' + (S.folder === key ? ' is-on' : ''),
      onclick: () => { S.folder = key; renderFolders(); renderChatList(); },
    });
    if (glyph) b.innerHTML = inlineIcon(glyph, 13) + ' ';
    b.append(label + (count ? ` ${count}` : ''));
    return b;
  };
  wrap.append(chip('All', null));
  const unread = S.chats.filter(c => c.unread > 0 && !c.archived).length;
  wrap.append(chip('Unread', 'unread', { count: unread || '' }));
  S.folders.forEach(f => {
    const c = wrap.appendChild(chip(f.name, f.id, { glyph: 'folder' }));
    const remove = async () => {
      if (await confirmBox(`Delete "${f.name}"?`, 'Chats inside it stay put, they just lose the tab.', 'Delete')) {
        await del('folders', { id: f.id });
        if (S.folder === f.id) S.folder = null;
        loadFolders();
      }
    };
    c.oncontextmenu = e => { e.preventDefault(); remove(); };
    longPress(c, remove);
  });
  wrap.append(chip('Archived', 'archived', { glyph: 'archive' }));
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
  // chat_overview hands back fresh objects every time, so the open chat's
  // row has to be re-pointed or the header and the control bar keep showing
  // whatever mute/archive/pin state it had when it was opened.
  if (S.chat) {
    const fresh = S.chats.find(x => x.chat_id === S.chat.chat_id);
    if (fresh) { S.chat = fresh; renderConvHeader(); renderChatBar(); }
  }
  renderChatList();
  updateBadge();
  // Pull every chat's last-known thread up from disk into the synchronous
  // memory cache now, in the background.
  warmCache(S.chats.map(c => c.chat_id));
}

function matchesFolder(c) {
  if (S.folder === 'archived') return c.archived;
  if (c.archived) return false;
  if (S.folder === 'unread') return c.unread > 0;
  if (S.folder) return c.folder_id === S.folder;
  return true;
}

/* Preview line: a real glyph plus a word, instead of an emoji that renders
   differently on every platform and never matches the accent. */
function previewNodes(c) {
  if (c.locked) return [iconEl('lock', 14), 'Locked chat'];
  if (c.e2ee && !c.last_body) return [iconEl('shield-lock', 14), 'Encrypted message'];
  if (c.last_body) return [c.last_body];
  if (c.last_kind && KIND_WORD[c.last_kind]) return [iconEl(kindIcon(c.last_kind), 14), KIND_WORD[c.last_kind]];
  return ['No messages yet'];
}

export function renderChatList() {
  if (S.view !== 'chats') return;
  const body = clear($('#list-body'));
  const rows = S.chats.filter(matchesFolder);
  if (!rows.length) {
    body.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-ico', html: icon(S.folder === 'archived' ? 'archive' : 'chat', 24) }),
      h('b', {}, S.folder === 'archived' ? 'Nothing archived' : 'Nothing here'),
      h('p', { class: 'hint' }, S.folder ? 'No chats in this tab yet.' : 'Find someone in People to start.')));
    return;
  }
  rows.forEach(c => {
    const p = person(c.other_id);
    const av = c.icon_url
      ? h('img', { class: 'av', src: c.icon_url, alt: '' })
      : h('div', { class: 'av' }, initials(c.name));
    const avatar = h('div', { class: 'avatar-wrap' }, av,
      c.type === 'dm' && p?.is_online && h('span', { class: 'presence', title: 'online' }));

    const flags = h('div', { class: 'dot-row' },
      c.unread > 0 && h('b', { class: 'pill' }, String(c.unread)),
      c.muted && h('span', { class: 'row-flag', title: 'Muted' }, iconEl('bell-off', 14)),
      c.locked && h('span', { class: 'row-flag', title: 'Locked' }, iconEl('lock', 14)),
      c.disappear_seconds > 0 && h('span', { class: 'row-flag', title: 'Disappearing messages' }, iconEl('hourglass', 14)),
      c.e2ee && h('span', { class: 'row-flag', title: 'Encrypted' }, iconEl('shield-lock', 14)));

    const row = h('button', {
      class: 'row' + (S.chat?.chat_id === c.chat_id ? ' is-on' : ''),
      onclick: () => openChat(c.chat_id),
    },
      avatar,
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' },
          h('span', { class: 'row-name' },
            c.pinned && h('span', { class: 'row-flag accent', title: 'Pinned' }, iconEl('pin', 13)),
            c.name || 'Chat'),
          c.type !== 'dm' && h('small', { class: 'hint' }, String(c.member_count))),
        h('div', { class: 'row-prev' }, previewNodes(c))),
      h('div', { class: 'row-side' }, h('span', {}, shortWhen(c.last_at)), flags));
    row.oncontextmenu = e => { e.preventDefault(); chatMenu(c); };
    longPress(row, () => chatMenu(c));
    body.append(row);
  });
}

/* One organized sheet for everything a chat can do. Reached from the row
   (right-click / long-press) and from More on the control bar. */
export function chatMenu(c) {
  const me = { chat_id: c.chat_id, user_id: S.me.id };
  const after = async () => { await loadChats(); };
  const items = [
    {
      icon: c.pinned ? 'pin-off' : 'pin', label: c.pinned ? 'Unpin' : 'Pin to top',
      onclick: async () => { await upd('chat_members', { pinned: !c.pinned }, me); await after(); },
    },
    {
      icon: c.muted ? 'bell' : 'bell-off', label: c.muted ? 'Unmute' : 'Mute',
      note: c.muted ? 'Notifications are off for this chat' : null,
      onclick: async () => {
        if (!c.muted) return muteSheet(c);
        await upd('chat_members', { muted_until: null, mute_forever: false }, me);
        await after();
      },
    },
    {
      icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Unarchive' : 'Archive',
      onclick: async () => { await upd('chat_members', { archived: !c.archived }, me); await after(); },
    },
    {
      icon: 'check-double', label: 'Mark as read',
      onclick: async () => { await rpc('mark_read', { p_chat: c.chat_id }); await after(); },
    },
    {
      icon: 'palette', label: 'Display', note: 'Theme, text size, wallpaper',
      onclick: async () => (await import('./chatbar.js')).openDisplay(),
    },
    {
      icon: 'info', label: 'Details', note: c.type === 'dm' ? 'Nickname, accent, block' : 'Members, permissions, invite',
      onclick: async () => {
        if (S.chat?.chat_id !== c.chat_id) await openChat(c.chat_id);
        (await import('./panels.js')).openChatInfo();
      },
    },
    S.folders.length ? {
      node: h('label', { class: 'sheet-row', style: { display: 'flex' } },
        h('span', { class: 'sheet-ico', html: icon('folder', 19) }),
        h('span', { class: 'sheet-label' }, h('b', {}, 'Move to tab'),
          h('select', {
            onchange: async e => {
              closeModal();
              try { await upd('chat_members', { folder_id: e.target.value || null }, me); await after(); }
              catch (err) { oops(err); }
            },
          }, h('option', { value: '' }, 'None'),
            ...S.folders.map(f => h('option', { value: f.id, selected: f.id === c.folder_id }, f.name))))),
    } : null,
    {
      icon: c.locked ? 'unlock' : 'lock', label: c.locked ? 'Remove chat lock' : 'Lock with a PIN',
      note: c.locked ? null : 'Asked once per session before this chat opens',
      onclick: async () => {
        if (c.locked) { await rpc('set_chat_lock', { p_chat: c.chat_id, p_pin: null }); }
        else {
          const pin = await promptBox('Chat lock', { label: 'PIN', type: 'password' });
          if (!pin) return;
          await rpc('set_chat_lock', { p_chat: c.chat_id, p_pin: pin });
        }
        await after();
      },
    },
    {
      icon: 'eraser', label: 'Clear history', danger: true,
      onclick: async () => {
        if (!await confirmBox('Clear this history?', 'Only removes it for you. The other side keeps their copy.', 'Clear')) return;
        await rpc('clear_history', { p_chat: c.chat_id });
        if (S.chat?.chat_id === c.chat_id) await loadMessages();
        await after();
      },
    },
    {
      icon: c.type === 'dm' ? 'trash' : 'log-out', label: c.type === 'dm' ? 'Delete chat' : 'Leave group',
      danger: true,
      onclick: async () => {
        if (!await confirmBox(c.type === 'dm' ? 'Delete this chat?' : 'Leave this group?', 'You can always start over later.', 'Confirm')) return;
        await rpc('leave_chat', { p_chat: c.chat_id });
        if (S.chat?.chat_id === c.chat_id) closeChat();
        await after();
      },
    },
  ];
  actionSheet(c.name || 'Chat', items);
}

export function closeChat() {
  S.chatToken++; // cancel any openChat() still resolving in the background
  S.chat = null; S.msgs = []; S.selection.clear(); S.msgsReady = false;
  drop('chat');
  $('#conv-inner').hidden = true;
  $('#conv-empty').hidden = false;
  $('#chatbar').hidden = true;
  $('#app').classList.remove('on-conv');
  applySettings();
  renderChatList();
}

export async function openChat(chatId) {
  const c = S.chats.find(x => x.chat_id === chatId);
  if (!c) { await loadChats(); return openChat(chatId); }

  // Every call gets its own token. If a newer openChat() (or closeChat())
  // starts before this one finishes, S.chatToken moves on and every check
  // below bails out.
  const myToken = ++S.chatToken;

  if (c.locked && !S.unlocked.has(chatId)) {
    const pin = await promptBox('Locked chat', { label: 'PIN', type: 'password' });
    if (myToken !== S.chatToken) return;
    if (!pin) return;
    if (!await rpc('verify_chat_lock', { p_chat: chatId, p_pin: pin })) return toast('Wrong PIN.', true);
    if (myToken !== S.chatToken) return;
    S.unlocked.add(chatId);
  }

  // Switch and blank the thread *before* any network round trip, so there is
  // never a moment where a chat you are not in is still visible.
  S.chat = c; S.msgs = []; S.members = []; S.selection.clear(); S.replyTo = null;
  S.msgsReady = false;
  // Set this chat's accent synchronously, before anything paints, otherwise
  // the thread renders a frame in the previous chat's colour and visibly
  // swaps once members load.
  applyContactAccent(c.type === 'dm' ? person(c.other_id)?.accent : null);
  // Zero-latency: if this chat is warm in memory, paint its real history in
  // the same tick as the tap.
  applyCachedThread(getMemThread(chatId));
  $('#conv-empty').hidden = true;
  $('#conv-inner').hidden = false;
  $('#app').classList.add('on-conv');
  $('#select-bar').hidden = true;
  $('#reply-chip').hidden = true;
  renderConvHeader();
  renderChatBar();
  renderThread(true);

  try {
    // Kick the message load off in parallel with the lookups below.
    const messagesP = loadMessages();

    S.members = await sel('chat_members', { select: '*', eq: { chat_id: chatId } });
    if (myToken !== S.chatToken) return;
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

// Single source of truth for "who's typing right now": entries older than 6s
// are treated as stale, so the indicator cannot get stuck on forever.
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
  if (c.icon_url) { img.src = c.icon_url; img.hidden = false; } else img.hidden = true;
  const typers = activeTypers(c.chat_id);
  let sub;
  if (typers.length) sub = typers.length === 1 ? `${person(typers[0])?.display_name?.split(' ')[0] || 'Someone'} is typing\u2026` : `${typers.length} people typing\u2026`;
  else if (c.type === 'dm') sub = lastSeenText(p) || (p?.about ?? '');
  else sub = S.members.map(m => m.user_id === S.me.id ? 'You' : (person(m.user_id)?.display_name || '')).filter(Boolean).slice(0, 6).join(', ');
  // Glyphs, not emoji: these sit inline in the subtitle and have to follow
  // the text colour and scale like the rest of the type does.
  const marks = [
    c.e2ee ? inlineIcon('shield-lock', 13) : '',
    c.disappear_seconds ? inlineIcon('hourglass', 13) : '',
    c.muted ? inlineIcon('bell-off', 13) : '',
  ].filter(Boolean).join('');
  $('#conv-sub').innerHTML = marks + (sub ? `<span>${esc(sub)}</span>` : '');
  $('#btn-call-video').hidden = c.type === 'broadcast';
  $('#btn-call-audio').hidden = c.type === 'broadcast';
}

/* ── realtime ────────────────────────────────────────────────── */
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

// Same rules the push function applies server-side, so an in-app
// notification and a background one can never disagree: mute wins, then
// focus mode and quiet hours, then the per-chat level.
function mentionsMe(m) {
  const handle = (S.me?.display_name || '').replace(/\s+/g, '').toLowerCase();
  if (!handle || !m?.body) return false;
  return String(m.body).toLowerCase().includes('@' + handle);
}
function shouldNotify(c, m) {
  if (!c || c.muted) return false;
  if (S.settings.focus_mode || inQuietHours()) return false;
  const level = c.notify_level || 'all';
  if (level === 'none') return false;
  if (level === 'mentions' && !mentionsMe(m)) return false;
  return true;
}

export function subscribeGlobal() {
  channel('global', ch => ch
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async ({ new: m }) => {
      await loadChats();
      if (m.sender_id === S.me.id) return;
      if (m.kind === 'system') return;
      if (S.chat?.chat_id === m.chat_id && document.visibilityState === 'visible') return;
      const c = S.chats.find(x => x.chat_id === m.chat_id);
      if (!shouldNotify(c, m)) return;
      notify(c, m);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members', filter: `user_id=eq.${S.me.id}` }, () => loadChats())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'presence' }, async ({ new: p }) => {
      const old = S.people.get(p.user_id);
      if (old) {
        S.people.set(p.user_id, { ...old, is_online: p.is_online, last_seen: p.last_seen });
        renderConvHeader();
        if (S.view === 'chats') renderChatList();
      }
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

/* ── starting chats ───────────────────────────────────────────── */
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
    if (!rows.length) return void results.append(h('p', { class: 'hint' }, 'Nobody by that name or email.'));
    rows.forEach(r => results.append(h('label', { class: 'member' },
      h('input', {
        type: 'checkbox', checked: picked.has(r.id),
        onchange: e => e.target.checked ? picked.add(r.id) : picked.delete(r.id),
      }), h('div', { class: 'av' }, initials(r.display_name)), r.display_name)));
  };
  search.oninput = debounce(async () => {
    if (search.value.trim().length < 1) return clear(results);
    try { draw(await rpc('search_people', { p_query: search.value.trim() })); } catch (e) { oops(e); }
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
