import { sb, rpc, sel, ins, upd, del } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, $$, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox,
         initials, shortWhen, clock, dur, bytes, iconEl, debounce, lastSeenText } from './util.js';
import { applyWallpaper, applyContactAccent, saveSettings, ACCENTS, toCustom } from './theme.js';
import { thumbUrl, compressImage } from './media.js';
import { jumpTo } from './thread.js';

export function openSide(node) {
  const side = $('#side'), app = $('#app');
  if (!node) { side.hidden = true; app.classList.remove('has-side'); return; }
  clear(side).append(node);
  side.hidden = false; app.classList.add('has-side');
}

/* ── chat details ──────────────────────────────────────────────────────── */
export async function openChatInfo() {
  const c = S.chat; if (!c) return;
  const meRow = S.members.find(m => m.user_id === S.me.id);
  const iAmAdmin = ['owner', 'admin'].includes(meRow?.role);
  const p = c.type === 'dm' ? person(c.other_id) : null;
  const wrap = h('div', {});
  const seg = (label, control, note) => h('div', { class: 'kv' },
    h('div', {}, h('span', { style: { color: 'var(--ink)' } }, label), note && h('div', { class: 'hint' }, note)), control);
  const sw = (val, fn) => {
    const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!val) });
    b.onclick = async () => { const n = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(n)); try { await fn(n); } catch (e) { oops(e); } };
    return b;
  };

  wrap.append(h('div', { class: 'side-head' },
    h('h3', { class: 'display' }, c.name || 'Details'),
    h('button', { class: 'btn small ghost', onclick: () => openSide(null) }, 'Close')));

  if (p) wrap.append(h('section', {},
    h('div', { style: { display: 'grid', justifyItems: 'center', gap: '6px' } },
      p.photo_url ? h('img', { class: 'av', src: p.photo_url, style: { width: '84px', height: '84px' } })
        : h('div', { class: 'av', style: { width: '84px', height: '84px', fontSize: '1.3em' } }, initials(p.display_name)),
      h('b', {}, p.display_name), h('small', { class: 'hint' }, lastSeenText(p) || ''),
      p.about && h('p', { class: 'muted', style: { textAlign: 'center' } }, p.about)),
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
    seg('Chat accent', h('div', { class: 'swatches' },
      Object.entries(ACCENTS).map(([k, a]) => h('button', {
        class: 'swatch', style: { background: `oklch(${a.l} ${a.c} ${a.h})` },
        onclick: async () => {
          const val = toCustom(a);
          await sb.from('contacts').upsert({ user_id: S.me.id, contact_id: p.id, accent: val });
          const [fresh] = await rpc('people_info', { p_ids: [p.id] });
          S.people.set(p.id, fresh);
          applyContactAccent(val);
        },
      }))), 'Overrides your accent while this chat is open.'),
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
        h('div', { class: 'av', style: { width: '30px', height: '30px', fontSize: '11px' } }, initials(pp?.display_name || '?')),
        m.user_id === S.me.id ? 'You' : (pp?.display_name || 'Unknown'),
        h('span', { class: 'role' }, m.role),
        iAmAdmin && m.user_id !== S.me.id && h('button', {
          class: 'btn small ghost', onclick: () => modal(h('h3', { class: 'display' }, pp?.display_name || 'Member'),
            h('div', { class: 'stack' },
              h('button', { class: 'btn', onclick: async () => { closeModal(); await rpc('set_member_role', { p_chat: c.chat_id, p_user: m.user_id, p_role: m.role === 'admin' ? 'member' : 'admin' }); S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } }); openChatInfo(); } }, m.role === 'admin' ? 'Demote to member' : 'Make admin'),
              h('button', { class: 'btn', onclick: async () => { closeModal(); (await import('./chats.js')).startDm(m.user_id); } }, 'Message directly'),
              h('button', { class: 'btn danger', onclick: async () => { closeModal(); await rpc('remove_member', { p_chat: c.chat_id, p_user: m.user_id }); S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } }); openChatInfo(); } }, 'Remove from group'))),
        }, '⋯'));
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
              h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Copied')) }, 'Copy'),
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
      .map(([v, l]) => h('option', { value: v, selected: (S.members.find(m => m.user_id === S.me.id)?.notify_level) === v }, l)))),
    seg('Chat wallpaper', h('button', {
      class: 'btn small', onclick: () => {
        const i = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async e => {
          const f = e.target.files[0]; if (!f) return;
          try {
            const { blob } = await compressImage(f);
            const path = `${S.me.id}/${crypto.randomUUID()}.webp`;
            await (await import('./db.js')).upload('wallpapers', path, blob, 'image/webp');
            await upd('chat_members', { wallpaper_url: path }, { chat_id: c.chat_id, user_id: S.me.id });
            S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
            applyWallpaper(); toast('Chat wallpaper set');
          } catch (err) { oops(err); }
        } });
        document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
      },
    }, 'Upload'), 'Falls back to your global wallpaper when unset.'),
    h('button', { class: 'btn small', onclick: exportChat }, 'Export conversation'),
    h('button', { class: 'btn small', onclick: openDigest }, 'Catch me up'),
    h('button', { class: 'btn small', onclick: sharedMedia }, 'Shared media')));

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
    h('div', { class: 'side-head' }, h('h3', { class: 'display' }, 'Shared media'),
      h('button', { class: 'btn small ghost', onclick: openChatInfo }, 'Back')),
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

/* ── catch me up ───────────────────────────────────────────────────────── */
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

/* ── list-pane views ───────────────────────────────────────────────────── */
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
    body.append(h('div', { class: 'day-sep', style: { justifySelf: 'start', margin: '10px 16px' } }, title));
    rows.forEach(p => body.append(personRow(p)));
  };
  draw('Favourites', favs);
  draw('Contacts', people.filter(p => !p.favorite));
  if (!people.length) body.append(h('div', { class: 'empty' }, h('p', {}, 'No contacts yet'),
    h('p', { class: 'hint' }, 'Search above by name or email to find someone.')));
}
export function personRow(p) {
  return h('button', {
    class: 'row', onclick: async () => (await import('./chats.js')).startDm(p.id),
  }, p.photo_url ? h('img', { class: 'av', src: p.photo_url }) : h('div', { class: 'av' }, initials(p.display_name)),
    h('div', { class: 'row-main' }, h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, p.display_name)),
      h('div', { class: 'row-prev' }, p.about || lastSeenText(p) || '')),
    h('div', { class: 'row-side' }, p.favorite ? '★' : '', p.blocked ? '⛔' : ''));
}

export async function viewCalls() {
  const body = clear($('#list-body'));
  $('#list-title').textContent = 'Calls';
  clear($('#folders'));
  const rows = await (await import('./calls.js')).callHistory();
  if (!rows.length) return void body.append(h('div', { class: 'empty' }, h('p', {}, 'No calls yet')));
  rows.forEach(r => {
    const out = r.caller_id === S.me.id;
    const label = { missed: 'Missed', declined: 'Declined', ended: out ? 'Outgoing' : 'Incoming', accepted: 'In progress', ringing: 'Ringing', failed: 'Failed' }[r.state];
    body.append(h('button', {
      class: 'row', onclick: async () => { const chats = S.chats.find(c => c.chat_id === r.chat_id); if (chats) (await import('./chats.js')).openChat(r.chat_id); },
    }, h('div', { class: 'av' }, r.kind === 'video' ? '🎥' : '📞'),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, r.chats?.name || (out ? 'Outgoing call' : 'Incoming call'))),
        h('div', { class: 'row-prev', style: r.state === 'missed' ? { color: 'var(--danger)' } : {} },
          `${label}${r.duration ? ' · ' + dur(r.duration) : ''}`)),
      h('div', { class: 'row-side' }, shortWhen(r.started_at))));
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
    body.append(h('div', { class: 'day-sep', style: { justifySelf: 'start', margin: '10px 16px' } }, title));
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
        h('span', {}, (m.body || `[${m.kind}]`).slice(0, 140)),
        h('small', {}, [nameOf(m.sender_id), shortWhen(m.created_at), r[noteKey]].filter(Boolean).join(' · '))));
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
  if (!pend.length) body.append(h('div', { class: 'empty' }, h('p', {}, 'Nothing queued'),
    h('p', { class: 'hint' }, 'Use the clock in the composer to schedule a message.')));
  pend.forEach(r => body.append(h('div', { class: 'result' },
    h('b', {}, r.chats?.name || 'Chat'),
    h('span', {}, (r.body || '').slice(0, 140)),
    h('small', {}, `${new Date(r.send_at).toLocaleString()}${r.recurrence ? ' · repeats ' + r.recurrence : ''}`),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
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
    body.append(h('div', { class: 'day-sep', style: { justifySelf: 'start', margin: '10px 16px' } }, 'History'));
    seen.slice(0, 20).forEach(r => body.append(h('div', { class: 'result' },
      h('b', {}, r.chats?.name || 'Chat'), h('span', {}, (r.body || '').slice(0, 100)),
      h('small', {}, `${r.status} · ${shortWhen(r.send_at)}`))));
  }
}

/* ── search across everything ──────────────────────────────────────────── */
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
      body.append(h('div', { class: 'day-sep', style: { justifySelf: 'start', margin: '10px 16px' } }, 'People'));
      people.forEach(p => body.append(personRow(p)));
    }
    body.append(h('div', { class: 'day-sep', style: { justifySelf: 'start', margin: '10px 16px' } }, `Messages (${msgs.length})`));
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
