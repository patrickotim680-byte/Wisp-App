// DOM + formatting helpers, icons, toasts, modals.

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

/* ── icons (inline SVG, no icon font, no network) ─────────────────────── */
const P = {
  chat: 'M4 5h16v10H8l-4 4V5z', people: 'M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 19c0-3 3-5 6-5s6 2 6 5M14.5 14.2c2.6.3 5.5 2 5.5 4.8',
  call: 'M6 3h3l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v3a2 2 0 01-2 2A16 16 0 014 6a2 2 0 012-3z',
  video: 'M3 6h11v12H3zM14 10l7-4v12l-7-4z', star: 'M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l4 2', moon: 'M20 14A8 8 0 1110 4a7 7 0 1010 10z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 .8-2-1.2L14.6 4h-5l-.4 2.6-2 1.2L5 7 3 11l2 1-2 1 2 4 2-.8 2 1.2.4 2.6h5l.4-2.6 2-1.2 2 .8 2-4z',
  plus: 'M12 5v14M5 12h14', 'group-add': 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 19c0-3 3-5 6-5s6 2 6 5M18 8v6M15 11h6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5', spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.5', back: 'M15 5l-7 7 7 7',
  clip: 'M8 12l6-6a3 3 0 014 4l-8 8a5 5 0 01-7-7l8-8', smile: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9 10v.5M15 10v.5M8.5 14a5 5 0 007 0',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM6 12a6 6 0 0012 0M12 18v3',
  send: 'M4 12l16-8-6 8 6 8z', hangup: 'M4 15l4-2v-2a9 9 0 018 0v2l4 2v3a2 2 0 01-2 2H6a2 2 0 01-2-2zM3 3l18 18',
  screen: 'M3 5h18v11H3zM9 20h6', reply: 'M9 7L4 12l5 5M4 12h9a5 5 0 015 5v2',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13', pin: 'M12 3v9M8 12h8l-4 9z', dots: 'M12 7v.5M12 12v.5M12 17v.5',
  check: 'M5 12l5 5L20 6', x: 'M6 6l12 12M18 6L6 18', fwd: 'M15 7l5 5-5 5M20 12H8a4 4 0 00-4 4v2',
  edit: 'M4 20h4L20 8l-4-4L4 16z', file: 'M6 3h8l4 4v14H6zM14 3v4h4', lock: 'M6 11h12v10H6zM9 11V8a3 3 0 016 0v3',
  down: 'M12 5v14M6 13l6 6 6-6', bookmark: 'M6 4h12v17l-6-4-6 4z', copy: 'M8 8h12v12H8zM4 16V4h12',
  play: 'M7 4l12 8-12 8z', pause: 'M8 5h3v14H8zM13 5h3v14h-3z', globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  'eye-off': 'M3 3l18 18M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M6.61 6.61A18.45 18.45 0 001 12s4 8 11 8a10.94 10.94 0 005.39-1.39',
};
export function icon(name, size = 20) {
  const d = P[name] || P.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    d.split('M').filter(Boolean).map(seg => `<path d="M${seg.trim()}"/>`).join('')}</svg>`;
}
export function paintIcons(root = document) {
  $$('.ico', root).forEach(el => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    el.outerHTML = icon(el.textContent.trim());
  });
}
export const iconEl = (name, size) => {
  const s = h('span'); s.innerHTML = icon(name, size); return s.firstChild;
};

/* ── shared nav-tab state (keeps the sliding glass indicator in sync
   with whichever code path switches the active tab) ────────────────── */
export function setActiveNav(name) {
  const nav = $('.rail-nav');
  $$('.rail-nav .rail-btn[data-nav]').forEach((b, i) => {
    const on = b.dataset.nav === name;
    b.classList.toggle('is-on', on);
    if (on) nav?.style.setProperty('--rail-i', String(i));
  });
}

/* ── time ─────────────────────────────────────────────────────────────── */
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

/* ── feedback ─────────────────────────────────────────────────────────── */
export function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, bad ? 4200 : 2400);
}
export const oops = e => { console.error(e); toast(e?.message || String(e), true); };

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
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
export const uuid = () => crypto.randomUUID();
export const linkify = txt => esc(txt).replace(/(https?:\/\/[^\s<]+)/g,
  u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
  .replace(/(^|\s)@([\w]+)/g, '$1<b>@$2</b>');
export const firstUrl = txt => (txt || '').match(/https?:\/\/[^\s]+/)?.[0] || null;
