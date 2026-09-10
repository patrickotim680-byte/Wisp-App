// DOM + formatting helpers, icons, toasts, modals, context menus.

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── icons (inline SVG, no icon font, no network) ─────────────────── */
/* P holds single-colour outline glyphs: one string of M-segments, stroked.
   Cheap and uniform, but it cannot express a filled shape, a rounded rect or
   a slash that has to punch through the artwork underneath it — which is
   exactly what the call controls need to look like the platform ones. Those
   live in F below as ready-made SVG children instead. */
const P = {
  chat: 'M9 3h12v9H9z M3 7h13v9H8l-4 4V7z', people: 'M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 19c0-3 3-5 6-5s6 2 6 5M14.5 14.2c2.6.3 5.5 2 5.5 4.8',
  call: 'M6 3h3l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v3a2 2 0 01-2 2A16 16 0 014 6a2 2 0 012-3z',
  video: 'M3 6h11v12H3zM14 10l7-4v12l-7-4z', star: 'M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l4 2', moon: 'M20 14A8 8 0 1110 4a7 7 0 1010 10z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 .8-2-1.2L14.6 4h-5l-.4 2.6-2 1.2L5 7 3 11l2 1-2 1 2 4 2-.8 2 1.2.4 2.6h5l.4-2.6 2-1.2 2 .8 2-4z',
  plus: 'M12 5v14M5 12h14', 'group-add': 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 19c0-3 3-5 6-5s6 2 6 5M18 8v6M15 11h6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5', spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.5', back: 'M15 5l-7 7 7 7',
  clip: 'M8 12l6-6a3 3 0 014 4l-8 8a5 5 0 01-7-7l8-8', smile: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9 10v.5M15 10v.5M8.5 14a5 5 0 007 0',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM6 12a6 6 0 0012 0M12 18v3',
  send: 'M2 21l21-9L2 3v7l15 2-15 2z',
  screen: 'M3 5h18v11H3zM9 20h6', reply: 'M9 7L4 12l5 5M4 12h9a5 5 0 015 5v2',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13', pin: 'M12 3v9M8 12h8l-4 9z', dots: 'M12 7v.5M12 12v.5M12 17v.5',
  check: 'M5 12l5 5L20 6', x: 'M6 6l12 12M18 6L6 18', fwd: 'M15 7l5 5-5 5M20 12H8a4 4 0 00-4 4v2',
  edit: 'M4 20h4L20 8l-4-4L4 16z', file: 'M6 3h8l4 4v14H6zM14 3v4h4', lock: 'M6 11h12v10H6zM9 11V8a3 3 0 016 0v3',
  down: 'M12 5v14M6 13l6 6 6-6', bookmark: 'M6 4h12v17l-6-4-6 4z', copy: 'M8 8h12v12H8zM4 16V4h12',
  play: 'M7 4l12 8-12 8z', pause: 'M8 5h3v14H8zM13 5h3v14h-3z', globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  'eye-off': 'M3 3l18 18M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M6.61 6.61A18.45 18.45 0 001 12s4 8 11 8a10.94 10.94 0 005.39-1.39',
  speaker: 'M4 9v6h3l5 4V5L7 9z M15 9a3 3 0 010 6 M18 6a7 7 0 010 12',
  wave: 'M4 10v4 M8 6v12 M12 3v18 M16 6v12 M20 10v4',

  /* added for the reorganised chrome: context menus, the wallpaper picker,
     the profile sheet and the settings list all label their rows now */
  image: 'M4 5h16v14H4z M4 16.5l4.6-5 3.4 3.8 3-2.6L20 17 M9 9.6v.01',
  palette: 'M12 21a9 9 0 010-18c5 0 9 3.4 9 7.6 0 2.6-2.1 4.4-4.7 4.4H15a2 2 0 00-1.4 3.4A1.7 1.7 0 0112 21z M7.6 10.2v.01 M10.2 7.2v.01 M14.2 7.6v.01',
  bell: 'M6 16v-5a6 6 0 1112 0v5l2 2H4z M10 21h4',
  'bell-off': 'M3 3l18 18 M8.4 5.4A6 6 0 0118 11v5l1.6 1.6 M6 11v5l-2 2h12 M10 21h4',
  archive: 'M3 6h18v4H3z M5 10v10h14V10 M10 14h4',
  chevron: 'M9 6l6 6-6 6',
  download: 'M12 4v11 M7.5 11.5l4.5 4.5 4.5-4.5 M5 20h14',
  person: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c0-4.1 3.6-6.6 8-6.6s8 2.5 8 6.6',
  eraser: 'M8.5 20H20 M4.5 16.2l7.3-7.3 5 5-4.4 4.4H8.5z M11.8 8.9l3.1-3.1 5 5-3.1 3.1',
  shield: 'M12 3l8 3v6c0 5-3.5 8.2-8 9.2-4.5-1-8-4.2-8-9.2V6z',
  sliders: 'M4 8h9 M17 8h3 M4 16h3 M11 16h9 M14 5.2v5.6 M8 13.2v5.6',
  folder: 'M3 7h6l2 2.4h10V20H3z',
  camera: 'M4 8h3.2L9 6h6l1.8 2H20v12H4z M12 17.4a3.6 3.6 0 100-7.2 3.6 3.6 0 000 7.2z',
  key: 'M14.5 9.5a4.2 4.2 0 10-4.7 4.2L8.4 15H6.6v2H4.6v2H2.5v-3.1l7.3-7.3a4.2 4.2 0 014.7-2z',
  logout: 'M10 5H5v14h5 M14.5 8.5l3.5 3.5-3.5 3.5 M9.5 12H18',
  broadcast: 'M12 14a2 2 0 100-4 2 2 0 000 4z M7.8 7.8a6 6 0 000 8.4 M16.2 7.8a6 6 0 010 8.4 M4.8 4.8a10 10 0 000 14.4 M19.2 4.8a10 10 0 010 14.4',
};

/* Filled artwork for the call controls, matching the platform call UI:
   a solid mic capsule over a stroked cradle, a display with an upward arrow,
   a speaker with two waves, a camcorder body plus lens wedge, and a solid
   handset (the hang-up button rotates it in CSS).

   The two "slashed" variants draw the diagonal twice: once fat in
   var(--glyph-cut) — the button's own background, set in call.css — so the
   line carves a visible gap through the glyph, then again thin in
   currentColor as the slash itself. Same trick the system icons use, and it
   keeps working when the button inverts to its light "off" state. */
const MIC_BODY = '<path fill="currentColor" stroke="none" d="M12 2.6a3.3 3.3 0 0 1 3.3 3.3v5.9a3.3 3.3 0 0 1-6.6 0V5.9A3.3 3.3 0 0 1 12 2.6Z"/>'
  + '<path stroke-width="2" d="M5.5 11.3a6.5 6.5 0 0 0 13 0M12 18v3.2"/>';
const CAM_BODY = '<path fill="currentColor" stroke="none" d="M4.1 6.4h8.5a2.3 2.3 0 0 1 2.3 2.3v6.6a2.3 2.3 0 0 1-2.3 2.3H4.1a2.3 2.3 0 0 1-2.3-2.3V8.7a2.3 2.3 0 0 1 2.3-2.3Z"/>'
  + '<path fill="currentColor" stroke="none" d="M16.4 10.9 21 8.05a.75.75 0 0 1 1.15.64v6.62a.75.75 0 0 1-1.15.64L16.4 13.1Z"/>';
const SLASH = '<path stroke="var(--glyph-cut, #3f3f3f)" stroke-width="3.6" d="M3.9 20.6 20.1 3.6"/>'
  + '<path stroke-width="2" d="M3.9 20.6 20.1 3.6"/>';

const F = {
  'mic-fill': MIC_BODY,
  'mic-off-fill': MIC_BODY + SLASH,
  'video-fill': CAM_BODY,
  'video-off-fill': CAM_BODY + SLASH,
  'screen-fill': '<rect x="2.7" y="4.9" width="18.6" height="13.1" rx="3.2" stroke-width="1.9"/>'
    + '<path fill="currentColor" stroke="none" d="M12 7.9l3.6 3.8h-2.45v3.9h-2.3v-3.9H8.4L12 7.9Z"/>',
  'screen-off-fill': '<rect x="2.7" y="4.9" width="18.6" height="13.1" rx="3.2" stroke-width="1.9"/>'
    + '<path fill="currentColor" stroke="none" d="M12 7.9l3.6 3.8h-2.45v3.9h-2.3v-3.9H8.4L12 7.9Z"/>' + SLASH,
  'speaker-fill': '<path fill="currentColor" stroke="none" d="M12.05 3.5a.9.9 0 0 1 .95.9v15.2a.9.9 0 0 1-1.5.67L7.1 16.35H4.2A1.2 1.2 0 0 1 3 15.15V8.85a1.2 1.2 0 0 1 1.2-1.2h2.9l4.4-3.92a.9.9 0 0 1 .55-.23Z"/>'
    + '<path stroke-width="1.9" d="M16.4 9.2a4 4 0 0 1 0 5.6M19.1 6.6a8 8 0 0 1 0 10.8"/>',
  'phone-fill': '<path fill="currentColor" stroke="none" d="M7.6 2.9c.85-.42 1.88-.1 2.35.72l1.55 2.7c.45.79.22 1.79-.53 2.3l-1.2.83a10.9 10.9 0 0 0 4.05 4.05l.83-1.2c.51-.75 1.51-.98 2.3-.53l2.7 1.55c.82.47 1.14 1.5.72 2.35l-.93 1.87c-.4.8-1.26 1.26-2.14 1.14C10.6 18.5 5.5 13.4 4.6 5.97c-.12-.88.34-1.74 1.14-2.14l1.86-.93Z"/>',
  'mic-round-fill': MIC_BODY,
};
F['phone-down-fill'] = F['phone-fill'];

export function icon(name, size = 20, cls = '') {
  const attrs = `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ''}`;
  if (F[name]) return `<svg ${attrs}>${F[name]}</svg>`;
  const d = P[name] || P.info;
  return `<svg ${attrs}>${d.split('M').filter(Boolean).map(seg => `<path d="M${seg.trim()}"/>`).join('')}</svg>`;
}
export function paintIcons(root = document) {
  $$('.ico', root).forEach(el => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    // 'ico' itself is dropped (it is a 20px placeholder box, wrong for the
    // real icon), every other class is carried over to the <svg>.
    const keep = [...el.classList].filter(c => c !== 'ico').join(' ');
    el.outerHTML = icon(el.textContent.trim(), Number(el.dataset.size) || 20, keep);
  });
}
export const iconEl = (name, size) => {
  const s = h('span'); s.innerHTML = icon(name, size); return s.firstChild;
};
/* Re-draws the glyph inside a live button (mute / camera toggles) without
   touching the button, its classes or its handlers. */
export function swapIcon(host, name, size = 20) {
  const cur = host.querySelector('svg, .ico');
  if (!cur) return;
  const keep = cur.tagName === 'svg'
    ? (cur.getAttribute('class') || '')
    : [...cur.classList].filter(c => c !== 'ico').join(' ');
  const box = h('span');
  box.innerHTML = icon(name, size, keep);
  cur.replaceWith(box.firstChild);
}

/* ── shared nav-tab state (keeps the sliding glass indicator in sync
   with whichever code path switches the active tab) ────────────────── */
export function setActiveNav(name) {
  const nav = $('.rail-nav');
  $$('.rail-nav .rail-btn[data-nav]').forEach((b, i) => {
    const on = b.dataset.nav === name;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
    if (on) nav?.style.setProperty('--rail-i', String(i));
  });
}

/* ── time ──────────────────────────────────────────── */
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay  = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const clock = d => fmtTime.format(new Date(d));
export function dayLabel(d) {
  const x = new Date(d), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(x.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return fmtDay.format(x);
}
export function shortWhen(d) {
  if (!d) return '';
  const x = new Date(d), now = new Date();
  if (x.toDateString() === now.toDateString()) return clock(x);
  const days = Math.round((new Date(now.toDateString()) - new Date(x.toDateString())) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(x);
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(x);
}
export function lastSeenText(p) {
  if (p?.is_online) return 'online';
  if (!p?.last_seen) return '';
  const mins = Math.floor((Date.now() - new Date(p.last_seen)) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  return `last seen ${shortWhen(p.last_seen)}`;
}
export const dur = s => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/* ── feedback ────────────────────────────────────── */
export function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, bad ? 4200 : 2400);
}
// A handful of Postgres/PostgREST errors are common enough, and ugly enough
// raw, that they're worth translating. oops() is the shared catch-all handler
// (calls, reactions, group edits, message sends all funnel through it), so
// this has to stay generic rather than assuming "send" specifically.
// 42501 is Postgres's SQLSTATE for "row rejected by an RLS policy" — the
// with-check clauses involved (can_send/is_admin/etc.) don't tell us which
// sub-condition failed, so the copy stays honest about the real possible
// causes instead of guessing one. In practice the most common trigger is a
// stale auth session (e.g. the tab sat backgrounded long enough that the
// access token wasn't refreshed in time) — composer.js already retries a
// failed send once after a session refresh before this message can even
// show, so by the time someone sees this it's usually genuinely a
// permission issue, not just a token that needed refreshing.
// URIError comes from decodeURIComponent() on a link that lost a percent
// escape somewhere between being shared and being tapped (chat apps and
// link shorteners do mangle them); "URI malformed" on its own tells the
// person nothing about what to do next.
// NotAllowedError is what getUserMedia/getDisplayMedia throw when the person
// dismissed the browser prompt, and NotFoundError when there is no such
// device — both used to surface as bare DOMException text.
// Anything we haven't special-cased still falls through to the raw message,
// so new/unexpected errors are never hidden.
function friendlyMessage(e) {
  if (e?.code === '42501') return "That didn't go through — you may be blocked, have left this chat, or it needs admin rights. If that's not it, try signing out and back in.";
  if (e instanceof URIError || /URI malformed|Provided URL is malformed/i.test(e?.message || '')) {
    return 'That link looks damaged — ask for it again, or paste it in full rather than tapping a preview.';
  }
  if (e?.name === 'NotAllowedError') return 'Permission was not given, so nothing started. You can allow it and try again.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No usable microphone or camera was found on this device.';
  if (e?.name === 'NotReadableError') return 'Another app is holding the camera or microphone. Close it and try again.';
  return e?.message || String(e);
}
export const oops = e => { console.error(e); toast(friendlyMessage(e), true); };

/* Clipboard, with the fallbacks the async API needs on mobile: it is absent
   on older WebKit and rejects outright inside some in-app browsers, and a
   bare navigator.clipboard.writeText() there throws where nobody catches it,
   so "Copy" silently did nothing. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); toast('Copied'); return true; }
  } catch { /* fall through */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', top: '0', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast('Copied'); return true; }
  } catch { /* fall through */ }
  toast('Could not copy automatically — press and hold the link to copy it.', true);
  return false;
}
export async function shareLink(url, title = 'Wisp') {
  try {
    if (navigator.share) { await navigator.share({ title, url }); return true; }
  } catch (e) {
    if (e?.name === 'AbortError') return false;   // person closed the share sheet
  }
  return copyText(url);
}

export function modal(...nodes) {
  const dlg = $('#modal'), body = clear($('#modal-body'));
  body.append(...nodes);
  dlg.showModal();
  paintIcons(body);
  return dlg;
}
export const closeModal = () => $('#modal').close();
export function confirmBox(title, note, okLabel = 'Confirm') {
  return new Promise(res => {
    modal(
      h('h3', { class: 'display', text: title }),
      note && h('p', { class: 'muted', text: note }),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(false); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); res(true); } }, okLabel)));
  });
}
export function promptBox(title, { label = '', value = '', type = 'text', note = '' } = {}) {
  return new Promise(res => {
    const input = h('input', { type, value });
    modal(
      h('h3', { class: 'display', text: title }),
      note && h('p', { class: 'hint', text: note }),
      h('label', {}, label, input),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); res(input.value); } }, 'Save')));
    input.focus();
  });
}

/* ── context menu ─────────────────────────────────────────────────────────
   What long-pressing a chat used to open was the same 560px-wide dialog used
   for forms — centred, tall, and nowhere near the thumb that summoned it.
   This is a real context menu instead: a compact card that appears at the
   press, aligned to whichever side of the screen the press came from, with a
   scrim you can tap anywhere to back out. Touch devices also get an explicit
   Cancel row, because "tap outside" is not discoverable on a phone.

   items: [{ label, icon, trail, danger, on, onclick } | { sep: true }] */
let openPop = null;

export function closePop() {
  const s = openPop;
  openPop = null;
  if (!s) return;
  s.classList.remove('is-open');
  setTimeout(() => s.remove(), 170);
}

export function popMenu(items, opts = {}) {
  closePop();
  const scrim = h('div', { class: 'pop-scrim' });
  const menu = h('div', { class: 'pop-menu', role: 'menu' });
  if (opts.title) menu.append(h('div', { class: 'pop-title', text: opts.title }));
  items.flat(3).filter(Boolean).forEach(it => {
    if (it.sep) { menu.append(h('div', { class: 'pop-sep' })); return; }
    const b = h('button', {
      class: 'pop-item' + (it.danger ? ' danger' : '') + (it.on ? ' is-on' : ''),
      role: 'menuitem', type: 'button',
      onclick: async e => {
        e.stopPropagation();
        closePop();
        try { await it.onclick?.(); } catch (err) { oops(err); }
      },
    });
    b.append(it.icon ? iconEl(it.icon, 17) : h('span', { class: 'pop-gap' }));
    b.append(h('span', { class: 'pop-label', text: it.label }));
    if (it.trail) b.append(h('small', { text: it.trail }));
    menu.append(b);
  });
  if (matchMedia('(hover: none)').matches) {
    menu.append(h('div', { class: 'pop-sep' }),
      h('button', { class: 'pop-item pop-cancel', type: 'button', onclick: closePop },
        h('span', { class: 'pop-label', text: 'Cancel' })));
  }
  scrim.append(menu);
  document.body.append(scrim);
  placePop(menu, opts);
  openPop = scrim;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
  scrim.addEventListener('pointerdown', e => { if (e.target === scrim) closePop(); });
  return scrim;
}

function placePop(menu, { x, y, anchor }) {
  const pad = 12;
  const r = anchor?.getBoundingClientRect?.();
  const px = x ?? (r ? r.right : innerWidth / 2);
  const py = y ?? (r ? r.bottom + 6 : innerHeight / 2);
  const w = menu.offsetWidth, mh = menu.offsetHeight;
  // A press past the middle of the screen opens leftwards from the finger, so
  // the card never runs off the edge and never hides what was pressed.
  let left = px > innerWidth / 2 ? px - w : px;
  left = Math.min(Math.max(pad, left), Math.max(pad, innerWidth - w - pad));
  let top = py + 4;
  if (top + mh > innerHeight - pad) top = py - mh - 4;
  top = Math.min(Math.max(pad, top), Math.max(pad, innerHeight - mh - pad));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.transformOrigin = `${Math.round(px - left)}px ${Math.round(py - top)}px`;
}

/* Long-press that survives a scrolling list: a finger that travels more than
   10px is scrolling, not pressing, so the timer is dropped. Returns nothing —
   read el.dataset.pressed in your click handler to swallow the tap that would
   otherwise follow the menu opening. */
export function longPress(el, fn, ms = 460) {
  let timer = null, sx = 0, sy = 0;
  const stop = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    sx = e.clientX; sy = e.clientY;
    stop();
    timer = setTimeout(() => {
      timer = null;
      el.dataset.pressed = '1';
      try { navigator.vibrate?.(12); } catch { /* not everywhere */ }
      fn({ x: sx, y: sy });
    }, ms);
  }, { passive: true });
  el.addEventListener('pointermove', e => {
    if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) stop();
  }, { passive: true });
  el.addEventListener('pointerup', stop, { passive: true });
  el.addEventListener('pointercancel', stop, { passive: true });
}

addEventListener('keydown', e => {
  if (e.key === 'Escape' && openPop) { e.stopPropagation(); closePop(); }
}, true);

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
export const uuid = () => crypto.randomUUID();
export const linkify = txt => esc(txt).replace(/(https?:\/\/[^\s<]+)/g,
  u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
  .replace(/(^|\s)@([\w]+)/g, '$1<b>@$2</b>');
export const firstUrl = txt => (txt || '').match(/https?:\/\/[^\s]+/)?.[0] || null;

export const avatarData = name => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="64" fill="#d9d2c7"/><text x="64" y="80" font-family="sans-serif" font-size="48" fill="#4a4438" text-anchor="middle">${initials(name)}</text></svg>`);
