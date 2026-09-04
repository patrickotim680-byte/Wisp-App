// Applies user_settings to CSS custom properties. Nothing visual is stored in
// localStorage: the DB row is the source of truth, so a fresh device that
// signs in looks identical.
import { S } from './state.js';
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

export function parseCustom(str) {
  if (!str) return null;
  const m = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(str.trim());
  return m ? { l: +m[1], c: +m[2], h: +m[3] } : null;
}
export const toCustom = ({ l, c, h }) => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;

export function applySettings(s = S.settings) {
  if (!s) return;
  const root = document.documentElement, st = root.style;
  const a = parseCustom(s.custom_accent) || ACCENTS[s.accent] || ACCENTS.clay;
  st.setProperty('--acc-l', a.l); st.setProperty('--acc-c', a.c); st.setProperty('--acc-h', a.h);
  st.setProperty('--hue-n', a.h > 200 && a.h < 320 ? 265 : 70);
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
  applyWallpaper();
}

export function applyWallpaper() {
  const s = S.settings || {};
  const perChat = S.chat && S.members.find(m => m.user_id === S.me?.id)?.wallpaper_url;
  const path = perChat || s.wallpaper_url;
  const thread = $('#thread');
  if (!thread) return;
  const url = path ? (path.startsWith('http') ? path : publicUrl('wallpapers', path)) : null;
  thread.style.setProperty('--wall', url ? `url("${url}")` : 'none');
  thread.style.setProperty('--wall-blur', (s.wallpaper_blur || 0) + 'px');
  thread.style.setProperty('--wall-fade', String(1 - (s.wallpaper_opacity ?? 1)));
}

export async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  applySettings();
  await upd('user_settings', patch, { user_id: S.me.id });
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.settings?.theme_mode === 'system') applySettings();
});

/* Per-contact accent override while a chat is open. */
export function applyContactAccent(contactAccent) {
  const st = document.documentElement.style;
  const a = parseCustom(contactAccent);
  if (a) { st.setProperty('--acc-l', a.l); st.setProperty('--acc-c', a.c); st.setProperty('--acc-h', a.h); }
  else applySettings();
}
