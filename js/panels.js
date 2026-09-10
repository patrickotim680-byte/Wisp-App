import { sb, rpc, sel, ins, upd, del, upload } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, $$, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox, popMenu, longPress,
         initials, shortWhen, clock, dur, bytes, iconEl, debounce, lastSeenText, avatarData, copyText } from './util.js';
import { applyWallpaper, applyChatStyle, saveSettings, saveChatStyle, startStyleDraft, setStyleDraft,
         cancelStyleDraft, styleDraft, paintWall, WALLPAPERS, ACCENTS, toCustom } from './theme.js';
import { thumbUrl, compressImage } from './media.js';
import { jumpTo } from './thread.js';

export function openSide(node) {
  const side = $('#side'), app = $('#app');
  if (!node) { side.hidden = true; app.classList.remove('has-side'); return; }
  clear(side).append(node);
  side.hidden = false; app.classList.add('has-side');
  side.scrollTop = 0;
}

function filePick(accept, cb) {
  const i = h('input', { type: 'file', accept, hidden: true, onchange: e => e.target.files[0] && cb(e.target.files[0]) });
  document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
}

const sideHead = (title, onBack, backLabel = 'Close') => h('div', { class: 'side-head' },
  h('h3', { class: 'display' }, title),
  h('button', { class: 'btn small ghost', onclick: onBack }, backLabel));

const seg = (label, control, note) => h('div', { class: 'kv' },
  h('div', {}, h('span', { style: { color: 'var(--ink)' } }, label), note && h('div', { class: 'hint' }, note)), control);

const sw = (val, fn) => {
  const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!val) });
  b.onclick = async () => {
    const n = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(n));
    try { await fn(n); } catch (e) { oops(e); b.setAttribute('aria-checked', String(!n)); }
  };
  return b;
};

/* ── photo viewer ───────────────────────────────────────────────────────
   Tapping a portrait anywhere in the app lands here. It used to land nowhere
   at all: avatars were decoration, and the only large copy of anyone's photo
   was the 84px one in the details panel. */
export function openPhotoViewer(url, name = '') {
  if (!url) return toast('No photo has been set.');
  const layer = h('div', { class: 'photo-view' });
  const close = () => {
    layer.classList.remove('is-open');
    removeEventListener('keydown', onKey, true);
    setTimeout(() => layer.remove(), 200);
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  layer.append(
    h('div', { class: 'photo-bar' },
      h('button', { class: 'icon-btn', title: 'Close', onclick: close }, iconEl('x', 20)),
      h('b', {}, name || ''),
      h('a', { class: 'icon-btn', href: url, download: '', target: '_blank', rel: 'noopener', title: 'Open full size' }, iconEl('download', 20))),
    h('figure', { class: 'photo-frame' },
      h('img', { src: url, alt: name || 'Photo', onerror: e => { e.target.replaceWith(h('p', { class: 'hint' }, 'That photo could not be loaded.')); } })));
  layer.addEventListener('click', e => { if (e.target === layer || e.target.closest('.photo-frame')) close(); });
  document.body.append(layer);
  addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => layer.classList.add('is-open'));
}

/* ── profile card ───────────────────────────────────────────────── */
export async function openProfileCard(userId) {
  let p = person(userId);
  if (!p) {
    try {
      const [fresh] = await rpc('people_info', { p_ids: [userId] });
      if (fresh) { S.people.set(userId, fresh); p = fresh; }
    } catch (e) { return oops(e); }
  }
  if (!p) return toast('That profile is not available.', true);
  const photo = p.photo_url || null;
  const act = (label, icon, fn) => h('button', { class: 'btn', onclick: async () => { closeModal(); try { await fn(); } catch (e) { oops(e); } } },
    iconEl(icon, 17), label);
  modal(
    h('div', { class: 'profile-card' },
      h('button', {
        class: 'profile-face', title: photo ? 'View photo' : 'No photo set',
        onclick: () => {
          if (!photo) return toast(`${p.display_name} has not set a photo.`);
          closeModal(); openPhotoViewer(photo, p.display_name);
        },
      }, h('img', { src: photo || avatarData(p.display_name), alt: p.display_name }),
        photo && h('span', { class: 'profile-zoom' }, iconEl('eye', 15))),
      h('b', { class: 'display' }, p.nickname || p.display_name),
      p.nickname && h('small', { class: 'hint' }, p.display_name),
      h('small', { class: 'hint' }, lastSeenText(p) || ''),
      p.about && h('p', { class: 'muted' }, p.about),
      h('div', { class: 'profile-acts' },
        act('Message', 'chat', async () => (await import('./chats.js')).startDm(p.id)),
        act('Voice', 'call', async () => {
          await (await import('./chats.js')).startDm(p.id);
          (await import('./calls.js')).startCall('audio');
        }),
        act('Video', 'video', async () => {
          await (await import('./chats.js')).startDm(p.id);
          (await import('./calls.js')).startCall('video');
        }))),
    h('div', { class: 'modal-actions' },
      p.email && h('button', { class: 'btn ghost', onclick: () => copyText(p.email) }, 'Copy email'),
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

/* ── theme & wallpaper for one chat ─────────────────────────────────────
   Everything in here is a draft: picking a colour or a wallpaper repaints the
   real thread behind the panel and the small preview above, and writes to
   nothing. Apply is the only thing that touches the database, and Cancel puts
   the chat back exactly as it was — including an uploaded photo, which is
   only pushed to storage once it has actually been chosen. */
export function openChatStyle() {
  const c = S.chat;
  if (!c) return toast('Open a chat first.');
  startStyleDraft();
  let pending = null;                 // { blob, url } previewing, not uploaded

  const d = () => styleDraft() || {};
  const globalWall = () => S.settings?.wallpaper_url ?? null;
  const globalDim = () => 1 - (S.settings?.wallpaper_opacity ?? 1);
  const sameWall = (a, b) => (a ?? null) === (b ?? null);

  const previewWall = h('div', { class: 'wall' });
  const preview = h('div', { class: 'style-preview' }, previewWall,
    h('div', { class: 'style-thread' },
      h('div', { class: 'msg in' }, h('div', { class: 'bub' }, 'Does this one feel right?')),
      h('div', { class: 'msg out' }, h('div', { class: 'bub' }, 'Warmer. Keep it.')),
      h('div', { class: 'msg in' }, h('div', { class: 'bub' }, 'Nothing saves until you apply.'))));

  const tiles = h('div', { class: 'wall-grid' });
  const swatches = h('div', { class: 'swatches' });
  const dimOut = h('small', { class: 'hint' });
  const dimRange = h('input', {
    type: 'range', min: 0, max: 0.8, step: 0.05,
    oninput: e => { setStyleDraft({ dim: +e.target.value }); paint(); },
  });

  function tile(label, value, node) {
    const t = h('button', {
      class: 'wall-tile' + (sameWall(d().wallpaper, value) ? ' is-on' : ''), title: label, type: 'button',
      onclick: () => {
        if (pending && value !== pending.url) { URL.revokeObjectURL(pending.url); pending = null; }
        setStyleDraft({ wallpaper: value });
        paint();
      },
    }, node || h('span', { class: 'wall' }), h('small', {}, label));
    if (!node) paintWall(t.querySelector('.wall'), value ?? globalWall(), { dim: 0 });
    return t;
  }

  function paint() {
    const cur = d();
    paintWall(previewWall, cur.wallpaper ?? globalWall(), { dim: cur.dim ?? globalDim() });

    clear(tiles);
    tiles.append(tile('Account default', null));
    if (pending) tiles.append(tile('Your photo', pending.url));
    tiles.append(h('button', {
      class: 'wall-tile is-add', type: 'button', title: 'Upload a photo',
      onclick: () => filePick('image/*', async f => {
        try {
          const { blob } = await compressImage(f);
          if (pending) URL.revokeObjectURL(pending.url);
          pending = { blob, url: URL.createObjectURL(blob) };
          setStyleDraft({ wallpaper: pending.url });
          paint();
          toast('Preview only — press Apply to keep it.');
        } catch (e) { oops(e); }
      }),
    }, h('span', { class: 'wall wall-add' }, iconEl('image', 20)), h('small', {}, 'Photo')));
    WALLPAPERS.forEach(w => tiles.append(tile(w.label, 'preset:' + w.id)));

    clear(swatches);
    swatches.append(h('button', {
      class: 'swatch swatch-off' + (d().accent ? '' : ' is-on'), title: 'Account accent', type: 'button',
      onclick: () => { setStyleDraft({ accent: null }); paint(); },
    }));
    Object.entries(ACCENTS).forEach(([, a]) => {
      const val = toCustom(a);
      swatches.append(h('button', {
        class: 'swatch' + (d().accent === val ? ' is-on' : ''), title: a.label, type: 'button',
        style: { background: `oklch(${a.l} ${a.c} ${a.h})` },
        onclick: () => { setStyleDraft({ accent: val }); paint(); },
      }));
    });

    const dim = d().dim ?? globalDim();
    dimRange.value = String(dim);
    dimOut.textContent = dim > 0 ? `${Math.round(dim * 100)}% dimmed` : 'no dimming';
  }

  const done = () => { if (pending) URL.revokeObjectURL(pending.url); pending = null; };

  const cancel = () => { done(); cancelStyleDraft(); openChatInfo(); };

  const apply = async () => {
    const cur = d();
    try {
      let value = cur.wallpaper ?? null;
      if (pending && value === pending.url) {
        const path = `${S.me.id}/${crypto.randomUUID()}.webp`;
        await upload('wallpapers', path, pending.blob, 'image/webp');
        value = path;
      }
      await saveChatStyle({
        accent: cur.accent ?? null,
        wallpaper_url: value,
        wallpaper_dim: cur.dim ?? null,
      });
      done();
      toast('Applied to this chat.');
      openChatInfo();
    } catch (e) { oops(e); }
  };

  paint();
  openSide(h('div', { class: 'style-panel' },
    sideHead('Theme & wallpaper', cancel, 'Cancel'),
    h('p', { class: 'hint' }, `Only for ${c.name || 'this chat'}, and only on your side of it.`),
    preview,
    h('section', {}, h('h3', {}, 'Chat colour'), swatches,
      h('p', { class: 'hint' }, 'Overrides your account accent while this chat is open.')),
    h('section', {}, h('h3', {}, 'Wallpaper'), tiles),
    h('section', {}, seg('Dim', h('div', { class: 'range-cell' }, dimRange, dimOut),
      'Pulls the wallpaper back so text stays easy to read.')),
    h('div', { class: 'panel-actions' },
      h('button', { class: 'btn ghost', onclick: () => { setStyleDraft({ accent: null, wallpaper: null, dim: null }); paint(); } }, 'Reset'),
      h('button', { class: 'btn', onclick: cancel }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: apply }, 'Apply'))));
}

/* ── the conversation overflow menu (the ⋮ in the header) ────────────── */
export function convMenu(e) {
  const c = S.chat;
  if (!c) return;
  popMenu([
    { label: c.type === 'dm' ? 'Contact info' : 'Group info', icon: 'info', onclick: openChatInfo },
    { label: 'Search in chat', icon: 'search', onclick: searchInChat },
    { label: 'Catch me up', icon: 'spark', onclick: () => openDigest() },
    { sep: true },
    { label: 'Theme & wallpaper', icon: 'palette', onclick: openChatStyle },
    { label: 'Media & files', icon: 'image', onclick: sharedMedia },
    { label: 'Export conversation', icon: 'download', onclick: exportChat },
    { sep: true },
    { label: 'Clear history', icon: 'eraser', danger: true, onclick: clearHistory },
  ], { anchor: e.currentTarget, title: c.name || 'Chat' });
}

export async function clearHistory() {
  const c = S.chat;
  if (!c) return;
  if (!await confirmBox('Clear this history?', 'Only removes it for you. The other side keeps their copy.', 'Clear')) return;
  await rpc('clear_history', { p_chat: c.chat_id });
  const { loadChats } = await import('./chats.js');
  const { loadMessages } = await import('./thread.js');
  await loadMessages();
  loadChats();
}

/* ── chat details ─────────────────────────────────────────────── */
export async function openChatInfo() {
  const c = S.chat; if (!c) return;
  const meRow = S.members.find(m => m.user_id === S.me.id);
  const iAmAdmin = ['owner', 'admin'].includes(meRow?.role);
  const p = c.type === 'dm' ? person(c.other_id) : null;
  const photo = c.icon_url || p?.photo_url || null;
  const wrap = h('div', {});

  wrap.append(sideHead(c.name || 'Details', () => openSide(null)));

  wrap.append(h('section', { class: 'info-hero' },
    h('button', {
      class: 'hero-face', title: photo ? 'View photo' : 'No photo set',
      onclick: () => photo ? openPhotoViewer(photo, c.name || '') : toast('No photo has been set for this chat.'),
    }, h('img', { src: photo || avatarData(c.name || 'Chat'), alt: '' })),
    h('b', { class: 'display' }, (p?.nickname || c.name) || 'Chat'),
    h('small', { class: 'hint' }, p ? (lastSeenText(p) || '') : `${S.members.length} members`),
    p?.about && h('p', { class: 'muted' }, p.about),
    h('div', { class: 'hero-acts' },
      c.type !== 'broadcast' && h('button', { class: 'btn', onclick: async () => (await import('./calls.js')).startCall('audio') }, iconEl('call', 17), 'Voice'),
      c.type !== 'broadcast' && h('button', { class: 'btn', onclick: async () => (await import('./calls.js')).startCall('video') }, iconEl('video', 17), 'Video'),
      h('button', { class: 'btn', onclick: openChatStyle }, iconEl('palette', 17), 'Theme'),
      h('button', { class: 'btn', onclick: sharedMedia }, iconEl('image', 17), 'Media'))));

  if (p) wrap.append(h('section', {},
    h('h3', {}, 'This contact'),
    seg('Nickname', h('button', {
      class: 'btn small', onclick: async () => {
        const v = await promptBox('Nickname', { value: p.nickname || '', note: 'Only you see it.' });
        if (v === null) return;
        await sb.from('contacts').upsert({ user_id: S.me.id, contact_id: p.id, nickname: v || null });
        S.people.delete(p.id);
        const [fresh] = await rpc('people_info', { p_ids: [p.id] });
        S.people.set(p.id, fresh);
        toast('Saved'); openChatInfo();
      },
    }, p.nickname || 'Set')),
    seg('Favourite', sw(p.favorite, async v => {
      await sb.from('contacts').upsert({ user_id: S.me.id, contact_id: p.id, favorite: v });
      const [fresh] = await rpc('people_info', { p_ids: [p.id] }); S.people.set(p.id, fresh);
    })),
    seg('Block', h('button', {
      class: 'btn small danger', onclick: async () => {
        if (p.blocked) { await del('blocks', { blocker_id: S.me.id, blocked_id: p.id }); toast('Unblocked'); }
        else if (await confirmBox(`Block ${p.display_name}?`, 'Blocks are enforced in the database: neither side can insert messages into your shared chat.', 'Block')) {
          await rpc('block_user', { p_user: p.id }); toast('Blocked');
        }
        const [fresh] = await rpc('people_info', { p_ids: [p.id] }); S.people.set(p.id, fresh); openChatInfo();
      },
    }, p.blocked ? 'Unblock' : 'Block')),
    seg('Report', h('button', {
      class: 'btn small ghost', onclick: async () => {
        const why = await promptBox('Report user', { label: 'Reason' });
        if (why) { await ins('reports', { reporter_id: S.me.id, user_id: p.id, reason: why }); toast('Reported'); }
      },
    }, 'Report'))));

  if (c.type !== 'dm') {
    const list = h('div', { class: 'stack' }, S.members.map(m => {
      const pp = person(m.user_id);
      return h('div', { class: 'member' },
        h('button', {
          class: 'member-face', title: 'View profile',
          onclick: () => openProfileCard(m.user_id),
        }, h('img', { src: pp?.photo_url || avatarData(pp?.display_name || '?'), alt: '' })),
        m.user_id === S.me.id ? 'You' : (pp?.display_name || 'Unknown'),
        h('span', { class: 'role' }, m.role),
        iAmAdmin && m.user_id !== S.me.id && h('button', {
          class: 'icon-btn small-btn', title: 'Member options',
          onclick: e => popMenu([
            { label: m.role === 'admin' ? 'Demote to member' : 'Make admin', icon: 'shield', onclick: async () => { await rpc('set_member_role', { p_chat: c.chat_id, p_user: m.user_id, p_role: m.role === 'admin' ? 'member' : 'admin' }); S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } }); openChatInfo(); } },
            { label: 'View profile', icon: 'person', onclick: () => openProfileCard(m.user_id) },
            { label: 'Message directly', icon: 'chat', onclick: async () => (await import('./chats.js')).startDm(m.user_id) },
            { sep: true },
            { label: 'Remove from group', icon: 'trash', danger: true, onclick: async () => { await rpc('remove_member', { p_chat: c.chat_id, p_user: m.user_id }); S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } }); openChatInfo(); } },
          ], { anchor: e.currentTarget, title: pp?.display_name || 'Member' }),
        }, iconEl('dots', 18)));
    }));
    const { data: chatRow } = await sb.from('chats').select('*').eq('id', c.chat_id).single();
    wrap.append(h('section', {},
      h('div', { class: 'side-head' }, h('h3', {}, `${S.members.length} members`),
        iAmAdmin && h('button', {
          class: 'btn small', onclick: async () => {
            const q = await promptBox('Add member', { label: 'Search name or email' });
            if (!q) return;
            const rows = await rpc('search_people', { p_query: q });
            modal(h('h3', { class: 'display' }, 'Add to group'), h('div', { class: 'stack' },
              rows.map(r => h('button', {
                class: 'btn', onclick: async () => {
                  closeModal();
                  try {
                    await ins('chat_members', { chat_id: c.chat_id, user_id: r.id });
                    await ins('messages', { chat_id: c.chat_id, sender_id: S.me.id, kind: 'system', body: `${r.display_name} was added` });
                    S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
                    openChatInfo();
                  } catch (e) { oops(e); }
                },
              }, r.display_name))));
          },
        }, 'Add')),
      list,
      chatRow.description && h('p', { class: 'muted' }, chatRow.description),
      iAmAdmin && h('button', {
        class: 'btn small', onclick: async () => {
          const name = await promptBox('Group name', { value: chatRow.name || '' });
          if (name) { await upd('chats', { name }, { id: c.chat_id }); toast('Renamed'); (await import('./chats.js')).loadChats(); }
        },
      }, 'Edit group info'),
      seg('Invite link', h('button', {
        class: 'btn small', onclick: () => {
          const link = `${location.origin}/#join/${encodeURIComponent(chatRow.invite_code)}`;
          modal(h('h3', { class: 'display' }, 'Invite link'), h('code', {}, link),
            h('div', { class: 'modal-actions' },
              h('button', { class: 'btn', onclick: () => copyText(link) }, 'Copy'),
              iAmAdmin && h('button', { class: 'btn danger', onclick: async () => { await rpc('reset_invite', { p_chat: c.chat_id }); closeModal(); toast('Old link revoked'); } }, 'Reset link'),
              h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
        },
      }, 'Show')),
      iAmAdmin && seg('Who can edit info', h('select', {
        onchange: e => upd('chats', { perm_edit_info: e.target.value }, { id: c.chat_id }),
      }, h('option', { value: 'everyone', selected: chatRow.perm_edit_info === 'everyone' }, 'Everyone'),
        h('option', { value: 'admins', selected: chatRow.perm_edit_info === 'admins' }, 'Admins'))),
      iAmAdmin && seg('Who can message', h('select', {
        onchange: e => upd('chats', { perm_send: e.target.value }, { id: c.chat_id }),
      }, h('option', { value: 'everyone', selected: chatRow.perm_send === 'everyone' }, 'Everyone'),
        h('option', { value: 'admins', selected: chatRow.perm_send === 'admins' }, 'Admins only'))),
      iAmAdmin && seg('Who can add members', h('select', {
        onchange: e => upd('chats', { perm_add_members: e.target.value }, { id: c.chat_id }),
      }, h('option', { value: 'everyone', selected: chatRow.perm_add_members === 'everyone' }, 'Everyone'),
        h('option', { value: 'admins', selected: chatRow.perm_add_members === 'admins' }, 'Admins')))));
  }

  wrap.append(h('section', {},
    h('h3', {}, 'This chat'),
    seg('Disappearing', h('select', {
      onchange: async e => { await rpc('set_disappearing', { p_chat: c.chat_id, p_seconds: +e.target.value }); (await import('./chats.js')).loadChats(); },
    }, [[0, 'Off'], [3600, '1 hour'], [86400, '24 hours'], [604800, '7 days'], [7776000, '90 days']]
      .map(([v, l]) => h('option', { value: v, selected: c.disappear_seconds === v }, l))),
      'Enforced by RLS plus a purge job, not just hidden in the UI.'),
    seg('Encryption', sw(c.e2ee, async v => {
      if (v && !S.keys && !await (await import('./auth.js')).unlockKeysInteractive()) return;
      if (v) await (await import('./crypto.js')).chatKey(c.chat_id, S.members.map(m => m.user_id));
      await rpc('set_chat_e2ee', { p_chat: c.chat_id, p_on: v });
      (await import('./chats.js')).loadChats();
      toast(v ? 'New messages will be encrypted.' : 'Encryption off.');
    }), 'Applies to text from here on. Old messages keep their old state.'),
    seg('Notifications', h('select', {
      onchange: e => upd('chat_members', { notify_level: e.target.value }, { chat_id: c.chat_id, user_id: S.me.id }),
    }, [['all', 'All messages'], ['mentions', 'Mentions only'], ['none', 'Nothing']]
      .map(([v, l]) => h('option', { value: v, selected: (meRow?.notify_level) === v }, l)))),
    S.folders.length ? seg('Tab', h('select', {
      onchange: async e => { await upd('chat_members', { folder_id: e.target.value || null }, { chat_id: c.chat_id, user_id: S.me.id }); (await import('./chats.js')).loadChats(); },
    }, h('option', { value: '' }, 'None'),
      ...S.folders.map(f => h('option', { value: f.id, selected: f.id === c.folder_id }, f.name))) ) : null,
    seg('Chat lock', h('button', {
      class: 'btn small', onclick: async () => {
        if (c.locked) { await rpc('set_chat_lock', { p_chat: c.chat_id, p_pin: null }); }
        else {
          const pin = await promptBox('Chat lock', { label: 'PIN', type: 'password', note: 'Asked once per session before this chat opens.' });
          if (!pin) return;
          await rpc('set_chat_lock', { p_chat: c.chat_id, p_pin: pin });
        }
        (await import('./chats.js')).loadChats();
        openChatInfo();
      },
    }, c.locked ? 'On' : 'Off'), 'A PIN in front of this one chat, checked in Postgres.')));

  wrap.append(h('section', {},
    h('h3', {}, 'Housekeeping'),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn small', onclick: exportChat }, 'Export conversation'),
      h('button', { class: 'btn small', onclick: openDigest }, 'Catch me up'),
      h('button', { class: 'btn small danger', onclick: clearHistory }, 'Clear history'))));

  openSide(wrap);
}

export async function sharedMedia() {
  const rows = await rpc('shared_media', { p_chat: S.chat.chat_id });
  const grid = h('div', { class: 'gallery' });
  const docs = h('div', { class: 'stack' });
  rows.forEach(async m => {
    if (m.kind === 'image' || m.kind === 'video') {
      const u = await thumbUrl(m.attachment);
      grid.append(h('img', { src: u, loading: 'lazy', onclick: () => jumpTo(m.id) }));
    } else {
      docs.append(h('button', { class: 'result', onclick: () => jumpTo(m.id) },
        h('b', {}, m.attachment?.name || m.kind), h('small', {}, `${bytes(m.attachment?.size || 0)} · ${shortWhen(m.created_at)}`)));
    }
  });
  openSide(h('div', {},
    sideHead('Shared media', openChatInfo, 'Back'),
    h('section', {}, grid), h('section', {}, docs),
    !rows.length && h('p', { class: 'hint' }, 'Nothing shared yet.')));
}

export async function exportChat() {
  try {
    const text = await rpc('export_chat_text', { p_chat: S.chat.chat_id });
    const header = `Wisp export — ${S.chat.name}\n${new Date().toLocaleString()}\n${'-'.repeat(40)}\n\n`;
    const blob = new Blob([header + (text || '(empty)')], { type: 'text/plain' });
    modal(h('h3', { class: 'display' }, 'Export conversation'),
      h('p', { class: 'hint' }, 'Text file downloads directly. For PDF, print the preview and choose “Save as PDF”.'),
      h('div', { class: 'modal-actions' },
        h('a', { class: 'btn', href: URL.createObjectURL(blob), download: `${(S.chat.name || 'chat').replace(/\W+/g, '-')}.txt` }, 'Download .txt'),
        h('button', {
          class: 'btn primary', onclick: () => {
            const w = window.open('', '_blank');
            w.document.write(`<pre style="font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:32px">${header}${(text || '').replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</pre>`);
            w.document.title = S.chat.name || 'chat'; w.print();
          },
        }, 'Print / PDF'),
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
  } catch (e) { oops(e); }
}

/* ── catch me up ───────────────────────────────────────────────── */
export async function openDigest(hours = 12) {
  try {
    const d = await rpc('chat_digest', { p_chat: S.chat.chat_id, p_hours: hours });
    const max = Math.max(1, ...(d.by_hour || []).map(x => x.count));
    modal(
      h('h3', { class: 'display' }, 'Catch me up'),
      h('div', { class: 'seg' }, [6, 12, 24, 72].map(hh => h('button', {
        class: hh === hours ? 'is-on' : '', onclick: () => { closeModal(); openDigest(hh); },
      }, hh + 'h'))),
      h('div', { class: 'digest' },
        h('div', { class: 'digest-nums' },
          h('div', {}, h('b', {}, String(d.total)), h('span', {}, 'messages')),
          h('div', {}, h('b', {}, String(d.participants)), h('span', {}, 'people talking')),
          h('div', {}, h('b', {}, String(d.mentions_you)), h('span', {}, 'mentions of you')),
          d.most_active && h('div', {}, h('b', {}, d.most_active.name.split(' ')[0]), h('span', {}, `most active (${d.most_active.count})`))),
        h('div', { class: 'spark' }, (d.by_hour || []).map(x => h('i', { style: { height: (x.count / max * 100) + '%' }, title: `${x.count} at ${clock(x.hour)}` }))),
        d.unanswered?.length ? h('div', {}, h('b', {}, 'Left hanging'),
          h('div', { class: 'qlist' }, d.unanswered.slice(0, 6).map(q => h('article', { onclick: () => { closeModal(); jumpTo(q.id); } },
            h('b', {}, q.from + ': '), q.body.slice(0, 160))))) : h('p', { class: 'hint' }, 'No unanswered questions.'),
        d.links?.length ? h('div', {}, h('b', {}, 'Links'),
          h('div', { class: 'stack' }, d.links.slice(0, 8).map(u => h('a', { href: u, target: '_blank', rel: 'noopener', class: 'hint' }, u.slice(0, 70))))) : null,
        d.files?.length ? h('div', {}, h('b', {}, 'Files'),
          h('div', { class: 'stack' }, d.files.slice(0, 8).map(f => h('small', { class: 'hint' }, `${f.name || f.kind} · ${shortWhen(f.at)}`)))) : null),
      h('p', { class: 'hint' }, 'Computed in SQL over the window, no model involved. Encrypted chats cannot be summarised server-side.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
  } catch (e) { oops(e); }
}

/* ── list-pane views ──────────────────────────────────────────────── */
export async function viewPeople() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'People';
  clear($('#folders'));
  const contacts = await sel('contacts', { eq: { user_id: S.me.id } });
  const ids = contacts.map(c => c.contact_id);
  const people = ids.length ? await rpc('people_info', { p_ids: ids }) : [];
  const favs = people.filter(p => p.favorite);
  const draw = (title, rows) => {
    if (!rows.length) return;
    body.append(h('div', { class: 'list-sep' }, title));
    rows.forEach(p => body.append(personRow(p)));
  };
  draw('Favourites', favs);
  draw('Contacts', people.filter(p => !p.favorite));
  if (!people.length) body.append(h('div', { class: 'empty' }, h('p', {}, 'No contacts yet'),
    h('p', { class: 'hint' }, 'Search above by name or email to find someone.')));
}

export function personRow(p) {
  const row = h('button', {
    class: 'row',
    onclick: async () => {
      if (row.dataset.pressed) { delete row.dataset.pressed; return; }
      (await import('./chats.js')).startDm(p.id);
    },
    oncontextmenu: e => { e.preventDefault(); personMenu(p, { x: e.clientX, y: e.clientY }); },
  }, p.photo_url ? h('img', { class: 'av', src: p.photo_url }) : h('div', { class: 'av' }, initials(p.display_name)),
    h('div', { class: 'row-main' }, h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, p.nickname || p.display_name)),
      h('div', { class: 'row-prev' }, p.about || lastSeenText(p) || '')),
    h('div', { class: 'row-side' }, p.favorite ? '★' : '', p.blocked ? '⛔' : ''));
  longPress(row, at => personMenu(p, at));
  return row;
}

function personMenu(p, at) {
  popMenu([
    { label: 'View profile', icon: 'person', onclick: () => openProfileCard(p.id) },
    { label: 'Message', icon: 'chat', onclick: async () => (await import('./chats.js')).startDm(p.id) },
    p.photo_url && { label: 'View photo', icon: 'image', onclick: () => openPhotoViewer(p.photo_url, p.display_name) },
  ], { ...at, title: p.nickname || p.display_name });
}

export async function viewCalls() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'Calls';
  clear($('#folders'));
  const rows = await (await import('./calls.js')).callHistory();
  if (!rows.length) return void body.append(h('div', { class: 'empty' }, h('p', {}, 'No calls yet'),
    h('p', { class: 'hint' }, 'Voice and video calls you make show up here.')));
  rows.forEach(r => {
    const out = r.caller_id === S.me.id;
    const label = { missed: 'Missed', declined: 'Declined', ended: out ? 'Outgoing' : 'Incoming', accepted: 'In progress', ringing: 'Ringing', failed: 'Failed' }[r.state];
    body.append(h('button', {
      class: 'row', onclick: async () => { const hit = S.chats.find(c => c.chat_id === r.chat_id); if (hit) (await import('./chats.js')).openChat(r.chat_id); },
    }, h('div', { class: 'av' }, iconEl(r.kind === 'video' ? 'video' : 'call', 19)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, r.chats?.name || (out ? 'Outgoing call' : 'Incoming call'))),
        h('div', { class: 'row-prev', style: r.state === 'missed' ? { color: 'var(--danger)' } : {} },
          `${label}${r.duration ? ' · ' + dur(r.duration) : ''}`)),
      h('div', { class: 'row-side' }, shortWhen(r.started_at))));
  });
}

/* Starred, read-later and scheduled all answer "things I set aside", so they
   are one view with three tabs instead of two entries in the tab bar. */
export async function viewSaved(tab = 'starred') {
  $('#list-title').textContent = 'Saved';
  const chips = clear($('#folders'));
  [['starred', 'Starred'], ['later', 'Read later'], ['scheduled', 'Scheduled']].forEach(([k, l]) =>
    chips.append(h('button', { class: 'chip' + (tab === k ? ' is-on' : ''), onclick: () => viewSaved(k) }, l)));
  const body = clear($('#list-body'));
  if (tab === 'scheduled') return renderScheduled(body);

  const q = tab === 'starred'
    ? sb.from('stars').select('message_id, messages(*, chats(name, type))').eq('user_id', S.me.id)
    : sb.from('bookmarks').select('message_id, note, created_at, messages(*, chats(name, type))').eq('user_id', S.me.id);
  const { data, error } = await q;
  if (error) return oops(error);
  if (!data?.length) return void body.append(h('div', { class: 'empty' },
    h('p', {}, tab === 'starred' ? 'Nothing starred' : 'Nothing saved for later'),
    h('p', { class: 'hint' }, 'Hover a message and use the star or the bookmark.')));
  data.forEach(r => {
    const m = r.messages; if (!m) return;
    body.append(h('button', {
      class: 'result', onclick: async () => {
        const { openChat } = await import('./chats.js');
        await openChat(m.chat_id);
        setTimeout(() => jumpTo(m.id), 400);
      },
    }, h('b', {}, m.chats?.name || 'Chat'),
      h('span', {}, (m.body || `[${m.kind}]`).slice(0, 140)),
      h('small', {}, [nameOf(m.sender_id), shortWhen(m.created_at), r.note].filter(Boolean).join(' · '))));
  });
}

async function renderScheduled(body) {
  const rows = await sb.from('scheduled_messages').select('*, chats(name)').eq('sender_id', S.me.id).order('send_at');
  const pend = (rows.data || []).filter(r => r.status === 'pending');
  if (!pend.length) body.append(h('div', { class: 'empty' }, h('p', {}, 'Nothing queued'),
    h('p', { class: 'hint' }, 'Attach menu → Schedule this message.')));
  pend.forEach(r => body.append(h('div', { class: 'result' },
    h('b', {}, r.chats?.name || 'Chat'),
    h('span', {}, (r.body || '').slice(0, 140)),
    h('small', {}, `${new Date(r.send_at).toLocaleString()}${r.recurrence ? ' · repeats ' + r.recurrence : ''}`),
    h('div', { class: 'row-btns' },
      h('button', {
        class: 'btn small', onclick: async () => {
          const v = await promptBox('Edit scheduled message', { value: r.body || '' });
          if (v !== null) { await upd('scheduled_messages', { body: v }, { id: r.id }); viewSaved('scheduled'); }
        },
      }, 'Edit'),
      h('button', {
        class: 'btn small', onclick: async () => {
          const when = await promptBox('Send at', { value: new Date(r.send_at).toISOString().slice(0, 16), type: 'datetime-local' });
          if (when) { await upd('scheduled_messages', { send_at: new Date(when).toISOString() }, { id: r.id }); viewSaved('scheduled'); }
        },
      }, 'Reschedule'),
      h('button', {
        class: 'btn small danger', onclick: async () => { await upd('scheduled_messages', { status: 'cancelled' }, { id: r.id }); viewSaved('scheduled'); },
      }, 'Cancel')))));
  const seen = (rows.data || []).filter(r => r.status !== 'pending');
  if (seen.length) {
    body.append(h('div', { class: 'list-sep' }, 'History'));
    seen.slice(0, 20).forEach(r => body.append(h('div', { class: 'result' },
      h('b', {}, r.chats?.name || 'Chat'), h('span', {}, (r.body || '').slice(0, 100)),
      h('small', {}, `${r.status} · ${shortWhen(r.send_at)}`))));
  }
}

export const viewScheduled = () => viewSaved('scheduled');

/* ── search across everything ───────────────────────────────────────── */
export const runSearch = debounce(async q => {
  const { renderChatList } = await import('./chats.js');
  const body = $('#list-body');
  if (!q.trim()) { $('#list-title').textContent = 'Chats'; S.view = 'chats'; return renderChatList(); }
  clear(body);
  $('#list-title').textContent = `“${q}”`;
  try {
    const [msgs, people] = await Promise.all([
      rpc('search_messages', { p_query: q, p_chat: null }),
      rpc('search_people', { p_query: q }),
    ]);
    if (people.length) {
      body.append(h('div', { class: 'list-sep' }, 'People'));
      people.forEach(p => body.append(personRow(p)));
    }
    body.append(h('div', { class: 'list-sep' }, `Messages (${msgs.length})`));
    if (!msgs.length) body.append(h('p', { class: 'hint', style: { padding: '0 16px' } }, 'No message matches. Encrypted chats are not searchable server-side.'));
    msgs.forEach(m => {
      const hl = (m.body || '').replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
      body.append(h('button', {
        class: 'result', onclick: async () => {
          const { openChat } = await import('./chats.js');
          await openChat(m.chat_id);
          setTimeout(() => jumpTo(m.message_id), 400);
        },
      }, h('b', {}, m.chat_name || 'Chat'), h('span', { html: hl }),
        h('small', {}, `${nameOf(m.sender_id)} · ${shortWhen(m.created_at)}`)));
    });
  } catch (e) { oops(e); }
}, 300);

export async function searchInChat() {
  const q = await promptBox('Search in this chat', { label: 'Text' });
  if (!q) return;
  const rows = await rpc('search_messages', { p_query: q, p_chat: S.chat.chat_id });
  modal(h('h3', { class: 'display' }, `${rows.length} hit${rows.length === 1 ? '' : 's'}`),
    h('div', { class: 'stack', style: { maxHeight: '50vh', overflowY: 'auto' } },
      rows.map(m => h('button', { class: 'result', onclick: () => { closeModal(); jumpTo(m.message_id); } },
        h('b', {}, nameOf(m.sender_id)), h('span', {}, (m.body || '').slice(0, 160)), h('small', {}, shortWhen(m.created_at))))),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}
