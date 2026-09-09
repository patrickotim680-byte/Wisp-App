// DOM + formatting helpers, icons, toasts, modals, action sheets.

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

/* ── icons (inline SVG, no icon font, no network) ───────────────────────
   One family, one 24px grid, one 1.7 stroke. Glyphs are composed from two
   generators — circle() and rrect() — plus straight segments, so every arc
   is mathematically correct rather than hand-fitted: that unevenness is
   what made the old set look cheap next to the call controls. The table is
   deliberately large, because the alternative to a missing glyph was an
   emoji, and emoji render differently on every platform and ignore the
   accent, the theme and the text scale.

   icon() splits an entry on "M", so a glyph is simply a list of subpaths.
   Filled artwork (the call controls) lives in F below instead. */
const circle = (cx, cy, r) =>
  `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
const rrect = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}` +
  `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}` +
  `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

/* A slash drawn across a glyph to negate it (muted, blocked, camera off). */
const SLASH = 'M4.4 19.6 19.6 4.4';
const HANDSET = 'M6.4 3.4h2.9l1.8 4.4-2.2 1.5a11.4 11.4 0 0 0 5.3 5.3l1.5-2.2 4.4 1.8v2.9'
  + 'a2 2 0 0 1-2.2 2C11.4 18.4 5.6 12.6 4.4 5.6a2 2 0 0 1 2-2.2Z';
/* Smaller handset, so the call-history glyphs have room for a direction
   arrow in the top-right corner without the two shapes colliding. */
const HANDSET_SM = 'M5.4 4.2h2.3l1.4 3.5-1.8 1.2a9.2 9.2 0 0 0 4.2 4.2l1.2-1.8 3.5 1.4v2.3'
  + 'a1.7 1.7 0 0 1-1.9 1.7C9.2 15.9 4.5 11.2 3.7 5.9a1.7 1.7 0 0 1 1.7-1.7Z';
const BELL = 'M6.4 16.4V11a5.6 5.6 0 0 1 11.2 0v5.4l1.8 2.6H4.6Z'
  + 'M10.1 19.4a2 2 0 0 0 3.8 0';
const ARCHIVE_BOX = rrect(3.4, 4.4, 17.2, 4, 1.4)
  + 'M5.4 8.4V18.6A1.8 1.8 0 0 0 7.2 20.4h9.6a1.8 1.8 0 0 0 1.8-1.8V8.4';
const PIN = 'M9.4 3.6h5.2l-.7 5.2 2.7 2.4V12.4H7.4V11.2l2.7-2.4Z' + 'M12 12.4V20.4';
const MIC = 'M12 15.2a3.1 3.1 0 0 0 3.1-3.1V6.6a3.1 3.1 0 0 0-6.2 0v5.5a3.1 3.1 0 0 0 3.1 3.1Z'
  + 'M6.4 11.6a5.6 5.6 0 0 0 11.2 0' + 'M12 17.6V20.6M9.2 20.6h5.6';
const FILE_BODY = 'M6.6 3.6h7L18.4 8.4V20.4H6.6Z' + 'M13.4 3.6V8.6H18.4';
const FOLDER = 'M3.6 7.4a2 2 0 0 1 2-2h3.2l2 2.4h7.6a2 2 0 0 1 2 2V18.4a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2Z';
const SHIELD = 'M12 3.4 19.4 6v5.6c0 4.4-3.1 7.7-7.4 9.1-4.3-1.4-7.4-4.7-7.4-9.1V6Z';
const LOCK_BODY = rrect(5, 10.6, 14, 9.8, 2.4);

const P = {
  /* chrome + navigation */
  chat: 'M20.5 13.2A2.8 2.8 0 0 1 17.7 16H9.6L5 19.6V6.8A2.8 2.8 0 0 1 7.8 4H17.7A2.8 2.8 0 0 1 20.5 6.8Z',
  people: circle(9.2, 8.4, 3.2)
    + 'M3.6 19.6C3.6 16.4 6.1 14.2 9.2 14.2s5.6 2.2 5.6 5.4'
    + 'M16.4 5.6a3.2 3.2 0 0 1 0 5.6'
    + 'M17.6 14.4c2 .5 3.4 2.3 3.4 4.5',
  user: circle(12, 8, 3.6) + 'M5 20.4c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6',
  'group-add': circle(9.4, 8.2, 3.2)
    + 'M3.8 19.4c0-3.2 2.5-5.4 5.6-5.4 1.3 0 2.5.4 3.5 1'
    + 'M18.2 13.6V19M15.5 16.3H21',
  sliders: 'M4 7.8h9.4M18.6 7.8H20M4 16.2h1.4M10.8 16.2H20'
    + circle(16, 7.8, 2.6) + circle(8.2, 16.2, 2.6),
  search: circle(10.8, 10.8, 6.8) + 'M15.7 15.7 20.8 20.8',
  plus: 'M12 5.2V18.8M5.2 12H18.8',
  minus: 'M5.2 12H18.8',
  back: 'M14.6 5.4 8 12 14.6 18.6',
  'chevron-right': 'M9.4 5.4 16 12 9.4 18.6',
  'chevron-down': 'M5.4 9.4 12 16 18.6 9.4',
  x: 'M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8',
  check: 'M4.8 12.4 9.6 17.2 19.2 6.8',
  'check-double': 'M2.6 12.6 6.4 16.4 13 9.4' + 'M11 16.4 12.4 17.8 21.4 8.6',
  dots: 'M12 6v.2M12 12v.2M12 18v.2',
  'dots-h': 'M6 12v.2M12 12v.2M18 12v.2',
  info: circle(12, 12, 8.6) + 'M12 11.2V16.6M12 7.6v.2',
  alert: 'M12 4.2 21 19.8H3Z' + 'M12 9.8v4.4M12 17v.2',
  refresh: 'M20.2 12a8.2 8.2 0 1 1-2.4-5.8' + 'M20.8 4.2V9H16',
  spark: 'M12 3.2 13.8 9 19.6 10.8 13.8 12.6 12 18.4 10.2 12.6 4.4 10.8 10.2 9Z'
    + 'M18.6 15.4 19.2 17.2 21 17.8 19.2 18.4 18.6 20.2 18 18.4 16.2 17.8 18 17.2Z',
  bolt: 'M13.6 3.4 5.6 13.6h5.2l-.6 7 8.2-10.2h-5.4Z',

  /* calls */
  call: HANDSET,
  'phone-off': HANDSET + SLASH,
  'phone-out': HANDSET_SM + 'M16.8 8.4 21.6 3.6M17.4 3.6h4.2v4.2',
  'phone-in': HANDSET_SM + 'M21.6 3.6 16.8 8.4M21 8.4h-4.2V4.2',
  'phone-missed': HANDSET_SM + 'M16.4 3.6 21.6 8.8M21.6 3.6 16.4 8.8',
  video: rrect(3, 7, 11.6, 10, 2.4) + 'M14.6 11.4 21.4 8.1V15.9L14.6 12.6Z',
  screen: rrect(3, 5, 18, 11, 2.4) + 'M9.4 19.8h5.2',
  speaker: 'M4.4 9.2v5.6h2.8l4.8 3.8V5.4L7.2 9.2Z'
    + 'M15 9.4a3.4 3.4 0 0 1 0 5.2' + 'M17.8 6.6a7.4 7.4 0 0 1 0 10.8',
  wave: 'M4.4 10v4M8.2 6.4v11.2M12 3.6v16.8M15.8 6.4v11.2M19.6 10v4',
  headphones: 'M4.6 15.6V12.8a7.4 7.4 0 0 1 14.8 0v2.8'
    + rrect(2.8, 14.4, 4, 6, 1.8) + rrect(17.2, 14.4, 4, 6, 1.8),

  /* composer + messages */
  clip: 'M8.4 11.9 14 6.3a3.1 3.1 0 0 1 4.4 4.4l-8.2 8.2a5 5 0 0 1-7.1-7.1l8-8',
  smile: circle(12, 12, 8.6) + 'M9.2 10v.2M14.8 10v.2M8.4 14a4.8 4.8 0 0 0 7.2 0',
  mic: MIC,
  'mic-off': MIC + SLASH,
  send: 'M21 3.4 3.6 10.8 10.6 13.4 13.2 20.6Z' + 'M21 3.4 10.6 13.4',
  reply: 'M9.6 7.2 4.8 12 9.6 16.8' + 'M4.8 12h8.6a5.4 5.4 0 0 1 5.4 5.4v1.4',
  fwd: 'M14.4 7.2 19.2 12 14.4 16.8' + 'M19.2 12h-8.6A5.4 5.4 0 0 0 5.2 17.4v1.4',
  edit: 'M4 20.4h4.2L20.4 8.2a1.9 1.9 0 0 0 0-2.7l-1.5-1.5a1.9 1.9 0 0 0-2.7 0L4 16.2Z'
    + 'M15.6 5.8 18.8 9',
  trash: 'M4.6 7.4h14.8'
    + 'M9.4 7.4V5.6A1.4 1.4 0 0 1 10.8 4.2h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8'
    + 'M6.6 7.4 7.5 19a1.6 1.6 0 0 0 1.6 1.5h5.8A1.6 1.6 0 0 0 16.5 19l.9-11.6'
    + 'M10.4 11.2v5.4M13.6 11.2v5.4',
  eraser: 'M9 20.4H20.4'
    + 'M16.6 4.6 19.4 7.4a1.6 1.6 0 0 1 0 2.3l-9.5 9.5a1.6 1.6 0 0 1-2.3 0L4.6 16.4'
    + 'a1.6 1.6 0 0 1 0-2.3l9.7-9.5a1.6 1.6 0 0 1 2.3 0Z',
  copy: rrect(8.6, 8.6, 11.8, 11.8, 2.4)
    + 'M15.4 5.6a2 2 0 0 0-2-2H5.6a2 2 0 0 0-2 2v7.8a2 2 0 0 0 2 2',
  star: 'M12 3.6 14.62 8.94 20.5 9.8 16.25 13.95 17.25 19.8 12 17.05 6.75 19.8 7.75 13.95 3.5 9.8 9.38 8.94Z',
  bookmark: 'M6.6 3.8h10.8V20.2L12 16.6 6.6 20.2Z',
  pin: PIN,
  'pin-off': PIN + SLASH,
  hourglass: 'M7 3.6h10M7 20.4h10' + 'M8 3.6v3.2L12 11 16 6.8V3.6' + 'M8 20.4v-3.2L12 13l4 4.2v3.2',
  translate: 'M4.4 6.6h8.2M8.5 4.6v2M10.8 6.6c0 4.2-2.7 7.8-6.4 9.2M6 10.8c1 2.4 3 4.2 5.6 5'
    + 'M12.4 20.4 16.6 9.6 20.8 20.4M13.9 17h5.4',
  at: circle(12, 12, 3.6) + 'M15.6 12v2.4a2.4 2.4 0 0 0 4.8 0V12A8.4 8.4 0 1 0 15 19.6',
  heart: 'M12 20.4S3.8 15.6 3.8 10.2A4.4 4.4 0 0 1 12 7.6 4.4 4.4 0 0 1 20.2 10.2C20.2 15.6 12 20.4 12 20.4Z',

  /* attachments + content kinds */
  image: rrect(3.4, 4.4, 17.2, 15.2, 2.6) + circle(9, 9.4, 1.7)
    + 'M4.4 17.6 9.8 12.8 13.2 15.8 15.8 13.6 19.6 17.2',
  camera: 'M4.8 8.8h2.4l1.6-2.2h6.4l1.6 2.2h2.4a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8'
    + 'H4.8A1.8 1.8 0 0 1 3 18v-7.4a1.8 1.8 0 0 1 1.8-1.8Z' + circle(12, 14.2, 3.2),
  film: rrect(3, 4.6, 18, 14.8, 2.4) + 'M3 9.4h18M3 14.6h18M8 4.6V19.4M16 4.6V19.4',
  music: circle(6.8, 17.4, 2.6) + circle(17.2, 15.4, 2.6) + 'M9.4 17.4V6.6L19.8 4.4V15.4',
  file: FILE_BODY,
  doc: FILE_BODY + 'M9.4 13h5.2M9.4 16.4h4',
  'map-pin': 'M12 21.2s6.6-6.2 6.6-10.4a6.6 6.6 0 0 0-13.2 0C5.4 15 12 21.2 12 21.2Z'
    + circle(12, 10.6, 2.4),
  contact: rrect(2.8, 5, 18.4, 14, 2.6) + circle(8.6, 10.4, 2.2)
    + 'M5.2 16.4c0-1.9 1.5-3.1 3.4-3.1s3.4 1.2 3.4 3.1' + 'M14.8 10h4.2M14.8 13.6h4.2',
  poll: 'M3.6 19.6h16.8' + 'M6.4 19.6V10.6M12 19.6V4.6M17.6 19.6V13.4',
  sticker: 'M20.4 13.6 13.6 20.4H7.4a3 3 0 0 1-3-3V6.6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z'
    + 'M13.6 20.4v-4a2.8 2.8 0 0 1 2.8-2.8h4',
  grid: rrect(3.6, 3.6, 7, 7, 1.6) + rrect(13.4, 3.6, 7, 7, 1.6)
    + rrect(3.6, 13.4, 7, 7, 1.6) + rrect(13.4, 13.4, 7, 7, 1.6),
  play: 'M7.8 4.8 19.2 12 7.8 19.2Z',
  pause: 'M9.2 5.4V18.6M14.8 5.4V18.6',
  down: 'M12 4.4V16M7.2 11.2 12 16 16.8 11.2' + 'M5 20h14',
  upload: 'M12 16V4.4M7.2 9.2 12 4.4 16.8 9.2' + 'M5 20h14',
  share: 'M12 15.6V4.2M8.2 8 12 4.2 15.8 8'
    + 'M5.6 13.4v5a2 2 0 0 0 2 2h8.8a2 2 0 0 0 2-2v-5',
  link: 'M9.6 14.4 14.4 9.6'
    + 'M11.4 7.2 13 5.6a3.8 3.8 0 0 1 5.4 5.4l-1.6 1.6'
    + 'M12.6 16.8 11 18.4a3.8 3.8 0 0 1-5.4-5.4l1.6-1.6',

  /* organization */
  bell: BELL,
  'bell-off': BELL + SLASH,
  archive: ARCHIVE_BOX + 'M10 12.4h4',
  unarchive: ARCHIVE_BOX + 'M12 17.6V11.8M9.6 14.2 12 11.8 14.4 14.2',
  folder: FOLDER,
  'folder-plus': FOLDER + 'M12 11.8v5.2M9.4 14.4h5.2',
  clock: circle(12, 12, 8.6) + 'M12 7.2V12.4L15.8 14.6',

  /* appearance */
  palette: 'M12 3.4a8.6 8.6 0 0 0 0 17.2 2.2 2.2 0 0 0 2.2-2.2 2.2 2.2 0 0 1 2.2-2.2h2.2'
    + 'a2.2 2.2 0 0 0 2.2-2.2A8.6 8.6 0 0 0 12 3.4Z'
    + circle(8.6, 9.6, 1) + circle(12, 7.8, 1) + circle(15.4, 9.6, 1),
  sun: circle(12, 12, 4.2)
    + 'M12 2.6V4.8M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4 7 7M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6',
  moon: 'M20.4 14.8A8.8 8.8 0 0 1 9.2 3.6 8.8 8.8 0 1 0 20.4 14.8Z',
  type: 'M5.4 8.2V6.4h13.2v1.8' + 'M12 6.4V19.6M9.2 19.6h5.6',
  'text-size': 'M3.2 9V6.6h9.2V9' + 'M7.8 6.6V19.6M5.6 19.6h4.4'
    + 'M14 13.6v-1.8h6.8v1.8' + 'M17.4 11.8V19.6M15.6 19.6h3.6',

  /* privacy + account */
  lock: LOCK_BODY + 'M8.4 10.6V8A3.6 3.6 0 0 1 15.6 8v2.6',
  unlock: LOCK_BODY + 'M8.4 10.6V8a3.6 3.6 0 0 1 6.9-1.4',
  key: circle(8.4, 15.6, 3.6) + 'M11 13 20 4M17.2 6.8 19.4 9M14.6 9.4 16.8 11.6',
  shield: SHIELD,
  'shield-lock': SHIELD + circle(12, 11.4, 1.6) + 'M12 13V15.4',
  ban: circle(12, 12, 8.6) + 'M6.2 17.8 17.8 6.2',
  flag: 'M6.2 20.4V4.4' + 'M6.2 4.4h11l-1.7 3.7 1.7 3.7h-11',
  'log-out': 'M15.4 8.2V5.6a1.8 1.8 0 0 0-1.8-1.8H6.4a1.8 1.8 0 0 0-1.8 1.8v12.8'
    + 'a1.8 1.8 0 0 0 1.8 1.8h7.2a1.8 1.8 0 0 0 1.8-1.8V15.8'
    + 'M11 12h9.4M17.4 8.6 20.8 12 17.4 15.4',
  database: 'M12 3.6c4.6 0 8.2 1.2 8.2 2.8S16.6 9.2 12 9.2 3.8 8 3.8 6.4 7.4 3.6 12 3.6Z'
    + 'M3.8 6.4V17.6c0 1.6 3.6 2.8 8.2 2.8s8.2-1.2 8.2-2.8V6.4'
    + 'M3.8 12c0 1.6 3.6 2.8 8.2 2.8s8.2-1.2 8.2-2.8',
  globe: circle(12, 12, 8.6) + 'M3.4 12H20.6'
    + 'M12 3.4C14.7 6.2 14.7 17.8 12 20.6 9.3 17.8 9.3 6.2 12 3.4Z',
  eye: 'M1.6 12S5.4 4.6 12 4.6 22.4 12 22.4 12 18.6 19.4 12 19.4 1.6 12 1.6 12Z'
    + circle(12, 12, 3),
  'eye-off': 'M3 3 21 21'
    + 'M9.9 4.9A9.4 9.4 0 0 1 12 4.6c6.6 0 10.4 7.4 10.4 7.4a19 19 0 0 1-2.4 3.4'
    + 'M14.1 14.1a3 3 0 0 1-4.2-4.2'
    + 'M6.5 6.5A18.6 18.6 0 0 0 1.6 12S5.4 19.4 12 19.4a10.6 10.6 0 0 0 5.2-1.3',
};

/* Aliases: one drawing, several names, so call sites can read naturally. */
P.gear = P.sliders; P.users = P.people; P.monitor = P.screen; P.wallpaper = P.image;
P.download = P.down; P.emoji = P.smile; P.more = P.dots; P.mute = P['bell-off'];
P.unmute = P.bell; P.block = P.ban; P.report = P.flag; P.display = P.palette;
P.voice = P.mic; P.document = P.doc; P.location = P['map-pin']; P.settings = P.sliders;
P.media = P.grid; P.forward = P.fwd; P.close = P.x; P.cancel = P.x;

/* Filled artwork for the call controls (unchanged): a solid mic capsule over
   a stroked cradle, a display with an upward arrow, a speaker with two waves,
   a camcorder body plus lens wedge, and a solid handset (the hang-up button
   rotates it in CSS).

   The two "slashed" variants draw the diagonal twice: once fat in
   var(--glyph-cut) — the button's own background, set in call.css — so the
   line carves a visible gap through the glyph, then again thin in
   currentColor as the slash itself. */
const MIC_BODY = '<path fill="currentColor" stroke="none" d="M12 2.6a3.3 3.3 0 0 1 3.3 3.3v5.9a3.3 3.3 0 0 1-6.6 0V5.9A3.3 3.3 0 0 1 12 2.6Z"/>'
  + '<path stroke-width="2" d="M5.5 11.3a6.5 6.5 0 0 0 13 0M12 18v3.2"/>';
const CAM_BODY = '<path fill="currentColor" stroke="none" d="M4.1 6.4h8.5a2.3 2.3 0 0 1 2.3 2.3v6.6a2.3 2.3 0 0 1-2.3 2.3H4.1a2.3 2.3 0 0 1-2.3-2.3V8.7a2.3 2.3 0 0 1 2.3-2.3Z"/>'
  + '<path fill="currentColor" stroke="none" d="M16.4 10.9 21 8.05a.75.75 0 0 1 1.15.64v6.62a.75.75 0 0 1-1.15.64L16.4 13.1Z"/>';
const SLASH_FILL = '<path stroke="var(--glyph-cut, #3f3f3f)" stroke-width="3.6" d="M3.9 20.6 20.1 3.6"/>'
  + '<path stroke-width="2" d="M3.9 20.6 20.1 3.6"/>';

const F = {
  'mic-fill': MIC_BODY,
  'mic-off-fill': MIC_BODY + SLASH_FILL,
  'video-fill': CAM_BODY,
  'video-off-fill': CAM_BODY + SLASH_FILL,
  'screen-fill': '<rect x="2.7" y="4.9" width="18.6" height="13.1" rx="3.2" stroke-width="1.9"/>'
    + '<path fill="currentColor" stroke="none" d="M12 7.9l3.6 3.8h-2.45v3.9h-2.3v-3.9H8.4L12 7.9Z"/>',
  'speaker-fill': '<path fill="currentColor" stroke="none" d="M12.05 3.5a.9.9 0 0 1 .95.9v15.2a.9.9 0 0 1-1.5.67L7.1 16.35H4.2A1.2 1.2 0 0 1 3 15.15V8.85a1.2 1.2 0 0 1 1.2-1.2h2.9l4.4-3.92a.9.9 0 0 1 .55-.23Z"/>'
    + '<path stroke-width="1.9" d="M16.4 9.2a4 4 0 0 1 0 5.6M19.1 6.6a8 8 0 0 1 0 10.8"/>',
  'phone-fill': '<path fill="currentColor" stroke="none" d="M7.6 2.9c.85-.42 1.88-.1 2.35.72l1.55 2.7c.45.79.22 1.79-.53 2.3l-1.2.83a10.9 10.9 0 0 0 4.05 4.05l.83-1.2c.51-.75 1.51-.98 2.3-.53l2.7 1.55c.82.47 1.14 1.5.72 2.35l-.93 1.87c-.4.8-1.26 1.26-2.14 1.14C10.6 18.5 5.5 13.4 4.6 5.97c-.12-.88.34-1.74 1.14-2.14l1.86-.93Z"/>',
};
F['phone-down-fill'] = F['phone-fill'];

export function icon(name, size = 20, cls = '') {
  const attrs = `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ''}`;
  if (F[name]) return `<svg ${attrs}>${F[name]}</svg>`;
  const d = P[name] || P.info;
  return `<svg ${attrs}>${d.split('M').filter(Boolean).map(seg => `<path d="M${seg.trim()}"/>`).join('')}</svg>`;
}

/* Message kind -> glyph. Chat previews used emoji for these, which is the
   single most visible place the old UI looked unfinished. */
const KIND = {
  image: 'image', video: 'film', voice: 'mic', audio: 'music', document: 'doc',
  location: 'map-pin', contact: 'contact', poll: 'poll', call: 'call',
  sticker: 'sticker', system: 'info', text: 'chat',
};
export const kindIcon = kind => KIND[kind] || 'chat';
export const KIND_WORD = {
  image: 'Photo', video: 'Video', voice: 'Voice note', audio: 'Audio', document: 'Document',
  location: 'Location', contact: 'Contact', poll: 'Poll', call: 'Call', sticker: 'Sticker',
};

export function paintIcons(root = document) {
  $$('.ico', root).forEach(el => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    // 'ico' itself is dropped (a 20px placeholder box, wrong for the real
    // icon), every other class is carried over to the <svg>.
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
/* Small inline glyph for running text (chat previews, header subtitles). */
export const inlineIcon = (name, size = 14) => icon(name, size, 'in-ico');

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

/* ── time ──────────────────────────────────────────────────── */
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

/* ── feedback ─────────────────────────────────────────────── */
export function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, bad ? 4200 : 2400);
}
// A handful of Postgres/PostgREST errors are common enough, and ugly enough
// raw, that they're worth translating. oops() is the shared catch-all handler,
// so this stays generic rather than assuming "send" specifically.
// 42501 is Postgres's SQLSTATE for "row rejected by an RLS policy"; in
// practice the most common trigger is a stale auth session, which composer.js
// already retries once before this message can show.
// URIError comes from decodeURIComponent() on a link that lost a percent
// escape somewhere between being shared and being tapped.
function friendlyMessage(e) {
  if (e?.code === '42501') return "That didn't go through — you may be blocked, have left this chat, or it needs admin rights. If that's not it, try signing out and back in.";
  if (e instanceof URIError || /URI malformed|Provided URL is malformed/i.test(e?.message || '')) {
    return 'That link looks damaged — ask for it again, or paste it in full rather than tapping a preview.';
  }
  return e?.message || String(e);
}
export const oops = e => { console.error(e); toast(friendlyMessage(e), true); };

/* Clipboard, with the fallbacks the async API needs on mobile: it is absent
   on older WebKit and rejects outright inside some in-app browsers. */
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
  body.append(...nodes.flat(3).filter(Boolean));
  dlg.showModal();
  paintIcons(body);
  return dlg;
}
export const closeModal = () => $('#modal').close();
export function confirmBox(title, note, okLabel = 'Confirm') {
  return new Promise(res => {
    modal(
      h('h3', { class: 'display' }, title),
      note && h('p', { class: 'muted', text: note }),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(false); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); res(true); } }, okLabel)));
  });
}
export function promptBox(title, { label = '', value = '', type = 'text', note = '' } = {}) {
  return new Promise(res => {
    const input = h('input', { type, value });
    const done = () => { closeModal(); res(input.value); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && type !== 'textarea') { e.preventDefault(); done(); } });
    modal(
      h('h3', { class: 'display' }, title),
      note && h('p', { class: 'hint', text: note }),
      h('label', {}, label, input),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); res(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: done }, 'Save')));
    input.focus();
  });
}

/* ── action sheet ───────────────────────────────────────────────────────
   One shape for every menu in the app: icon, label, optional sub-label,
   optional trailing value. Previously each menu was an ad-hoc stack of
   plain buttons, which is why no two of them looked alike. Items may also
   carry { node } to drop an arbitrary control (a select, a switch) into the
   same list without breaking the rhythm. */
export function actionSheet(title, items, note) {
  const row = it => {
    const b = h('button', {
      class: 'sheet-row' + (it.danger ? ' danger' : '') + (it.on ? ' is-on' : ''),
      onclick: async () => {
        if (!it.keepOpen) closeModal();
        try { await it.onclick?.(); } catch (e) { oops(e); }
      },
    },
      h('span', { class: 'sheet-ico', html: icon(it.icon || 'dots', 19) }),
      h('span', { class: 'sheet-label' },
        h('b', {}, it.label),
        it.note && h('small', { class: 'hint' }, it.note)),
      it.trail && h('span', { class: 'sheet-trail' }, it.trail));
    return b;
  };
  return modal(
    h('h3', { class: 'display' }, title),
    note && h('p', { class: 'hint' }, note),
    h('div', { class: 'sheet-list' },
      items.flat(2).filter(Boolean).map(it => it.node ? it.node : row(it))),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

/* Long-press (touch) that does not fight scrolling: any movement or an
   early lift cancels it. The old inline version fired on a scroll gesture. */
export function longPress(el, fn, ms = 520) {
  let timer = null, sx = 0, sy = 0;
  const stop = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchstart', e => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
    stop();
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 9 || Math.abs(t.clientY - sy) > 9) stop();
  }, { passive: true });
  el.addEventListener('touchend', stop);
  el.addEventListener('touchcancel', stop);
  return el;
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
export const uuid = () => crypto.randomUUID();
export const linkify = txt => esc(txt).replace(/(https?:\/\/[^\s<]+)/g,
  u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
  .replace(/(^|\s)@([\w]+)/g, '$1<b>@$2</b>');
export const firstUrl = txt => (txt || '').match(/https?:\/\/[^\s]+/)?.[0] || null;
