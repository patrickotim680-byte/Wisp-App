import { sb, rpc, sel, ins, upd, del } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, $$, h, clear, esc, linkify, firstUrl, clock, dayLabel, dur, bytes, initials,
         toast, oops, modal, closeModal, confirmBox, promptBox, iconEl, debounce } from './util.js';
import { attUrl, thumbUrl } from './media.js';
import { openBody } from './crypto.js';
import { getCachedThread, setCachedThread } from './cache.js';

const PAGE = 80;
let atBottom = true;

// Applies a cached {msgs, status, reacts} payload onto live state without
// rendering — shared by openChat() (synchronous, from the in-memory layer)
// and loadMessages() below (from disk/network), so both go through the
// same merge logic. Returns whether there was anything to apply.
export function applyCachedThread(payload) {
  if (!payload) return false;
  S.msgs = payload.msgs;
  mergeRows(S.status, payload.status, (a, b) => a.user_id === b.user_id);
  mergeRows(S.reacts, payload.reacts, (a, b) => a.user_id === b.user_id && a.emoji === b.emoji);
  return true;
}

export async function loadMessages() {
  const chatId = S.chat.chat_id;

  // openChat() already paints the in-memory cache synchronously before this
  // even runs (see chats.js) — this call mainly covers the case where this
  // chat hasn't been touched yet this session and only disk has it.
  const cached = await getCachedThread(chatId);
  if (cached && S.chat?.chat_id === chatId && applyCachedThread(cached)) {
    renderThread(true);
    renderPinStrip();
  }

  const { data, error } = await sb.from('messages')
    .select('*').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(PAGE);
  // The user may have switched to a different chat while this was in flight.
  // Applying a late response for a chat that's no longer open is exactly how
  // one conversation's messages end up showing under another one's name.
  if (S.chat?.chat_id !== chatId) return;
  if (error) {
    // We already showed the cached copy, so a flaky connection isn't a dead
    // end — only surface the error if there was nothing to fall back on.
    if (!cached) return oops(error);
    return;
  }
  S.msgs = data.reverse();
  await hydrate(S.msgs);
  if (S.chat?.chat_id !== chatId) return;
  renderThread(true);
  renderPinStrip();
}

function mergeRows(map, rows, sameKey) {
  (rows || []).forEach(r => {
    const arr = map.get(r.message_id) || [];
    if (!arr.some(x => sameKey(x, r))) map.set(r.message_id, [...arr, r]);
  });
}

export async function loadOlder() {
  if (!S.msgs.length) return;
  const chatId = S.chat.chat_id;
  const oldest = S.msgs[0].created_at;
  const { data } = await sb.from('messages').select('*').eq('chat_id', chatId)
    .lt('created_at', oldest).order('created_at', { ascending: false }).limit(PAGE);
  if (S.chat?.chat_id !== chatId || !data?.length) return;
  const keepH = $('#thread').scrollHeight;
  S.msgs = [...data.reverse(), ...S.msgs];
  await hydrate(data);
  if (S.chat?.chat_id !== chatId) return;
  renderThread(false);
  $('#thread').scrollTop = $('#thread').scrollHeight - keepH;
}

async function hydrate(msgs) {
  const ids = msgs.map(m => m.id);
  if (!ids.length) return;
  const [st, rx] = await Promise.all([
    sb.from('message_status').select('*').in('message_id', ids),
    sb.from('reactions').select('*').in('message_id', ids),
  ]);
  (st.data || []).forEach(r => {
    const arr = S.status.get(r.message_id) || [];
    S.status.set(r.message_id, [...arr.filter(x => x.user_id !== r.user_id), r]);
  });
  (rx.data || []).forEach(r => {
    const arr = S.reacts.get(r.message_id) || [];
    S.reacts.set(r.message_id, [...arr.filter(x => !(x.user_id === r.user_id && x.emoji === r.emoji)), r]);
  });
  if (S.chat?.e2ee) for (const m of msgs) if (m.cipher) m.body = await openBody(m.chat_id, m.cipher, m.iv) ?? null;
}

export async function appendMessage(m) {
  // realtime echo of a message we sent optimistically: swap it in place
  const tmp = m.client_id ? S.msgs.findIndex(x => x.client_id === m.client_id) : -1;
  if (tmp >= 0) { S.msgs[tmp] = { ...S.msgs[tmp], ...m, pendingSend: false }; await hydrate([m]); return renderThread(false); }
  S.msgs.push(m);
  await hydrate([m]);
  const wasBottom = atBottom;
  renderThread(wasBottom);
}

export function patchStatus({ new: r }) {
  if (!r?.message_id) return;
  const arr = S.status.get(r.message_id) || [];
  S.status.set(r.message_id, [...arr.filter(x => x.user_id !== r.user_id), r]);
  const el = document.querySelector(`[data-mid="${r.message_id}"] .ticks`);
  if (el) { const m = S.msgs.find(x => x.id === r.message_id); if (m) el.replaceWith(ticks(m)); }
}
export function patchReaction({ new: r, old, eventType }) {
  const id = r?.message_id || old?.message_id;
  if (!id) return;
  const arr = S.reacts.get(id) || [];
  S.reacts.set(id, eventType === 'DELETE'
    ? arr.filter(x => !(x.user_id === old.user_id && x.emoji === old.emoji))
    : [...arr.filter(x => !(x.user_id === r.user_id && x.emoji === r.emoji)), r]);
  renderThread(false);
}

function ticks(m) {
  const wrap = h('span', { class: 'ticks' });
  if (m.sender_id !== S.me.id) return wrap;
  if (m.pendingSend) { wrap.textContent = '◌'; return wrap; }
  if (m.failed) { wrap.textContent = '!'; wrap.style.color = 'var(--danger)'; return wrap; }
  const rows = S.status.get(m.id) || [];
  const others = rows.length;
  if (!others) { wrap.textContent = '✓'; return wrap; }
  const read = rows.filter(r => r.read_at).length;
  const delivered = rows.filter(r => r.delivered_at).length;
  if (read === others) { wrap.textContent = '✓✓'; wrap.classList.add('read'); }
  else if (delivered === others) wrap.textContent = '✓✓';
  else wrap.textContent = '✓';
  wrap.title = `delivered ${delivered}/${others} · read ${read}/${others}`;
  return wrap;
}

// Debounced so a burst of updates (hydrate, reactions, ticks) writes to disk
// once, not once per change. Runs off of renderThread so every path that
// mutates the thread — send, receive, edit, react, delete — keeps the local
// cache current with zero extra call sites to remember.
const saveCache = debounce(() => {
  const c = S.chat;
  if (!c) return;
  const real = S.msgs.filter(m => !String(m.id).startsWith('tmp-'));
  const ids = real.map(m => m.id);
  setCachedThread(c.chat_id, {
    msgs: real,
    status: ids.flatMap(id => S.status.get(id) || []),
    reacts: ids.flatMap(id => S.reacts.get(id) || []),
    at: Date.now(),
  });
}, 350);

export function renderThread(scroll = true) {
  const thread = $('#thread');
  if (!S.chat) return;
  saveCache();
  clear(thread);
  let lastDay = '', lastSender = null;
  const visible = S.msgs.filter(m => !m.hiddenLocal);
  visible.forEach(m => {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) { thread.append(h('div', { class: 'day-sep' }, day)); lastDay = day; lastSender = null; }
    if (m.kind === 'system') { thread.append(h('div', { class: 'sys' }, m.body)); lastSender = null; return; }
    thread.append(bubble(m, lastSender !== m.sender_id));
    lastSender = m.sender_id;
  });
  if (!visible.length) thread.append(h('div', { class: 'empty' },
    h('p', {}, 'No messages yet'), h('p', { class: 'hint' }, 'Say something.')));
  if (scroll) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  renderPinStrip();
}

function bubble(m, showAuthor) {
  const out = m.sender_id === S.me.id;
  const selected = S.selection.has(m.id);
  const wrap = h('div', {
    class: `msg ${out ? 'out' : 'in'}${selected ? ' sel' : ''}`,
    dataset: { mid: m.id },
    onclick: e => { if (S.selection.size) { e.preventDefault(); toggleSelect(m.id); } },
  });
  if (!out && showAuthor && S.chat.type !== 'dm') wrap.append(h('div', { class: 'msg-author' }, nameOf(m.sender_id)));

  const bub = h('div', { class: 'bub' + (m.attachment && !m.body ? ' tight' : '') });

  if (m.reply_to) {
    const src = S.msgs.find(x => x.id === m.reply_to);
    bub.append(h('div', {
      class: 'quote', onclick: e => { e.stopPropagation(); jumpTo(m.reply_to); },
    }, h('b', {}, src ? nameOf(src.sender_id) : 'Message'),
      h('span', {}, src ? (src.body || `[${src.kind}]`).slice(0, 120) : 'Jump to message')));
  }
  if (m.forwarded_from) bub.append(h('div', { class: 'hint' }, 'Forwarded'));

  if (m.deleted_all) bub.append(h('i', { class: 'muted' }, 'This message was deleted'));
  else if (m.cipher && !m.body) bub.append(h('i', { class: 'muted' }, '🔐 Encrypted. Unlock your key to read it.'));
  else {
    renderBody(m, bub);
    if (m.body) {
      const url = firstUrl(m.body);
      if (url && !m.attachment) linkPreview(url, bub);
    }
  }

  const foot = h('div', { class: 'msg-foot' },
    m.edited_at && h('span', {}, 'edited'),
    S.starred.has(m.id) && h('span', {}, '★'),
    S.bookmarked.has(m.id) && h('span', {}, '🔖'),
    m.expires_at && h('span', { title: 'disappears' }, '⏳'),
    h('span', {}, clock(m.created_at)),
    ticks(m));
  bub.append(foot);
  bub.append(tools(m, out));
  wrap.append(bub);

  const rx = S.reacts.get(m.id) || [];
  if (rx.length) {
    const groups = {};
    rx.forEach(r => (groups[r.emoji] = groups[r.emoji] || []).push(r.user_id));
    wrap.append(h('div', { class: 'reacts' }, Object.entries(groups).map(([emoji, users]) =>
      h('button', {
        class: 'react' + (users.includes(S.me.id) ? ' mine' : ''),
        title: users.map(nameOf).join(', '),
        onclick: e => { e.stopPropagation(); react(m.id, emoji); },
      }, emoji, ' ', String(users.length)))));
  }
  return wrap;
}

function renderBody(m, bub) {
  const a = m.attachment;
  if (m.view_once && m.sender_id !== S.me.id) {
    const seen = (m.meta?.viewed_by || []).includes(S.me.id);
    if (seen) return void bub.append(h('div', { class: 'viewonce' }, '👁 Opened'));
    return void bub.append(h('button', {
      class: 'btn small', onclick: async e => {
        e.stopPropagation();
        await rpc('mark_view_once_seen', { p_message: m.id });
        const url = await attUrl(a);
        modal(h('h3', { class: 'display' }, 'View once'),
          a.mime?.startsWith('video') ? h('video', { src: url, controls: true, autoplay: true }) : h('img', { src: url }),
          h('p', { class: 'hint' }, 'This closes for good when you dismiss it.'),
          h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
      },
    }, '👁 View once media'));
  }

  switch (m.kind) {
    case 'image': case 'video': {
      const box = h('div', { class: 'media' });
      bub.append(box);
      thumbUrl(a).then(u => {
        if (!u) return;
        box.append(m.kind === 'video'
          ? h('video', { src: '', poster: u, controls: true, preload: 'none', onplay: async e => { if (!e.target.src) e.target.src = await attUrl(a); } })
          : h('img', { src: u, loading: 'lazy', onclick: async ev => { ev.stopPropagation(); lightbox(await attUrl(a), a.mime); } }));
      });
      if (m.body) bub.append(h('div', { html: linkify(m.body) }));
      break;
    }
    case 'voice': case 'audio': voicePlayer(m, bub); break;
    case 'document': {
      const row = h('div', { class: 'doc-row' },
        h('div', { class: 'doc-glyph' }, (a.name?.split('.').pop() || 'file').slice(0, 4).toUpperCase()),
        h('div', {}, h('div', {}, a.name), h('small', { class: 'hint' }, bytes(a.size || 0))));
      row.style.cursor = 'pointer';
      row.onclick = async e => {
        e.stopPropagation();
        const url = await attUrl(a);
        if (a.mime === 'application/pdf') {
          modal(h('h3', { class: 'display' }, a.name),
            h('iframe', { src: url, style: { width: '100%', height: '62vh', border: '0', borderRadius: '12px' } }),
            h('div', { class: 'modal-actions' },
              h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Open'),
              h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
        } else window.open(url, '_blank', 'noopener');
      };
      bub.append(row);
      if (m.body) bub.append(h('div', { html: linkify(m.body) }));
      break;
    }
    case 'location': {
      const { lat, lng, live, expires_at } = m.meta || {};
      bub.append(h('a', {
        href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`,
        target: '_blank', rel: 'noopener',
      }, live ? '📍 Live location' : '📍 Location', ' · ', `${(+lat).toFixed(4)}, ${(+lng).toFixed(4)}`));
      if (live && expires_at) bub.append(h('div', { class: 'hint' }, new Date(expires_at) > new Date()
        ? `sharing until ${clock(expires_at)}` : 'sharing ended'));
      break;
    }
    case 'contact': {
      const c = m.meta || {};
      bub.append(h('div', {},
        h('div', { class: 'doc-row' }, h('div', { class: 'av' }, initials(c.name)),
          h('div', {}, h('div', {}, c.name), h('small', { class: 'hint' }, c.email || c.phone || ''))),
        c.user_id && h('button', {
          class: 'btn small',
          onclick: async e => { e.stopPropagation(); (await import('./chats.js')).startDm(c.user_id); },
        }, 'Message')));
      break;
    }
    case 'sticker': bub.append(h('div', { style: { fontSize: '54px', lineHeight: '1' } }, m.body)); break;
    case 'poll': pollView(m, bub); break;
    case 'call': bub.append(h('div', {}, m.body)); break;
    default: bub.append(h('div', { html: linkify(m.body || '') }));
  }
}

function lightbox(url, mime) {
  modal(mime?.startsWith('video') ? h('video', { src: url, controls: true, autoplay: true })
    : h('img', { src: url, style: { borderRadius: '12px' } }),
    h('div', { class: 'modal-actions' },
      h('a', { class: 'btn', href: url, download: '', target: '_blank', rel: 'noopener' }, 'Download'),
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

/* ── voice notes ───────────────────────────────────────────────────────── */
function voicePlayer(m, bub) {
  const a = m.attachment || {};
  const cv = h('canvas', { height: 28 });
  const btn = h('button', { class: 'icon-btn' });
  btn.innerHTML = '';
  btn.append(iconEl('play', 18));
  const rate = h('button', { class: 'rate' }, '1×');
  const time = h('small', {}, dur(a.duration || 0));
  const row = h('div', { class: 'voice' }, btn, cv, time, rate);
  bub.append(row);
  const peaks = a.waveform || [];
  const draw = (p = 0) => {
    const w = cv.width = cv.clientWidth * devicePixelRatio || 200;
    const hh = cv.height = 28 * devicePixelRatio;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, hh);
    const n = Math.max(1, Math.floor(w / (4 * devicePixelRatio)));
    for (let i = 0; i < n; i++) {
      const v = peaks.length ? peaks[Math.floor(i / n * peaks.length)] : 0.35;
      const bh = Math.max(2 * devicePixelRatio, v * hh);
      ctx.fillStyle = i / n <= p ? getComputedStyle(bub).color : getComputedStyle(bub).color;
      ctx.globalAlpha = i / n <= p ? 1 : 0.35;
      ctx.fillRect(i * 4 * devicePixelRatio, (hh - bh) / 2, 2.4 * devicePixelRatio, bh);
    }
  };
  requestAnimationFrame(() => draw(0));
  let audio;
  btn.onclick = async e => {
    e.stopPropagation();
    if (!audio) {
      audio = new Audio(await attUrl(a));
      audio.playbackRate = +rate.textContent.replace('×', '');
      audio.ontimeupdate = () => { draw(audio.currentTime / (audio.duration || 1)); time.textContent = dur(audio.currentTime); };
      audio.onended = () => { btn.innerHTML = ''; btn.append(iconEl('play', 18)); draw(0); time.textContent = dur(a.duration || 0); };
    }
    if (audio.paused) { audio.play(); btn.innerHTML = ''; btn.append(iconEl('pause', 18)); }
    else { audio.pause(); btn.innerHTML = ''; btn.append(iconEl('play', 18)); }
  };
  rate.onclick = e => {
    e.stopPropagation();
    const next = { '1×': '1.5×', '1.5×': '2×', '2×': '1×' }[rate.textContent];
    rate.textContent = next;
    if (audio) audio.playbackRate = +next.replace('×', '');
  };
  if (m.meta?.transcript) bub.append(h('div', { class: 'hint', style: { marginTop: '4px' } }, '“' + m.meta.transcript + '”'));
}

/* ── polls ─────────────────────────────────────────────────────────────── */
async function pollView(m, bub) {
  const box = h('div', { class: 'poll' }, h('b', {}, m.meta?.question || 'Poll'));
  bub.append(box);
  const { data: poll } = await sb.from('polls').select('*, poll_options(*)').eq('message_id', m.id).maybeSingle();
  if (!poll) return;
  const { data: votes } = await sb.from('poll_votes').select('*').eq('poll_id', poll.id);
  const total = votes?.length || 0;
  poll.poll_options.sort((a, b) => a.position - b.position).forEach(o => {
    const mine = votes.some(v => v.option_id === o.id && v.user_id === S.me.id);
    const n = votes.filter(v => v.option_id === o.id).length;
    box.append(h('div', {
      class: 'poll-opt', onclick: async e => {
        e.stopPropagation();
        try {
          if (mine) await del('poll_votes', { option_id: o.id, user_id: S.me.id });
          else {
            if (!poll.multi) for (const v of votes.filter(v => v.user_id === S.me.id)) await del('poll_votes', { option_id: v.option_id, user_id: S.me.id });
            await ins('poll_votes', { option_id: o.id, poll_id: poll.id, user_id: S.me.id });
          }
          renderThread(false);
        } catch (err) { oops(err); }
      },
    }, h('div', { class: 'kv' }, h('span', { style: { color: 'inherit', fontWeight: mine ? '600' : '400' } }, (mine ? '● ' : '○ ') + o.label), h('small', {}, String(n))),
      h('div', { class: 'poll-bar' }, h('i', { style: { width: total ? (n / total * 100) + '%' : '0%' } }))));
  });
  box.append(h('small', { class: 'hint' }, `${total} vote${total === 1 ? '' : 's'}`));
}

/* ── link previews (cached in DB, filled by an Edge Function) ──────────── */
const previewSeen = new Set();
async function linkPreview(url, bub) {
  const card = h('div', { class: 'preview-card' }, h('small', {}, new URL(url).hostname));
  bub.append(card);
  try {
    let { data } = await sb.from('link_previews').select('*').eq('url', url).maybeSingle();
    if (!data && !previewSeen.has(url)) {
      previewSeen.add(url);
      const { data: fn } = await sb.functions.invoke('link-preview', { body: { url } });
      data = fn?.preview || null;
    }
    if (!data) return;
    clear(card).append(
      data.image && h('img', { src: data.image, loading: 'lazy', style: { borderRadius: '8px', maxHeight: '150px', objectFit: 'cover' } }),
      h('b', {}, data.title || url),
      data.description && h('small', {}, data.description.slice(0, 160)),
      h('small', { class: 'hint' }, data.site || new URL(url).hostname));
  } catch { /* preview is a nicety, never block the message */ }
}

/* ── per-message actions ───────────────────────────────────────────────── */
function tools(m, out) {
  const bar = h('div', { class: 'msg-tools' });
  const add = (name, title, fn) => {
    const b = h('button', { title, onclick: e => { e.stopPropagation(); fn(); } });
    b.append(iconEl(name, 15)); bar.append(b);
  };
  add('smile', 'React', () => reactPicker(m.id));
  add('reply', 'Reply', () => setReply(m));
  add('fwd', 'Forward', () => forwardPicker([m.id]));
  add('star', S.starred.has(m.id) ? 'Unstar' : 'Star', () => toggleStar(m.id));
  add('bookmark', 'Read later', () => toggleBookmark(m));
  add('pin', m.pinned_at ? 'Unpin' : 'Pin', () => togglePin(m));
  add('dots', 'More', () => moreMenu(m, out));
  return bar;
}

function moreMenu(m, out) {
  const item = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: async () => { closeModal(); try { await fn(); } catch (e) { oops(e); } } }, label);
  const canEdit = out && !m.attachment && Date.now() - new Date(m.created_at) < 15 * 60000;
  modal(h('h3', { class: 'display' }, 'Message'), h('div', { class: 'stack' },
    item('Select', () => toggleSelect(m.id)),
    m.body && item('Copy text', () => navigator.clipboard.writeText(m.body).then(() => toast('Copied'))),
    canEdit && item('Edit', async () => {
      const v = await promptBox('Edit message', { label: 'Text', value: m.body || '' });
      if (v !== null) await rpc('edit_message', { p_message: m.id, p_body: v });
    }),
    item('Message info', () => infoBox(m)),
    m.body && item('Translate', () => translate(m)),
    item('Delete for me', async () => {
      await ins('message_hides', { message_id: m.id, user_id: S.me.id });
      m.hiddenLocal = true; renderThread(false);
    }, 'danger'),
    (out || S.members.find(x => x.user_id === S.me.id)?.role !== 'member') &&
      item('Delete for everyone', async () => { await rpc('delete_for_everyone', { p_message: m.id }); }, 'danger'),
    !out && item('Report message', async () => {
      const reason = await promptBox('Report', { label: 'What is wrong with it?' });
      if (reason) { await ins('reports', { reporter_id: S.me.id, message_id: m.id, user_id: m.sender_id, reason }); toast('Reported.'); }
    }, 'danger')));
}

function infoBox(m) {
  const rows = S.status.get(m.id) || [];
  modal(h('h3', { class: 'display' }, 'Message info'),
    h('div', { class: 'stack' },
      h('div', { class: 'kv' }, h('span', {}, 'Sent'), h('b', {}, new Date(m.created_at).toLocaleString())),
      ...rows.map(r => h('div', { class: 'kv' }, h('span', {}, nameOf(r.user_id)),
        h('b', {}, r.read_at ? 'read ' + clock(r.read_at) : r.delivered_at ? 'delivered ' + clock(r.delivered_at) : 'sent'))),
      !rows.length && h('p', { class: 'hint' }, 'No recipients recorded.')),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

async function translate(m) {
  // Uses the browser's built-in Translator API when available. No third-party
  // service is called, and nothing is silently faked when it is missing.
  if (!('Translator' in self)) return toast('This browser has no on-device translator. Nothing else is wired up, so no translation.', true);
  try {
    const target = navigator.language.split('-')[0];
    const tr = await self.Translator.create({ sourceLanguage: 'auto', targetLanguage: target });
    const out = await tr.translate(m.body);
    modal(h('h3', { class: 'display' }, 'Translation'), h('p', {}, out),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
  } catch (e) { oops(e); }
}

const EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '👀', '💯'];
function reactPicker(id) {
  modal(h('h3', { class: 'display' }, 'React'),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '26px' } },
      EMOJI.map(e => h('button', { class: 'btn ghost', onclick: () => { closeModal(); react(id, e); } }, e))));
}
export async function react(messageId, emoji) {
  const mine = (S.reacts.get(messageId) || []).some(r => r.user_id === S.me.id && r.emoji === emoji);
  try {
    if (mine) await del('reactions', { message_id: messageId, user_id: S.me.id, emoji });
    else await ins('reactions', { message_id: messageId, user_id: S.me.id, emoji });
  } catch (e) { oops(e); }
}
export async function toggleStar(id) {
  try {
    if (S.starred.has(id)) { await del('stars', { message_id: id, user_id: S.me.id }); S.starred.delete(id); }
    else { await ins('stars', { message_id: id, user_id: S.me.id }); S.starred.add(id); }
    renderThread(false);
  } catch (e) { oops(e); }
}
export async function toggleBookmark(m) {
  try {
    if (S.bookmarked.has(m.id)) { await del('bookmarks', { message_id: m.id, user_id: S.me.id }); S.bookmarked.delete(m.id); }
    else {
      const note = await promptBox('Read later', { label: 'Note (optional)' });
      await ins('bookmarks', { message_id: m.id, user_id: S.me.id, note: note || null });
      S.bookmarked.add(m.id);
    }
    renderThread(false);
  } catch (e) { oops(e); }
}
export async function togglePin(m) {
  try {
    const nowPinned = await rpc('toggle_pin', { p_message: m.id });
    m.pinned_at = nowPinned ? new Date().toISOString() : null;
    renderPinStrip(); renderThread(false);
  } catch (e) { oops(e); }
}

export function renderPinStrip() {
  const strip = $('#pin-strip');
  const pins = S.msgs.filter(m => m.pinned_at);
  if (!pins.length) { strip.hidden = true; return; }
  strip.hidden = false;
  clear(strip).append(iconEl('pin', 15),
    h('span', {}, `${pins.length} pinned`),
    h('span', { class: 'muted', style: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } },
      (pins.at(-1).body || `[${pins.at(-1).kind}]`).slice(0, 80)));
  strip.onclick = () => modal(h('h3', { class: 'display' }, 'Pinned in this chat'),
    h('div', { class: 'stack' }, pins.map(p => h('button', {
      class: 'result', onclick: () => { closeModal(); jumpTo(p.id); },
    }, h('b', {}, nameOf(p.sender_id)), h('span', {}, (p.body || `[${p.kind}]`).slice(0, 140)),
      h('small', {}, new Date(p.created_at).toLocaleString())))),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

export function setReply(m) {
  S.replyTo = m;
  const chip = $('#reply-chip');
  chip.hidden = false;
  clear(chip).append(h('b', {}, nameOf(m.sender_id)),
    h('span', { class: 'muted' }, (m.body || `[${m.kind}]`).slice(0, 90)),
    h('button', { class: 'btn small ghost', onclick: () => { S.replyTo = null; chip.hidden = true; } }, '✕'));
  $('#input').focus();
}

export function jumpTo(id) {
  const el = document.querySelector(`[data-mid="${id}"]`);
  if (!el) return toast('Scroll back a bit, it is not loaded yet.');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('sel');
  setTimeout(() => el.classList.remove('sel'), 1200);
}

/* ── multi-select ──────────────────────────────────────────────────────── */
export function toggleSelect(id) {
  S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id);
  const bar = $('#select-bar');
  bar.hidden = S.selection.size === 0;
  $('#select-count').textContent = `${S.selection.size} selected`;
  renderThread(false);
}
export function clearSelection() { S.selection.clear(); $('#select-bar').hidden = true; renderThread(false); }

export function forwardPicker(messageIds) {
  const picked = new Set();
  const list = h('div', { class: 'stack', style: { maxHeight: '46vh', overflowY: 'auto' } },
    S.chats.filter(c => !c.archived).map(c => h('label', { class: 'member' },
      h('input', { type: 'checkbox', onchange: e => e.target.checked ? picked.add(c.chat_id) : picked.delete(c.chat_id) }),
      h('div', { class: 'av' }, initials(c.name)), c.name || 'Chat')));
  modal(h('h3', { class: 'display' }, `Forward ${messageIds.length} message${messageIds.length > 1 ? 's' : ''}`),
    h('p', { class: 'hint' }, 'Encrypted messages are skipped: their key is not shared with the target chat.'),
    list,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          try {
            const n = await rpc('forward_messages', { p_messages: messageIds, p_chats: [...picked] });
            closeModal(); clearSelection(); toast(`Forwarded ${n}.`);
          } catch (e) { oops(e); }
        },
      }, 'Send')));
}

export function mountThread() {
  const thread = $('#thread');
  thread.addEventListener('scroll', () => {
    atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    if (thread.scrollTop < 60) loadOlder();
  });
  $('#sel-forward').onclick = () => forwardPicker([...S.selection]);
  $('#sel-star').onclick = async () => { for (const id of S.selection) if (!S.starred.has(id)) await toggleStar(id); clearSelection(); };
  $('#sel-cancel').onclick = clearSelection;
  $('#sel-delete').onclick = async () => {
    if (!await confirmBox(`Delete ${S.selection.size} message(s)?`, 'Deletes for you. Your own recent ones go for everyone.', 'Delete')) return;
    for (const id of S.selection) {
      const m = S.msgs.find(x => x.id === id);
      const recentMine = m.sender_id === S.me.id && Date.now() - new Date(m.created_at) < 3600e3;
      try {
        if (recentMine) await rpc('delete_for_everyone', { p_message: id });
        else { await ins('message_hides', { message_id: id, user_id: S.me.id }); m.hiddenLocal = true; }
      } catch (e) { oops(e); }
    }
    clearSelection();
  };
}
