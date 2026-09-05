import { sb, rpc, sel, upd, del, ins, channel, drop } from './db.js';
import { S, emit, person } from './state.js';
import { $, $$, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox,
         shortWhen, initials, lastSeenText, iconEl, debounce, esc, setActiveNav } from './util.js';
import { applyWallpaper, applyContactAccent, applySettings } from './theme.js';
import { renderThread, appendMessage, patchStatus, patchReaction, loadMessages } from './thread.js';
import { notify } from './notify.js';

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
    const av = c.icon_url
      ? h('img', { class: 'av', src: c.icon_url, alt: '' })
      : h('div', { class: 'av' }, initials(c.name));
    const row = h('button', {
      class: 'row' + (S.chat?.chat_id === c.chat_id ? ' is-on' : ''),
      onclick: () => openChat(c.chat_id),
      oncontextmenu: e => { e.preventDefault(); chatMenu(c, e); },
    },
      av,
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' },
          h('span', { class: 'row-name' }, c.pinned ? '📌 ' : '', c.name || 'Chat'),
          c.type !== 'dm' && h('small', { class: 'hint' }, `${c.member_count}`)),
        h('div', { class: 'row-prev' },
          c.type !== 'dm' && c.last_body ? '' : '', previewText(c))),
      h('div', { class: 'row-side' },
        h('span', {}, shortWhen(c.last_at)),
        h('div', { class: 'dot-row' },
          c.unread > 0 && h('b', { class: 'pill' }, String(c.unread)),
          c.muted && '🔇', c.locked && '🔒', c.disappear_seconds > 0 && '⏳',
          c.e2ee && '🔐')));
    row.oncontextmenu = e => { e.preventDefault(); chatMenu(c, e); };
    let t;
    row.addEventListener('touchstart', () => { t = setTimeout(() => chatMenu(c), 550); }, { passive: true });
    row.addEventListener('touchend', () => clearTimeout(t));
    body.append(row);
    if (p?.is_online) row.querySelector('.row-name').append(' ', h('span', { class: 'hint' }, '•'));
  });
}

function chatMenu(c) {
  const act = (label, fn, cls = '') => h('button', {
    class: 'btn ' + cls, onclick: async () => { closeModal(); try { await fn(); } catch (e) { oops(e); } },
  }, label);
  const me = { chat_id: c.chat_id, user_id: S.me.id };
  modal(
    h('h3', { class: 'display' }, c.name || 'Chat'),
    h('div', { class: 'stack' },
      act(c.pinned ? 'Unpin' : 'Pin to top', async () => { await upd('chat_members', { pinned: !c.pinned }, me); loadChats(); }),
      act(c.muted ? 'Unmute' : 'Mute…', async () => {
        if (c.muted) { await upd('chat_members', { muted_until: null, mute_forever: false }, me); return loadChats(); }
        closeModal();
        modal(h('h3', { class: 'display' }, 'Mute for'), h('div', { class: 'stack' },
          ...[['8 hours', 8], ['1 week', 168]].map(([l, hrs]) => act(l, async () => {
            await upd('chat_members', { muted_until: new Date(Date.now() + hrs * 3600e3).toISOString() }, me); loadChats();
          })),
          act('Always', async () => { await upd('chat_members', { mute_forever: true }, me); loadChats(); })));
      }),
      act(c.archived ? 'Unarchive' : 'Archive', async () => { await upd('chat_members', { archived: !c.archived }, me); loadChats(); }),
      act('Mark as read', async () => { await rpc('mark_read', { p_chat: c.chat_id }); loadChats(); }),
      S.folders.length ? h('label', {}, 'Move to tab',
        h('select', {
          onchange: async e => { await upd('chat_members', { folder_id: e.target.value || null }, me); loadChats(); closeModal(); },
        }, h('option', { value: '' }, 'None'),
          ...S.folders.map(f => h('option', { value: f.id, selected: f.id === c.folder_id }, f.name)))) : null,
      act(c.locked ? 'Remove chat lock' : 'Lock chat with PIN…', async () => {
        if (c.locked) { await rpc('set_chat_lock', { p_chat: c.chat_id, p_pin: null }); }
        else {
          const pin = await promptBox('Chat lock', { label: 'PIN', type: 'password', note: 'Asked once per session before this chat opens.' });
          if (pin) await rpc('set_chat_lock', { p_chat: c.chat_id, p_pin: pin });
        }
        loadChats();
      }),
      act('Clear history', async () => {
        if (await confirmBox('Clear this history?', 'Only removes it for you. The other side keeps their copy.', 'Clear')) {
          await rpc('clear_history', { p_chat: c.chat_id });
          if (S.chat?.chat_id === c.chat_id) await loadMessages();
          loadChats();
        }
      }, 'danger'),
      act(c.type === 'dm' ? 'Delete chat' : 'Leave group', async () => {
        if (!await confirmBox(c.type === 'dm' ? 'Delete this chat?' : 'Leave this group?', 'You can always start over later.', 'Confirm')) return;
        await rpc('leave_chat', { p_chat: c.chat_id });
        if (S.chat?.chat_id === c.chat_id) closeChat();
        loadChats();
      }, 'danger')));
}

export function closeChat() {
  S.chatToken++; // cancel any openChat() still resolving in the background
  S.chat = null; S.msgs = []; S.selection.clear();
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
  $('#conv-empty').hidden = true;
  $('#conv-inner').hidden = false;
  $('#app').classList.add('on-conv');
  $('#select-bar').hidden = true;
  $('#reply-chip').hidden = true;
  renderConvHeader();
  renderThread(false);

  try {
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
    await loadMessages();
    if (myToken !== S.chatToken) return;
    applyWallpaper();
    if (c.type === 'dm') applyContactAccent(person(c.other_id)?.accent);
    subscribeChat(chatId);
    await rpc('mark_delivered', { p_chat: chatId }).catch(() => {});
    await rpc('mark_read', { p_chat: chatId }).catch(() => {});
    if (myToken !== S.chatToken) return;
    c.unread = 0;
    renderChatList(); updateBadge();
  } catch (e) { oops(e); }
}

export function renderConvHeader() {
  const c = S.chat; if (!c) return;
  const p = person(c.other_id);
  $('#conv-name').textContent = c.name || 'Chat';
  const img = $('#conv-avatar');
  if (c.icon_url) { img.src = c.icon_url; img.hidden = false; } else img.hidden = true;
  const typers = [...(S.typing.get(c.chat_id)?.keys() || [])].filter(u => u !== S.me.id);
  let sub;
  if (typers.length) sub = typers.length === 1 ? `${person(typers[0])?.display_name?.split(' ')[0] || 'Someone'} is typing…` : 'several people typing…';
  else if (c.type === 'dm') sub = lastSeenText(p) || (p?.about ?? '');
  else sub = S.members.map(m => m.user_id === S.me.id ? 'You' : (person(m.user_id)?.display_name || '')).slice(0, 6).join(', ');
  $('#conv-sub').textContent = [c.e2ee ? '🔐' : '', c.disappear_seconds ? '⏳' : '', sub].filter(Boolean).join(' ');
  $('#btn-call-video').hidden = c.type === 'broadcast';
  $('#btn-call-audio').hidden = c.type === 'broadcast';
}

/* ── realtime ──────────────────────────────────────────────────────────── */
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
        renderTyping();
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes' }, () => renderThread(false)));
}

export function subscribeGlobal() {
  channel('global', ch => ch
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async ({ new: m }) => {
      const mine = S.chats.find(c => c.chat_id === m.chat_id);
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

export function renderTyping() {
  const line = $('#typing-line'), c = S.chat;
  if (!c) return;
  const map = S.typing.get(c.chat_id) || new Map();
  const live = [...map.entries()].filter(([, ts]) => Date.now() - ts < 6000).map(([u]) => u);
  line.textContent = live.length
    ? (live.length === 1 ? `${person(live[0])?.display_name || 'Someone'} is typing…` : `${live.length} people typing…`)
    : '';
  renderConvHeader();
}
setInterval(() => { if (S.chat) renderTyping(); }, 3000);

export function updateBadge() {
  const n = S.chats.filter(c => !c.muted && !c.archived).reduce((a, c) => a + (c.unread || 0), 0);
  const b = $('#badge-unread');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
  document.title = n ? `(${n}) Wisp` : 'Wisp';
  if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge?.();
}

/* ── starting chats ────────────────────────────────────────────────────── */
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
