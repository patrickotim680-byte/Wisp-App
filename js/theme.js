// Applies user_settings — and, when a chat is open, that chat's own overrides —
// to CSS custom properties. The DB rows stay the source of truth; localStorage
// holds nothing but a small per-chat cache so reopening a chat paints its own
// colour and wallpaper in the same frame as the tap instead of a beat later.
import { S, person } from './state.js';
import { upd, publicUrl } from './db.js';
import { $ } from './util.js';

export const ACCENTS = {
  blue:   { l: 0.55, c: 0.16, h: 250, label: 'Blue' },
  clay:   { l: 0.55, c: 0.13, h: 38,  label: 'Clay' },
  moss:   { l: 0.52, c: 0.10, h: 148, label: 'Moss' },
  indigo: { l: 0.50, c: 0.14, h: 274, label: 'Indigo' },
  plum:   { l: 0.48, c: 0.13, h: 336, label: 'Plum' },
  slate:  { l: 0.47, c: 0.05, h: 250, label: 'Slate' },
  ochre:  { l: 0.63, c: 0.13, h: 78,  label: 'Ochre' },
  // 0.53, not 0.55: white on teal measured 4.40:1, just under AA for body
  // text, and a sent bubble is body text. 0.53 takes it to 4.76:1 and is
  // indistinguishable side by side.
  teal:   { l: 0.53, c: 0.10, h: 196, label: 'Teal' },
  ink:    { l: 0.33, c: 0.03, h: 70,  label: 'Ink' },
};
export const FONTS = {
  sans:  '"Instrument Sans", system-ui, sans-serif',
  neo:   'Inter, system-ui, sans-serif',
  serif: 'Newsreader, Georgia, serif',
  mono:  '"JetBrains Mono", ui-monospace, monospace',
};
export const FONT_LABELS = {
  sans: 'Instrument Sans', neo: 'Inter', serif: 'Newsreader', mono: 'JetBrains Mono',
};

/* ── app-wide theme packs ──────────────────────────────────────────────────
   A pack swaps the whole neutral ramp: window, panels, rows, inputs, menus,
   sheets, borders and all three ink levels — not the chat wallpaper, and not
   the accent, both of which stay independent so they compose.

   The values live in theme-packs.css (one rule per pack per mode). What is
   here is only what JavaScript needs: the id it writes to user_settings and
   three colours to draw the tile with, so the picker shows the actual pack
   instead of a name. Chips are the light ramp; dark mode is in the CSS.

   Every pack clears WCAG AA in both modes (body text 14.2:1 or better, hint
   text 4.5:1 or better) — checked numerically, not by eye. */
export const THEME_PACKS = [
  { id: 'cream', label: 'Cream', note: 'Warm paper. The original Wisp look.',
    chip: { bg: 'oklch(0.968 0.017 78)', surface: 'oklch(0.988 0.011 78)', ink: 'oklch(0.248 0.018 78)' } },
  { id: 'porcelain', label: 'Porcelain', note: 'Cool near-white, crisp and quiet.',
    chip: { bg: 'oklch(0.980 0.004 250)', surface: 'oklch(0.997 0.002 250)', ink: 'oklch(0.238 0.012 250)' } },
  { id: 'linen', label: 'Linen', note: 'Greige, softer than white in daylight.',
    chip: { bg: 'oklch(0.960 0.014 96)', surface: 'oklch(0.982 0.009 96)', ink: 'oklch(0.252 0.017 96)' } },
  { id: 'mist', label: 'Mist', note: 'Cool blue-grey, calm and low-glare.',
    chip: { bg: 'oklch(0.966 0.011 232)', surface: 'oklch(0.987 0.007 232)', ink: 'oklch(0.244 0.016 232)' } },
  { id: 'sage', label: 'Sage', note: 'Muted green, easiest on tired eyes.',
    chip: { bg: 'oklch(0.964 0.014 150)', surface: 'oklch(0.986 0.009 150)', ink: 'oklch(0.246 0.017 150)' } },
  { id: 'lavender', label: 'Lavender', note: 'Faint violet, warm without going pink.',
    chip: { bg: 'oklch(0.965 0.012 300)', surface: 'oklch(0.987 0.008 300)', ink: 'oklch(0.245 0.017 300)' } },
  { id: 'graphite', label: 'Graphite', note: 'Neutral, no colour cast at all.',
    chip: { bg: 'oklch(0.972 0.003 265)', surface: 'oklch(0.992 0.002 265)', ink: 'oklch(0.235 0.008 265)' } },
  { id: 'midnight', label: 'Midnight', note: 'Deep navy. Best of the dark set.',
    chip: { bg: 'oklch(0.958 0.010 262)', surface: 'oklch(0.980 0.007 262)', ink: 'oklch(0.240 0.018 262)' } },
];
export const PACK_IDS = THEME_PACKS.map(p => p.id);
export const DEFAULT_PACK = 'cream';

/* Text that sits *on* the accent — the sent bubble, primary buttons, the send
   key. It used to be a fixed near-white, which is fine for a mid-dark accent
   and quietly awful for a light one: white on Ochre measured 3.36:1, well
   under AA, and a custom accent from the OKLCH picker can be lighter still.
   Crossover measured across the hue circle sits at about 0.59 L, so above it
   we flip to dark ink on the same hue and the bubble stays readable at every
   accent the picker can produce. */
const ON_ACCENT_FLIP = 0.59;
export const onAccentFor = a => a.l >= ON_ACCENT_FLIP
  ? `oklch(0.18 ${Math.min(a.c, 0.05).toFixed(3)} ${a.h})`
  : `oklch(0.985 0.008 ${a.h})`;

/* theme-packs.css carries the pack palettes, the received-bubble tint and the
   per-chat font rule. It is linked from index.html, but injected here too when
   it is missing so this module works on any shell that has not been updated —
   the stylesheet is the other half of everything below, and a half-applied
   theme is worse than none. */
(function ensurePackStyles() {
  const href = '/theme-packs.css';
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
})();

/* ── wallpapers ────────────────────────────────────────────────────────────
   Every preset is pure CSS: nothing to download, nothing to go stale, and a
   cold cache costs the same as a warm one. `bg` paints the base colour, `img`
   layers over it. `dark` only tells the picker to label the tile in light
   ink — bubbles carry their own colours either way. */
export const WALLPAPERS = [
  { id: 'sand',   label: 'Sand',     bg: 'oklch(0.955 0.018 78)' },
  { id: 'linen',  label: 'Linen',    bg: 'oklch(0.968 0.010 96)' },
  { id: 'mist',   label: 'Mist',     bg: 'oklch(0.950 0.014 232)' },
  { id: 'sage',   label: 'Sage',     bg: 'oklch(0.947 0.022 150)' },
  { id: 'blush',  label: 'Blush',    bg: 'oklch(0.952 0.024 18)' },
  { id: 'lilac',  label: 'Lilac',    bg: 'oklch(0.946 0.024 300)' },
  { id: 'butter', label: 'Butter',   bg: 'oklch(0.966 0.032 96)' },
  { id: 'stone',  label: 'Stone',    bg: 'oklch(0.928 0.008 250)' },
  { id: 'dawn',   label: 'Dawn',     bg: 'oklch(0.95 0.02 60)',
    img: 'linear-gradient(180deg, oklch(0.925 0.055 38), oklch(0.975 0.018 92))' },
  { id: 'tide',   label: 'Tide',     bg: 'oklch(0.95 0.02 220)',
    img: 'linear-gradient(158deg, oklch(0.928 0.052 214), oklch(0.972 0.020 162))' },
  { id: 'orchard', label: 'Orchard', bg: 'oklch(0.95 0.02 140)',
    img: 'linear-gradient(200deg, oklch(0.935 0.048 146), oklch(0.972 0.022 104))' },
  { id: 'dots',   label: 'Dots',     bg: 'oklch(0.961 0.012 78)',
    img: 'radial-gradient(oklch(0.55 0.03 78 / 0.22) 1.4px, transparent 1.5px)', size: '18px 18px', repeat: 'repeat' },
  { id: 'grid',   label: 'Grid',     bg: 'oklch(0.966 0.010 78)',
    img: 'linear-gradient(oklch(0.5 0.02 78 / 0.13) 1px, transparent 1px), linear-gradient(90deg, oklch(0.5 0.02 78 / 0.13) 1px, transparent 1px)',
    size: '26px 26px', repeat: 'repeat' },
  { id: 'dune',   label: 'Dune',     bg: 'oklch(0.956 0.018 78)',
    img: 'repeating-linear-gradient(24deg, transparent 0 13px, oklch(0.6 0.05 70 / 0.16) 13px 15px)', size: 'auto', repeat: 'repeat' },
  { id: 'weave',  label: 'Weave',    bg: 'oklch(0.959 0.012 96)',
    img: 'repeating-linear-gradient(45deg, oklch(0.6 0.03 96 / 0.10) 0 6px, transparent 6px 12px), repeating-linear-gradient(-45deg, oklch(0.6 0.03 96 / 0.10) 0 6px, transparent 6px 12px)',
    size: 'auto', repeat: 'repeat' },
  { id: 'ink',    label: 'Ink',      bg: 'oklch(0.300 0.014 262)', dark: true },
  { id: 'forest', label: 'Forest',   bg: 'oklch(0.318 0.030 152)', dark: true },
  { id: 'wine',   label: 'Wine',     bg: 'oklch(0.302 0.040 20)',  dark: true },
  { id: 'coal',   label: 'Coal',     bg: 'oklch(0.252 0.006 70)',  dark: true },
  { id: 'dusk',   label: 'Dusk',     bg: 'oklch(0.32 0.03 282)', dark: true,
    img: 'linear-gradient(180deg, oklch(0.385 0.070 300), oklch(0.258 0.038 262))' },
];

const BY_ID = new Map(WALLPAPERS.map(w => [w.id, w]));

export function parseCustom(str) {
  if (!str) return null;
  const m = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(String(str).trim());
  return m ? { l: +m[1], c: +m[2], h: +m[3] } : null;
}
export const toCustom = ({ l, c, h }) => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;

/* A wallpaper value is one of: null (inherit), 'preset:<id>', a blob/data/http
   URL (what a pending upload previews through), or a path in the wallpapers
   bucket. 'builtin:<id>' is what the first picker wrote — it still resolves,
   so nobody's existing wallpaper vanishes. */
export function resolveWall(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const str = String(value);
  const named = /^(?:preset|builtin):(.+)$/.exec(str);
  if (named) {
    const p = BY_ID.get(named[1]);
    if (!p) return null;
    return { bg: p.bg, img: p.img || null, size: p.size || 'cover', repeat: p.repeat || 'no-repeat', dark: !!p.dark };
  }
  const url = /^(https?:|blob:|data:)/.test(str) ? str : publicUrl('wallpapers', str);
  return url ? { bg: null, img: 'url("' + url + '")', size: 'cover', repeat: 'no-repeat' } : null;
}

/* Paints a wallpaper onto anything carrying .wall — the real layer behind the
   thread, every tile in the picker, and the live preview above them. */
export function paintWall(el, value, { dim = 0, blur = 0 } = {}) {
  if (!el) return;
  const w = resolveWall(value);
  el.style.setProperty('--wall-bg', w?.bg || 'transparent');
  el.style.setProperty('--wall-img', w?.img || 'none');
  el.style.setProperty('--wall-size', w?.size || 'cover');
  el.style.setProperty('--wall-repeat', w?.repeat || 'no-repeat');
  el.style.setProperty('--wall-dim', String(dim || 0));
  el.style.setProperty('--wall-blur', (blur || 0) + 'px');
}

/* ── per-chat cache ───────────────────────────────────────────────────────
   Not a source of truth — chat_members is. This exists so tapping a chat you
   have already opened on this device doesn't flash the account accent and the
   account wallpaper for the frame or two before members land. */
const KEY = id => 'wisp.chat-style.' + id;
export function cacheChatStyle(chatId, style) {
  try { localStorage.setItem(KEY(chatId), JSON.stringify(style)); } catch { /* private mode, quota */ }
}
export function readChatStyle(chatId) {
  try { return JSON.parse(localStorage.getItem(KEY(chatId)) || 'null'); } catch { return null; }
}
export function rememberChatStyle() {
  const c = S.chat;
  if (!c) return;
  const mine = S.members.find(m => m.user_id === S.me?.id);
  if (!mine) return;
  cacheChatStyle(c.chat_id, {
    accent: mine.accent ?? null,
    wallpaper: mine.wallpaper_url ?? null,
    dim: mine.wallpaper_dim ?? null,
    font: mine.font_family ?? null,
    tintIn: mine.accent_incoming ?? null,
  });
}

/* What the open chat should look like right now, ignoring any draft. */
export function currentChatStyle() {
  const c = S.chat;
  if (!c) return { accent: null, wallpaper: null, dim: null, font: null, tintIn: null };
  const mine = S.members.find(m => m.user_id === S.me?.id);
  const cached = mine ? null : readChatStyle(c.chat_id);
  const contact = c.type === 'dm' ? person(c.other_id)?.accent : null;
  return {
    accent: (mine ? mine.accent : cached?.accent) ?? contact ?? null,
    wallpaper: (mine ? mine.wallpaper_url : cached?.wallpaper) ?? null,
    dim: (mine ? mine.wallpaper_dim : cached?.dim) ?? null,
    // Both read `?? null` rather than a boolean cast on purpose: null means
    // "inherit the account setting", which is a different answer from false.
    // They also survive a client that is ahead of the database — the columns
    // simply read undefined, which collapses to null and inherits.
    font: (mine ? mine.font_family : cached?.font) ?? null,
    tintIn: (mine ? mine.accent_incoming : cached?.tintIn) ?? null,
  };
}

/* ── draft ─────────────────────────────────────────────────────────────────
   The picker only ever writes here. Everything it does is visible on the real
   thread immediately and saved to nothing until Apply is pressed, which is
   what makes "preview before you confirm" true for a preset and for an
   uploaded photo alike. */
let draft = null;
export const styleDraft = () => draft;
export function startStyleDraft() { draft = { ...currentChatStyle() }; return draft; }
export function setStyleDraft(patch) {
  draft = { ...(draft || currentChatStyle()), ...patch };
  applyChatStyle();
  return draft;
}
export function cancelStyleDraft() { draft = null; applyChatStyle(); }

export async function saveChatStyle(patch) {
  const c = S.chat;
  if (!c) return;
  await upd('chat_members', patch, { chat_id: c.chat_id, user_id: S.me.id });
  const mine = S.members.find(m => m.user_id === S.me.id);
  if (mine) Object.assign(mine, patch);
  else cacheChatStyle(c.chat_id, {
    accent: patch.accent ?? null, wallpaper: patch.wallpaper_url ?? null, dim: patch.wallpaper_dim ?? null,
    font: patch.font_family ?? null, tintIn: patch.accent_incoming ?? null,
  });
  rememberChatStyle();
  draft = null;
  applyChatStyle();
}

/* ── the two functions that touch the DOM ──────────────────────────────── */
export function applySettings(s = S.settings) {
  if (!s) return;
  const root = document.documentElement, st = root.style;
  st.setProperty('--font', FONTS[s.font_family] || FONTS.sans);
  st.setProperty('--scale', s.text_scale || 1);
  st.setProperty('--radius', (s.bubble_radius ?? 16) + 'px');
  st.setProperty('--speed', s.reduce_motion ? 1 : (s.animation_speed || 1));
  root.dataset.density = s.density || 'comfortable';
  root.dataset.contrast = s.high_contrast ? 'high' : 'normal';
  root.dataset.motion = s.reduce_motion ? 'reduce' : 'full';
  const dark = s.theme_mode === 'dark' ||
    (s.theme_mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  // The pack owns every neutral surface in the app; theme-packs.css holds the
  // values for both modes, so this is the whole of "change the entire theme".
  root.dataset.pack = PACK_IDS.includes(s.theme_pack) ? s.theme_pack : DEFAULT_PACK;
  applyChatStyle();
  paintBrowserChrome();
}

/* Accent and wallpaper in one pass, because they're one decision: the chat's
   own override first, then the contact's (DMs only), then the account's. */
export function applyChatStyle() {
  const s = S.settings || {};
  const eff = draft || currentChatStyle();
  const st = document.documentElement.style;
  const a = parseCustom(eff.accent) || parseCustom(s.custom_accent) || ACCENTS[s.accent] || ACCENTS.blue;
  st.setProperty('--acc-l', a.l);
  st.setProperty('--acc-c', a.c);
  st.setProperty('--acc-h', a.h);
  st.setProperty('--on-accent', onAccentFor(a));
  // --hue-n is no longer derived from the accent: the theme pack owns the
  // neutral hue now (theme-packs.css), and having two things fight over one
  // token is how "I changed the theme and half the app ignored me" happens.

  // Per-chat typeface. Only the conversation column reads --font-chat, so this
  // is genuinely per chat rather than a second app-wide override.
  const font = FONTS[eff.font] || null;
  if (font) st.setProperty('--font-chat', font); else st.removeProperty('--font-chat');

  // Whether received bubbles share the chat accent. Chat override first, then
  // the account default, so a chat can opt out of an account-wide preference.
  const tint = eff.tintIn ?? s.accent_incoming ?? false;
  document.documentElement.dataset.tintIn = tint ? 'on' : 'off';

  paintWall($('#thread-wall'), eff.wallpaper ?? s.wallpaper_url ?? null, {
    dim: eff.dim ?? (1 - (s.wallpaper_opacity ?? 1)),
    blur: s.wallpaper_blur || 0,
  });
}

/* Kept under the old name: several call sites only care about the backdrop. */
export const applyWallpaper = applyChatStyle;

/* The PWA/browser chrome around the app (address bar, task switcher card)
   reads <meta name="theme-color">, which was a hard-coded cream hex. Left
   alone it frames a Midnight-themed app in a cream bar. */
function paintBrowserChrome() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  // body's resolved backgroundColor rather than the raw --bg token: the token
  // is an oklch() string, and theme-color is parsed by the OS shell rather than
  // the page, so handing it rgb() is the portable answer.
  const resolved = document.body && getComputedStyle(document.body).backgroundColor;
  const fallback = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const value = (resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : fallback);
  if (value) meta.setAttribute('content', value);
}

export async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  applySettings();
  await upd('user_settings', patch, { user_id: S.me.id });
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.settings?.theme_mode === 'system') applySettings();
});
