// Applies user_settings — and, when a chat is open, that chat's own overrides —
// to CSS custom properties. The DB rows stay the source of truth; localStorage
// holds nothing but a small per-chat cache so reopening a chat paints its own
// colour and wallpaper in the same frame as the tap instead of a beat later.
import { S, person } from './state.js';
import { upd, publicUrl } from './db.js';
import { $ } from './util.js';

export const ACCENTS = {
  clay:   { l: 0.55, c: 0.13, h: 38,  label: 'Clay' },
  moss:   { l: 0.52, c: 0.10, h: 148, label: 'Moss' },
  indigo: { l: 0.50, c: 0.14, h: 274, label: 'Indigo' },
  plum:   { l: 0.48, c: 0.13, h: 336, label: 'Plum' },
  slate:  { l: 0.47, c: 0.05, h: 250, label: 'Slate' },
  ochre:  { l: 0.63, c: 0.13, h: 78,  label: 'Ochre' },
  teal:   { l: 0.55, c: 0.10, h: 196, label: 'Teal' },
  ink:    { l: 0.33, c: 0.03, h: 70,  label: 'Ink' },
};
export const FONTS = {
  sans:  '"Instrument Sans", system-ui, sans-serif',
  neo:   'Inter, system-ui, sans-serif',
  serif: 'Newsreader, Georgia, serif',
  mono:  '"JetBrains Mono", ui-monospace, monospace',
};

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
  });
}

/* What the open chat should look like right now, ignoring any draft. */
export function currentChatStyle() {
  const c = S.chat;
  if (!c) return { accent: null, wallpaper: null, dim: null };
  const mine = S.members.find(m => m.user_id === S.me?.id);
  const cached = mine ? null : readChatStyle(c.chat_id);
  const contact = c.type === 'dm' ? person(c.other_id)?.accent : null;
  return {
    accent: (mine ? mine.accent : cached?.accent) ?? contact ?? null,
    wallpaper: (mine ? mine.wallpaper_url : cached?.wallpaper) ?? null,
    dim: (mine ? mine.wallpaper_dim : cached?.dim) ?? null,
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
  applyChatStyle();
}

/* Accent and wallpaper in one pass, because they're one decision: the chat's
   own override first, then the contact's (DMs only), then the account's. */
export function applyChatStyle() {
  const s = S.settings || {};
  const eff = draft || currentChatStyle();
  const st = document.documentElement.style;
  const a = parseCustom(eff.accent) || parseCustom(s.custom_accent) || ACCENTS[s.accent] || ACCENTS.clay;
  st.setProperty('--acc-l', a.l);
  st.setProperty('--acc-c', a.c);
  st.setProperty('--acc-h', a.h);
  st.setProperty('--hue-n', a.h > 200 && a.h < 320 ? 265 : 70);
  paintWall($('#thread-wall'), eff.wallpaper ?? s.wallpaper_url ?? null, {
    dim: eff.dim ?? (1 - (s.wallpaper_opacity ?? 1)),
    blur: s.wallpaper_blur || 0,
  });
}

/* Kept under the old name: several call sites only care about the backdrop. */
export const applyWallpaper = applyChatStyle;

export async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  applySettings();
  await upd('user_settings', patch, { user_id: S.me.id });
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.settings?.theme_mode === 'system') applySettings();
});
