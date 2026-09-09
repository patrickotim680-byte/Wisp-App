import { sb, rpc, sel, ins, upd, del } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, $$, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox,
         initials, shortWhen, clock, dur, bytes, icon, iconEl, actionSheet, copyText,
         shareLink, kindIcon, KIND_WORD, debounce, lastSeenText } from './util.js';
import { applyWallpaper, applyContactAccent, saveSettings, ACCENTS, toCustom } from './theme.js';
import { thumbUrl, compressImage } from './media.js';
import { jumpTo } from './thread.js';

export function openSide(node) {
  const side = $('#side'), app = $('#app');
  if (!node) { side.hidden = true; app.classList.remove('has-side'); return; }
  clear(side).append(node);
  side.hidden = false; app.classList.add('has-side');
}

/* One shape for every side panel: sticky glass header, scrolling body. */
export function sidePanel(title, body, { onBack, actions } = {}) {
  const head = h('div', { class: 'side-top' });
  if (onBack) {
    const b = h('button', { class: 'icon-btn', title: 'Back', onclick: onBack });
    b.append(iconEl('back', 18));
    head.append(b);
  }
  head.append(h('h3', { class: 'display' }, title));
  if (actions) head.append(actions);
  const close = h('button', { class: 'icon-btn', title: 'Close', onclick: () => openSide(null) });
  close.append(iconEl('x', 18));
  head.append(close);
  return h('div', {}, head, h('div', { class: 'side-body' }, body));
}

const kv = (label, control, note) => h('div', { class: 'kv' },
  h('div', {}, h('span', { style: { color: 'var(--ink)' } }, label), note && h('div', { class: 'hint' }, note)), control);

function switchBtn(val, fn) {
  const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!val) });
  b.onclick = async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    try { await fn(next); } catch (e) { oops(e); b.setAttribute('aria-checked', String(!next)); }
  };
  return b;
}

/* ── chat details ───────────────────────────────────────────── */
export async function openChatInfo() {
  const c = S.chat; if (!c) return;
  const meRow = S.members.find(m => m.user_id === S.me.id);
  const iAmAdmin = ['owner', 'admin'].includes(meRow?.role);
  const p = c.type === 'dm' ? person(c.other_id) : null;
  const body = h('div', {});

  /* identity */
  if (p) {
    body.append(h('section', {},
      h('div', { class: 'profile-hero' },
        p.photo_url
          ? h('img', { class: 'av', src: p.photo_url, style: { width: '84px', height: '84px' } })
          : h('div', { class: 'av', style: { width: '84px', height: '84px', fontSize: '1.3em' } }, initials(p.display_name)),
        h('b', {}, p.display_name),
        h('small', { class: 'hint' }, lastSeenText(p) || ''),
        p.about && h('p', { class: 'muted' }, p.about))));
  } else {
    body.append(h('section', {},
      h('div', { class: 'profile-hero' },
        c.icon_url ? h('img', { class: 'av', src: c.icon_url, style: { width: '78px', height: '78px' } })
          : h('div', { class: 'av', style: { width: '78px', height: '78px', fontSize: '1.2em' } }, initials(c.name)),
        h('b', {}, c.name || 'Chat'),
        h('small', { class: 'hint' }, `${S.members.length} members · ${c.type}`))));
  }

  /* quick actions — the same glass bar as the conversation and the call */
  const quick = h('div', { class: 'chatbar', style: { marginBottom: '4px' } });
  const qbtn = (glyph, label, fn) => {
    const b = h('button', { class: 'cb-btn', type: 'button', title: label, onclick: fn });
    b.innerHTML = icon(glyph, 19);
    b.append(h('span', { class: 'cb-label' }, label));
    quick.append(b);
  };
  if (c.type !== 'broadcast') {
    qbtn('call', 'Voice', () => $('#btn-call-audio').click());
    qbtn('video', 'Video', () => $('#btn-call-video').click());
  }
  qbtn('search', 'Search', () => searchInChat());
  qbtn('grid', 'Media', () => sharedMedia());
  qbtn('spark', 'Catch up', () => openDigest());
  body.append(h('section', {}, quick));

  /* person-specific */
  if (p) {
    body.append(h('section', {},
      h('h3', {}, 'This person'),
      h('div', { class: 'card' },
        kv('Nickname', h('button', {
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
        kv('Favourite', switchBtn(p.favorite, async v => {
          await sb.from('contacts').upsert({ user_id: S.me.id, contact_id: p.id, favorite: v });
          const [fresh] = await rpc('people_info', { p_ids: [p.id] }); S.people.set(p.id, fresh);
        })),
        kv('Chat accent', h('div', { class: 'swatches' },
          Object.entries(ACCENTS).map(([k, a]) => h('button', {
            class: 'swatch', title: a.label, style: { background: `oklch(${a.l} ${a.c} ${a.h})` },
            onclick: async () => {
              const val = toCustom(a);
              await sb.from('contacts').upsert({ user_id: S.me.id, contact_id: p.id, accent: val });
              const [fresh] = await rpc('people_info', { p_ids: [p.id] });
              S.people.set(p.id, fresh);
              applyContactAccent(val);
            },
          }))), 'Overrides your accent while this chat is open.'))));
  }

  /* group members + permissions */
  if (c.type !== 'dm') {
    const memberRow = m => {
      const pp = person(m.user_id);
      const more = h('button', { class: 'icon-btn', title: 'Member options' });
      more.append(iconEl('dots', 16));
      more.onclick = () => actionSheet(pp?.display_name || 'Member', [
        {
          icon: 'shield', label: m.role === 'admin' ? 'Demote to member' : 'Make admin',
          onclick: async () => {
            await rpc('set_member_role', { p_chat: c.chat_id, p_user: m.user_id, p_role: m.role === 'admin' ? 'member' : 'admin' });
            S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
            openChatInfo();
          },
        },
        { icon: 'chat', label: 'Message directly', onclick: async () => (await import('./chats.js')).startDm(m.user_id) },
        {
          icon: 'log-out', label: 'Remove from group', danger: true,
          onclick: async () => {
            if (!await confirmBox(`Remove ${pp?.display_name || 'this member'}?`, 'They lose access to the history from now on.', 'Remove')) return;
            await rpc('remove_member', { p_chat: c.chat_id, p_user: m.user_id });
            S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
            openChatInfo();
          },
        },
      ]);
      return h('div', { class: 'member' },
        h('div', { class: 'av', style: { width: '32px', height: '32px', fontSize: '11px' } }, initials(pp?.display_name || '?')),
        m.user_id === S.me.id ? 'You' : (pp?.display_name || 'Unknown'),
        h('span', { class: 'role' }, m.role),
        iAmAdmin && m.user_id !== S.me.id && more);
    };

    const { data: chatRow } = await sb.from('chats').select('*').eq('id', c.chat_id).single();
    const addBtn = h('button', {
      class: 'btn small', onclick: async () => {
        const q = await promptBox('Add member', { label: 'Search name or email' });
        if (!q) return;
        const rows = await rpc('search_people', { p_query: q });
        if (!rows.length) return toast('Nobody matched.', true);
        actionSheet('Add to group', rows.map(r => ({
          icon: 'user', label: r.display_name,
          onclick: async () => {
            await ins('chat_members', { chat_id: c.chat_id, user_id: r.id });
            await ins('messages', { chat_id: c.chat_id, sender_id: S.me.id, kind: 'system', body: `${r.display_name} was added` });
            S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
            openChatInfo();
          },
        })));
      },
    }, 'Add');

    body.append(h('section', {},
      h('div', { class: 'side-head' }, h('h3', {}, `${S.members.length} members`), iAmAdmin && addBtn),
      h('div', { class: 'card' }, S.members.map(memberRow)),
      chatRow?.description && h('p', { class: 'muted' }, chatRow.description)));

    const permSelect = (field, current, options) => h('select', {
      onchange: async e => {
        try { await upd('chats', { [field]: e.target.value }, { id: c.chat_id }); toast('Saved'); }
        catch (err) { oops(err); }
      },
    }, options.map(([v, l]) => h('option', { value: v, selected: current === v }, l)));

    body.append(h('section', {},
      h('h3', {}, 'Group'),
      h('div', { class: 'card' },
        iAmAdmin && kv('Name', h('button', {
          class: 'btn small', onclick: async () => {
            const name = await promptBox('Group name', { value: chatRow?.name || '' });
            if (name) { await upd('chats', { name }, { id: c.chat_id }); toast('Renamed'); (await import('./chats.js')).loadChats(); openChatInfo(); }
          },
        }, 'Edit')),
        kv('Invite link', h('button', {
          class: 'btn small', onclick: () => {
            const link = `${location.origin}/#join/${encodeURIComponent(chatRow.invite_code)}`;
            modal(h('h3', { class: 'display' }, 'Invite link'),
              h('code', {}, link),
              h('div', { class: 'modal-actions' },
                h('button', { class: 'btn', onclick: () => copyText(link) }, 'Copy'),
                h('button', { class: 'btn', onclick: () => shareLink(link, 'Join me on Wisp') }, 'Share'),
                iAmAdmin && h('button', {
                  class: 'btn danger', onclick: async () => {
                    try { await rpc('reset_invite', { p_chat: c.chat_id }); closeModal(); toast('Old link revoked'); }
                    catch (e) { oops(e); }
                  },
                }, 'Reset link'),
                h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
          },
        }, 'Show')),
        iAmAdmin && kv('Who can edit info', permSelect('perm_edit_info', chatRow?.perm_edit_info, [['everyone', 'Everyone'], ['admins', 'Admins']])),
        iAmAdmin && kv('Who can message', permSelect('perm_send', chatRow?.perm_send, [['everyone', 'Everyone'], ['admins', 'Admins only']])),
        iAmAdmin && kv('Who can add members', permSelect('perm_add_members', chatRow?.perm_add_members, [['everyone', 'Everyone'], ['admins', 'Admins']])))));
  }

  /* this chat */
  const notifyLevel = meRow?.notify_level || 'all';
  body.append(h('section', {},
    h('h3', {}, 'This chat'),
    h('div', { class: 'card' },
      kv('Notifications', h('select', {
        onchange: async e => {
          try {
            await upd('chat_members', { notify_level: e.target.value }, { chat_id: c.chat_id, user_id: S.me.id });
            // Without this the panel kept showing the previous value on
            // reopen, and the in-app notifier kept using it too.
            S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
            toast('Saved');
          } catch (err) { oops(err); }
        },
      }, [['all', 'All messages'], ['mentions', 'Mentions only'], ['none', 'Nothing']]
        .map(([v, l]) => h('option', { value: v, selected: notifyLevel === v }, l)))),
      kv('Disappearing', h('select', {
        onchange: async e => {
          try {
            await rpc('set_disappearing', { p_chat: c.chat_id, p_seconds: +e.target.value });
            (await import('./chats.js')).loadChats();
          } catch (err) { oops(err); }
        },
      }, [[0, 'Off'], [3600, '1 hour'], [86400, '24 hours'], [604800, '7 days'], [7776000, '90 days']]
        .map(([v, l]) => h('option', { value: v, selected: c.disappear_seconds === v }, l))),
        'Enforced by RLS plus a purge job, not just hidden in the UI.'),
      kv('Encryption', switchBtn(c.e2ee, async v => {
        if (v && !S.keys && !await (await import('./auth.js')).unlockKeysInteractive()) return;
        if (v) await (await import('./crypto.js')).chatKey(c.chat_id, S.members.map(m => m.user_id));
        await rpc('set_chat_e2ee', { p_chat: c.chat_id, p_on: v });
        (await import('./chats.js')).loadChats();
        toast(v ? 'New messages will be encrypted.' : 'Encryption off.');
      }), 'Applies to text from here on. Old messages keep their old state.'),
      kv('Wallpaper', h('button', {
        class: 'btn small', onclick: async () => (await import('./chatbar.js')).openDisplay(),
      }, 'Change')))));

  /* export + danger */
  body.append(h('section', {},
    h('h3', {}, 'Data'),
    h('div', { class: 'set-group' },
      sideAction('down', 'Export conversation', 'Text file, or print to PDF', exportChat),
      sideAction('grid', 'Shared media', 'Every photo, video and file here', sharedMedia))));

  if (p) {
    body.append(h('section', {},
      h('h3', {}, 'Safety'),
      h('div', { class: 'set-group' },
        sideAction(p.blocked ? 'unlock' : 'ban', p.blocked ? 'Unblock' : `Block ${p.display_name.split(' ')[0]}`,
          'Enforced in the database: neither side can post to your shared chat', async () => {
            if (p.blocked) { await del('blocks', { blocker_id: S.me.id, blocked_id: p.id }); toast('Unblocked'); }
            else if (await confirmBox(`Block ${p.display_name}?`, 'Neither side can insert messages into your shared chat.', 'Block')) {
              await rpc('block_user', { p_user: p.id }); toast('Blocked');
            }
            const [fresh] = await rpc('people_info', { p_ids: [p.id] }); S.people.set(p.id, fresh); openChatInfo();
          }, true),
        sideAction('flag', 'Report', 'Sends the reason to the moderators', async () => {
          const why = await promptBox('Report user', { label: 'Reason' });
          if (why) { await ins('reports', { reporter_id: S.me.id, user_id: p.id, reason: why }); toast('Reported'); }
        }, true))));
  }

  openSide(sidePanel(c.name || 'Details', body));
}

/* A tappable row with a glyph, a label and a sub-label. */
export function sideAction(glyph, label, note, fn, danger = false) {
  return h('button', {
    class: 'set-row' + (danger ? ' danger' : ''),
    onclick: async () => { try { await fn(); } catch (e) { oops(e); } },
  },
    h('span', { class: 'sheet-ico', html: icon(glyph, 19) }),
    h('span', { class: 'sheet-label' }, h('b', {}, label), note && h('small', {}, note)),
    h('span', { class: 'chev', html: icon('chevron-right', 16) }));
}

export async function sharedMedia() {
  const rows = await rpc('shared_media', { p_chat: S.chat.chat_id });
  const grid = h('div', { class: 'gallery' });
  const docs = h('div', { class: 'set-group' });
  // Sequential on purpose: forEach(async ...) resolved the signed URLs in
  // whatever order the network felt like, so tiles appeared shuffled.
  for (const m of rows) {
    if (m.kind === 'image' || m.kind === 'video') {
      const u = await thumbUrl(m.attachment);
      if (u) grid.append(h('img', { src: u, loading: 'lazy', onclick: () => jumpTo(m.id) }));
    } else {
      docs.append(sideAction(kindIcon(m.kind), m.attachment?.name || KIND_WORD[m.kind] || m.kind,
        `${bytes(m.attachment?.size || 0)} · ${shortWhen(m.created_at)}`, () => jumpTo(m.id)));
    }
  }
  const body = h('div', {},
    rows.length ? null : h('div', { class: 'empty' },
      h('div', { class: 'empty-ico', html: icon('grid', 24) }),
      h('b', {}, 'Nothing shared yet'),
      h('p', { class: 'hint' }, 'Photos, videos and files sent here show up in this grid.')),
    grid.children.length ? h('section', {}, grid) : null,
    docs.children.length ? h('section', {}, h('h3', {}, 'Files'), docs) : null);
  openSide(sidePanel('Shared media', body, { onBack: openChatInfo }));
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
            if (!w) return toast('The browser blocked the print window.', true);
            w.document.write(`<pre style="font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:32px">${header}${(text || '').replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</pre>`);
            w.document.title = S.chat.name || 'chat'; w.print();
          },
        }, 'Print / PDF'),
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
  } catch (e) { oops(e); }
}

/* ── catch me up ───────────────────────────────────────────── */
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

/* ── list-pane views ────────────────────────────────────────── */
const sectionLabel = text => h('div', { class: 'day-sep', style: { justifySelf: 'start', margin: '10px 16px' } }, text);
const emptyState = (glyph, title, note) => h('div', { class: 'empty' },
  h('div', { class: 'empty-ico', html: icon(glyph, 24) }),
  h('b', {}, title), h('p', { class: 'hint' }, note));

export async function viewPeople() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'People';
  clear($('#folders'));
  const contacts = await sel('contacts', { eq: { user_id: S.me.id } });
  const ids = contacts.map(c => c.contact_id);
  const people = ids.length ? await rpc('people_info', { p_ids: ids }) : [];
  const draw = (title, rows) => {
    if (!rows.length) return;
    body.append(sectionLabel(title));
    rows.forEach(p => body.append(personRow(p)));
  };
  draw('Favourites', people.filter(p => p.favorite));
  draw('Contacts', people.filter(p => !p.favorite));
  if (!people.length) body.append(emptyState('people', 'No contacts yet', 'Search above by name or email to find someone.'));
}

export function personRow(p) {
  const flags = h('div', { class: 'dot-row' },
    p.favorite && h('span', { class: 'row-flag accent', title: 'Favourite' }, iconEl('star', 14)),
    p.blocked && h('span', { class: 'row-flag', title: 'Blocked' }, iconEl('ban', 14)));
  return h('button', {
    class: 'row', onclick: async () => (await import('./chats.js')).startDm(p.id),
  },
    h('div', { class: 'avatar-wrap' },
      p.photo_url ? h('img', { class: 'av', src: p.photo_url }) : h('div', { class: 'av' }, initials(p.display_name)),
      p.is_online && h('span', { class: 'presence', title: 'online' })),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, p.nickname || p.display_name)),
      h('div', { class: 'row-prev' }, p.about || lastSeenText(p) || '')),
    h('div', { class: 'row-side' }, flags));
}

export async function viewCalls() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'Calls';
  clear($('#folders'));
  const rows = await (await import('./calls.js')).callHistory();
  if (!rows.length) return void body.append(emptyState('call', 'No calls yet', 'Voice and video calls you make or receive land here.'));
  const label = {
    missed: 'Missed', declined: 'Declined', accepted: 'In progress',
    ringing: 'Ringing', failed: 'Failed', ended: null,
  };
  rows.forEach(r => {
    const out = r.caller_id === S.me.id;
    const glyph = r.state === 'missed' ? 'phone-missed' : out ? 'phone-out' : 'phone-in';
    const text = label[r.state] ?? (out ? 'Outgoing' : 'Incoming');
    const known = S.chats.some(c => c.chat_id === r.chat_id);
    const back = h('button', {
      class: 'icon-btn', title: r.kind === 'video' ? 'Video call back' : 'Call back',
      onclick: async e => {
        e.stopPropagation();
        if (!known) return toast('That conversation is gone, so there is nobody to call back.', true);
        const { openChat } = await import('./chats.js');
        await openChat(r.chat_id);
        $(r.kind === 'video' ? '#btn-call-video' : '#btn-call-audio').click();
      },
    });
    back.append(iconEl(r.kind === 'video' ? 'video' : 'call', 17));
    body.append(h('button', {
      class: 'row',
      onclick: async () => {
        if (!known) return toast('That conversation is no longer in your list.', true);
        (await import('./chats.js')).openChat(r.chat_id);
      },
    },
      h('div', { class: 'av' }, iconEl(glyph, 19)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, r.chats?.name || (out ? 'Outgoing call' : 'Incoming call'))),
        h('div', { class: 'row-prev', style: r.state === 'missed' ? { color: 'var(--danger)' } : {} },
          iconEl(r.kind === 'video' ? 'video' : 'call', 13),
          `${text}${r.duration ? ' · ' + dur(r.duration) : ''}`)),
      h('div', { class: 'row-side' }, h('span', {}, shortWhen(r.started_at)), back)));
  });
}

export async function viewSaved() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'Saved';
  clear($('#folders'));
  const [stars, marks] = await Promise.all([
    sb.from('stars').select('message_id, messages(*, chats(name, type))').eq('user_id', S.me.id),
    sb.from('bookmarks').select('message_id, note, created_at, messages(*, chats(name, type))').eq('user_id', S.me.id),
  ]);
  const section = (title, rows, noteKey) => {
    body.append(sectionLabel(title));
    if (!rows?.length) return body.append(h('p', { class: 'hint', style: { padding: '0 16px 10px' } }, 'Nothing here yet.'));
    rows.forEach(r => {
      const m = r.messages; if (!m) return;
      body.append(h('button', {
        class: 'result', onclick: async () => {
          const { openChat } = await import('./chats.js');
          await openChat(m.chat_id);
          setTimeout(() => jumpTo(m.id), 400);
        },
      }, h('b', {}, m.chats?.name || 'Chat'),
        h('span', {}, (m.body || KIND_WORD[m.kind] || m.kind).slice(0, 140)),
        h('small', {}, [nameOf(m.sender_id), shortWhen(m.created_at), noteKey && r[noteKey]].filter(Boolean).join(' · '))));
    });
  };
  section('Starred', stars.data, null);
  section('Read later', marks.data, 'note');
}

export async function viewScheduled() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'Scheduled';
  clear($('#folders'));
  const rows = await sb.from('scheduled_messages').select('*, chats(name)').eq('sender_id', S.me.id).order('send_at');
  const pend = (rows.data || []).filter(r => r.status === 'pending');
  if (!pend.length) body.append(emptyState('clock', 'Nothing queued', 'Use the clock in the composer to schedule a message.'));
  pend.forEach(r => body.append(h('div', { class: 'result' },
    h('b', {}, r.chats?.name || 'Chat'),
    h('span', {}, (r.body || '').slice(0, 140)),
    h('small', {}, `${new Date(r.send_at).toLocaleString()}${r.recurrence ? ' · repeats ' + r.recurrence : ''}`),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
      h('button', {
        class: 'btn small', onclick: async () => {
          const v = await promptBox('Edit scheduled message', { value: r.body || '' });
          if (v !== null) { await upd('scheduled_messages', { body: v }, { id: r.id }); viewScheduled(); }
        },
      }, 'Edit'),
      h('button', {
        class: 'btn small', onclick: async () => {
          const when = await promptBox('Send at', { value: new Date(r.send_at).toISOString().slice(0, 16), type: 'datetime-local' });
          if (when) { await upd('scheduled_messages', { send_at: new Date(when).toISOString() }, { id: r.id }); viewScheduled(); }
        },
      }, 'Reschedule'),
      h('button', {
        class: 'btn small danger', onclick: async () => { await upd('scheduled_messages', { status: 'cancelled' }, { id: r.id }); viewScheduled(); },
      }, 'Cancel')))));
  const seen = (rows.data || []).filter(r => r.status !== 'pending');
  if (seen.length) {
    body.append(sectionLabel('History'));
    seen.slice(0, 20).forEach(r => body.append(h('div', { class: 'result' },
      h('b', {}, r.chats?.name || 'Chat'), h('span', {}, (r.body || '').slice(0, 100)),
      h('small', {}, `${r.status} · ${shortWhen(r.send_at)}`))));
  }
}

/* ── search across everything ───────────────────────────────────── */
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
      body.append(sectionLabel('People'));
      people.forEach(p => body.append(personRow(p)));
    }
    body.append(sectionLabel(`Messages (${msgs.length})`));
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
  try {
    const rows = await rpc('search_messages', { p_query: q, p_chat: S.chat.chat_id });
    modal(h('h3', { class: 'display' }, `${rows.length} hit${rows.length === 1 ? '' : 's'}`),
      rows.length
        ? h('div', { class: 'sheet-list' },
          rows.map(m => h('button', { class: 'result', onclick: () => { closeModal(); jumpTo(m.message_id); } },
            h('b', {}, nameOf(m.sender_id)), h('span', {}, (m.body || '').slice(0, 160)), h('small', {}, shortWhen(m.created_at)))))
        : h('p', { class: 'hint' }, 'Nothing in this chat matched. Encrypted messages are not searchable server-side.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
  } catch (e) { oops(e); }
}
