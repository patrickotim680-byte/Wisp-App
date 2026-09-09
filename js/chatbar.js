// The chat control bar: the same glass pill as the call overlay, but for a
// conversation. Mute, archive, pin, display, media and mark-read used to be
// hidden behind a long-press on the chat row (undiscoverable on desktop,
// accidental on touch), so they live here instead.
//
// Also owns the measurement of the floating chrome: the thread is full-bleed
// under the header and composer now, so it needs to know how much room to
// leave. Heights are read from the live elements rather than hard-coded,
// because the header grows with a long name and the composer grows as the
// textarea does.
import { S, person } from './state.js';
import { sel, upd, rpc, upload } from './db.js';
import { $, h, clear, icon, toast, oops, closeModal, modal, confirmBox } from './util.js';
import { saveSettings, applyWallpaper } from './theme.js';
import { compressImage } from './media.js';

export function mountChatChrome() {
  const inner = $('#conv-inner'), top = $('#conv-top'), foot = $('#composer');
  if (!inner || !top || !foot) return;
  const measure = () => {
    inner.style.setProperty('--top-h', Math.round(top.offsetHeight) + 'px');
    inner.style.setProperty('--foot-h', Math.round(foot.offsetHeight) + 'px');
  };
  measure();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => measure());
    ro.observe(top); ro.observe(foot);
  } else {
    addEventListener('resize', measure);
  }
  // Showing/hiding a sibling (pinned strip, selection bar) is an attribute
  // change, which does not always resize the observed node in one pass.
  new MutationObserver(() => requestAnimationFrame(measure))
    .observe(top, { attributes: true, childList: true, subtree: true });
}

const refresh = async () => {
  const m = await import('./chats.js');
  await m.loadChats();
  renderChatBar();
};

export function renderChatBar() {
  const bar = $('#chatbar');
  if (!bar) return;
  const c = S.chat;
  if (!c) { bar.hidden = true; return; }
  const me = { chat_id: c.chat_id, user_id: S.me.id };
  const isDm = c.type === 'dm';
  const who = isDm ? (person(c.other_id)?.display_name?.split(' ')[0] || 'them') : 'this chat';

  bar.hidden = false;
  clear(bar);

  const btn = (glyph, label, opts = {}) => {
    const b = h('button', {
      class: 'cb-btn' + (opts.on ? ' is-on' : '') + (opts.danger ? ' danger' : ''),
      type: 'button', title: opts.title || label,
      onclick: async () => { try { await opts.onclick(); } catch (e) { oops(e); } },
    });
    b.innerHTML = icon(glyph, 19);
    b.append(h('span', { class: 'cb-label' }, label));
    bar.append(b);
    return b;
  };

  btn(c.muted ? 'bell-off' : 'bell', c.muted ? 'Muted' : 'Mute', {
    on: !!c.muted,
    title: c.muted ? `Unmute ${who}` : `Mute ${who}`,
    onclick: async () => {
      if (c.muted) {
        await upd('chat_members', { muted_until: null, mute_forever: false }, me);
        toast('Notifications back on.');
        return refresh();
      }
      muteSheet(c);
    },
  });

  btn(c.archived ? 'unarchive' : 'archive', c.archived ? 'Unarchive' : 'Archive', {
    on: !!c.archived,
    onclick: async () => {
      await upd('chat_members', { archived: !c.archived }, me);
      toast(c.archived ? 'Back in your chats.' : 'Archived.');
      await refresh();
    },
  });

  btn(c.pinned ? 'pin-off' : 'pin', c.pinned ? 'Unpin' : 'Pin', {
    on: !!c.pinned,
    onclick: async () => { await upd('chat_members', { pinned: !c.pinned }, me); await refresh(); },
  });

  btn('palette', 'Display', { title: 'Theme, text size, wallpaper', onclick: openDisplay });

  btn('grid', 'Media', {
    title: 'Photos, videos and files in this chat',
    onclick: async () => (await import('./panels.js')).sharedMedia(),
  });

  btn('check-double', 'Mark read', {
    onclick: async () => { await rpc('mark_read', { p_chat: c.chat_id }); await refresh(); },
  });

  btn('dots', 'More', {
    title: 'Everything else for this chat',
    onclick: async () => (await import('./chats.js')).chatMenu(c),
  });
}

/* ── mute, with real choices ─────────────────────────────────────── */
export function muteSheet(chat) {
  const c = chat || S.chat;
  const me = { chat_id: c.chat_id, user_id: S.me.id };
  const pick = async patch => {
    await upd('chat_members', patch, me);
    toast('Muted.');
    await refresh();
  };
  const opt = (label, hours) => h('button', {
    class: 'sheet-row', onclick: () => {
      closeModal();
      pick(hours
        ? { muted_until: new Date(Date.now() + hours * 3600e3).toISOString(), mute_forever: false }
        : { mute_forever: true, muted_until: null }).catch(oops);
    },
  }, h('span', { class: 'sheet-ico', html: icon(hours ? 'clock' : 'bell-off', 19) }),
    h('span', { class: 'sheet-label' }, h('b', {}, label)));

  modal(h('h3', { class: 'display' }, 'Mute for'),
    h('p', { class: 'hint' }, 'Muted chats stop notifying and stop counting toward the badge. You still see the unread mark.'),
    h('div', { class: 'sheet-list' },
      opt('1 hour', 1), opt('8 hours', 8), opt('1 week', 168), opt('Until I turn it back on', 0)),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel')));
}

/* ── display ───────────────────────────────────────────────────
   The things people actually reach for while reading a chat. Same controls
   as Settings > Appearance, writing to the same row, so the two can never
   disagree. */
function segment(options, value, onpick) {
  const wrap = h('div', { class: 'seg' });
  wrap.style.setProperty('--seg-n', String(options.length));
  wrap.append(h('span', { class: 'seg-glow' }));
  options.forEach(([val, label], i) => wrap.append(h('button', {
    type: 'button',
    onclick: e => {
      [...wrap.querySelectorAll('button')].forEach(b => b.classList.remove('is-on'));
      e.currentTarget.classList.add('is-on');
      wrap.style.setProperty('--seg-i', String(i));
      onpick(val);
    },
  }, label)));
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  wrap.style.setProperty('--seg-i', String(idx));
  [...wrap.querySelectorAll('button')].forEach((b, i) => b.classList.toggle('is-on', i === idx));
  return wrap;
}
function slider(min, max, step, value, oninput, fmt = v => v) {
  const out = h('small', { class: 'hint' }, fmt(value));
  const s = h('input', {
    type: 'range', min, max, step, value,
    oninput: e => { out.textContent = fmt(+e.target.value); oninput(+e.target.value); },
  });
  return h('div', { style: { display: 'grid', gap: '4px', minWidth: '150px' } }, s, out);
}
const row = (label, control, note) => h('div', { class: 'kv' },
  h('div', {}, h('span', { style: { color: 'var(--ink)' } }, label), note && h('div', { class: 'hint' }, note)), control);

export function openDisplay() {
  const s = S.settings;
  const c = S.chat;
  modal(
    h('h3', { class: 'display' }, 'Display'),
    h('div', { class: 'card' },
      row('Theme', segment([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], s.theme_mode, v => saveSettings({ theme_mode: v }))),
      row('Text size', slider(0.85, 1.4, 0.05, s.text_scale, v => saveSettings({ text_scale: v }), v => Math.round(v * 100) + '%')),
      row('Bubble corners', slider(2, 26, 1, s.bubble_radius, v => saveSettings({ bubble_radius: v }), v => v + 'px')),
      row('Spacing', segment([['compact', 'Compact'], ['comfortable', 'Comfy'], ['spacious', 'Roomy']], s.density, v => saveSettings({ density: v })))),
    c && h('div', { class: 'card' },
      row('Chat wallpaper',
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { class: 'btn small', onclick: () => pickWallpaper(c) }, 'Change'),
          h('button', {
            class: 'btn small ghost', onclick: async () => {
              try {
                await upd('chat_members', { wallpaper_url: null }, { chat_id: c.chat_id, user_id: S.me.id });
                S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
                applyWallpaper(); toast('Back to your default wallpaper.');
              } catch (e) { oops(e); }
            },
          }, 'Reset')),
        'Only for this chat. Falls back to your global wallpaper when unset.'),
      row('Wallpaper dim', slider(0.15, 1, 0.05, s.wallpaper_opacity ?? 1, v => saveSettings({ wallpaper_opacity: v }), v => Math.round(v * 100) + '%')),
      row('Wallpaper blur', slider(0, 14, 1, s.wallpaper_blur ?? 0, v => saveSettings({ wallpaper_blur: v }), v => v + 'px'))),
    h('div', { class: 'modal-actions' },
      h('button', {
        class: 'btn ghost', onclick: async () => { closeModal(); (await import('./settings.js')).openSettings('appearance'); },
      }, 'All appearance settings'),
      h('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
}

function pickWallpaper(c) {
  const i = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const { blob } = await compressImage(f);
        const path = `${S.me.id}/${crypto.randomUUID()}.webp`;
        await upload('wallpapers', path, blob, 'image/webp');
        await upd('chat_members', { wallpaper_url: path }, { chat_id: c.chat_id, user_id: S.me.id });
        S.members = await sel('chat_members', { select: '*', eq: { chat_id: c.chat_id } });
        applyWallpaper();
        toast('Chat wallpaper set.');
      } catch (err) { oops(err); }
    },
  });
  document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
}
