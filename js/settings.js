import { sb, rpc, sel, upd, del, ins, upload, publicUrl } from './db.js';
import { S, person } from './state.js';
import { $, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox, initials, bytes, shortWhen, debounce, iconEl, avatarData } from './util.js';
import { ACCENTS, FONTS, WALLPAPERS, applySettings, saveSettings, toCustom, parseCustom, applyWallpaper, paintWall } from './theme.js';
import { signOut, signOutEverywhere } from './auth.js';
import { compressImage } from './media.js';
import { openSide, openPhotoViewer } from './panels.js';

const row = (label, control, note) => h('div', { class: 'kv' },
  h('div', {}, h('span', { style: { color: 'var(--ink)' } }, label), note && h('div', { class: 'hint' }, note)), control);

function toggle(value, onchange) {
  const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!value) });
  b.onclick = async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    try { await onchange(next); } catch (e) { oops(e); b.setAttribute('aria-checked', String(!next)); }
  };
  return b;
}
function segment(options, value, onpick) {
  const wrap = h('div', { class: 'seg' });
  wrap.style.setProperty('--seg-n', String(options.length));
  wrap.append(h('span', { class: 'seg-glow' }));
  options.forEach(([val, label], i) => wrap.append(h('button', {
    type: 'button',
    onclick: e => {
      [...wrap.querySelectorAll('button')].forEach(c => c.classList.remove('is-on'));
      e.currentTarget.classList.add('is-on');
      wrap.style.setProperty('--seg-i', String(i));
      onpick(val);
    },
  }, label)));
  const btns = [...wrap.querySelectorAll('button')];
  const activeIdx = Math.max(0, options.findIndex(([v]) => v === value));
  wrap.style.setProperty('--seg-i', String(activeIdx));
  btns.forEach((c, i) => c.classList.toggle('is-on', i === activeIdx));
  return wrap;
}
function slider(min, max, step, value, oninput, fmt = v => v) {
  const out = h('small', { class: 'hint' }, fmt(value));
  const s = h('input', {
    type: 'range', min, max, step, value,
    oninput: e => { out.textContent = fmt(+e.target.value); oninput(+e.target.value); },
  });
  return h('div', { class: 'range-cell' }, s, out);
}
function selectBox(options, value, onpick) {
  return h('select', { onchange: e => onpick(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

/* ── the from-scratch OKLCH picker ──────────────────────────────────── */
function colorPicker() {
  const cur = parseCustom(S.settings.custom_accent) || ACCENTS[S.settings.accent] || ACCENTS.clay;
  let { l, c, h: hue } = cur;
  const field = h('div', { class: 'picker-field' });
  const dot = h('div', { class: 'picker-dot' });
  field.append(dot);
  const hueBar = h('div', { class: 'picker-hue' });
  const hueDot = h('div', { class: 'picker-dot', style: { top: '6px' } });
  hueBar.append(hueDot);
  const readout = h('code', {});
  const paint = () => {
    field.style.background =
      `linear-gradient(to top, oklch(0.25 0.02 ${hue}), oklch(0.95 0.02 ${hue})),
       linear-gradient(to right, oklch(0.6 0 ${hue}), oklch(0.6 0.22 ${hue}))`;
    field.style.backgroundBlendMode = 'multiply';
    dot.style.left = (c / 0.22 * 100) + '%';
    dot.style.top = ((0.95 - l) / 0.7 * 100) + '%';
    hueDot.style.left = (hue / 360 * 100) + '%';
    readout.textContent = toCustom({ l, c, h: hue });
  };
  const commit = debounce(() => saveSettings({ custom_accent: toCustom({ l, c, h: hue }) }), 260);
  const live = () => { const st = document.documentElement.style; st.setProperty('--acc-l', l); st.setProperty('--acc-c', c); st.setProperty('--acc-h', hue); paint(); commit(); };
  const grab = (el, fn) => {
    const move = e => {
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, ((e.touches?.[0]?.clientX ?? e.clientX) - r.left) / r.width));
      const y = Math.min(1, Math.max(0, ((e.touches?.[0]?.clientY ?? e.clientY) - r.top) / r.height));
      fn(x, y);
    };
    el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); move(e); el.onpointermove = move; });
    el.addEventListener('pointerup', () => { el.onpointermove = null; });
  };
  grab(field, (x, y) => { c = +(x * 0.22).toFixed(3); l = +(0.95 - y * 0.7).toFixed(3); live(); });
  grab(hueBar, x => { hue = Math.round(x * 360); live(); });
  paint();
  return h('div', { class: 'picker' }, field, hueBar,
    h('div', { class: 'kv' }, readout, h('button', {
      class: 'btn small ghost', onclick: () => saveSettings({ custom_accent: null }),
    }, 'Use a preset instead')));
}

async function uploadPublic(bucket, file, patchKey) {
  const { blob } = await compressImage(file);
  const path = `${S.me.id}/${crypto.randomUUID()}.${bucket === 'sounds' ? (file.name.split('.').pop() || 'mp3') : 'webp'}`;
  await upload(bucket, path, bucket === 'sounds' ? file : blob, bucket === 'sounds' ? file.type : 'image/webp');
  await saveSettings({ [patchKey]: path });
  return path;
}
function filePick(accept, cb) {
  const i = h('input', { type: 'file', accept, hidden: true, onchange: e => e.target.files[0] && cb(e.target.files[0]) });
  document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
}

/* ── sections ───────────────────────────────────────────────────── */
/* Your own face and name sit at the top, the way they do in every messenger
   worth copying. It also means there is exactly one route to Settings — the
   duplicate avatar button in the tab bar is gone. */
function profileHero() {
  const me = S.me;
  const photo = me.photo_url || null;
  return h('section', { class: 'info-hero' },
    h('button', {
      class: 'hero-face', title: photo ? 'View your photo' : 'Add a photo',
      onclick: () => photo ? openPhotoViewer(photo, me.display_name) : changePhoto(),
    }, h('img', { src: photo || avatarData(me.display_name), alt: '' }),
      h('span', { class: 'hero-cam' }, iconEl('camera', 15))),
    h('b', { class: 'display' }, me.display_name),
    h('small', { class: 'hint' }, me.about || 'No about yet'),
    h('small', { class: 'hint' }, me.email),
    h('div', { class: 'hero-acts' },
      h('button', { class: 'btn', onclick: changePhoto }, iconEl('camera', 17), 'Photo'),
      h('button', {
        class: 'btn', onclick: async () => {
          const v = await promptBox('Display name', { value: S.me.display_name });
          if (v) { await upd('profiles', { display_name: v }, { id: S.me.id }); S.me.display_name = v; openSettings(); }
        },
      }, iconEl('edit', 17), 'Name'),
      h('button', {
        class: 'btn', onclick: async () => {
          const v = await promptBox('About', { value: S.me.about || '', note: 'A line about you. Visible per your privacy setting.' });
          if (v !== null) { await upd('profiles', { about: v }, { id: S.me.id }); S.me.about = v; openSettings(); }
        },
      }, iconEl('info', 17), 'About')));
}

function changePhoto() {
  filePick('image/*', async f => {
    try {
      const { blob } = await compressImage(f);
      const path = `${S.me.id}/avatar.webp`;
      await upload('avatars', path, blob, 'image/webp');
      const url = publicUrl('avatars', path) + '?v=' + Date.now();
      await upd('profiles', { photo_url: url }, { id: S.me.id });
      S.me.photo_url = url;
      const mini = $('#me-avatar');
      if (mini) mini.src = url;
      toast('Photo updated'); openSettings();
    } catch (e) { oops(e); }
  });
}

function appearanceSection() {
  const s = S.settings;
  const swatches = h('div', { class: 'swatches' },
    Object.entries(ACCENTS).map(([key, a]) => h('button', {
      class: 'swatch' + (!s.custom_accent && s.accent === key ? ' is-on' : ''),
      title: a.label, style: { background: `oklch(${a.l} ${a.c} ${a.h})` },
      onclick: async () => { await saveSettings({ accent: key, custom_accent: null }); openSettings(); },
    })));
  const preview = h('div', {
    class: 'bub', style: { background: 'var(--accent)', color: 'var(--on-accent)', maxWidth: '70%', marginTop: '6px' },
  }, 'Live preview of your text size and bubble shape.');

  const wallTile = (label, value) => {
    const t = h('button', {
      class: 'wall-tile' + ((s.wallpaper_url ?? null) === value ? ' is-on' : ''), title: label, type: 'button',
      onclick: async () => { await saveSettings({ wallpaper_url: value }); openSettings(); },
    }, h('span', { class: 'wall' }), h('small', {}, label));
    paintWall(t.querySelector('.wall'), value, { dim: 0 });
    return t;
  };
  const walls = h('div', { class: 'wall-grid' },
    wallTile('None', null),
    h('button', {
      class: 'wall-tile is-add', type: 'button', title: 'Upload a photo',
      onclick: () => filePick('image/*', f => uploadPublic('wallpapers', f, 'wallpaper_url')
        .then(() => { applyWallpaper(); toast('Wallpaper set'); openSettings(); }).catch(oops)),
    }, h('span', { class: 'wall wall-add' }, iconEl('image', 20)), h('small', {}, 'Photo')),
    WALLPAPERS.map(w => wallTile(w.label, 'preset:' + w.id)));

  return h('section', {},
    h('h3', {}, 'Appearance'),
    row('Theme', segment([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], s.theme_mode, v => saveSettings({ theme_mode: v }))),
    h('div', { class: 'stack' }, h('span', { class: 'hint' }, 'Accent'), swatches, colorPicker()),
    row('Typeface', selectBox([['sans', 'Instrument Sans'], ['neo', 'Inter'], ['serif', 'Newsreader'], ['mono', 'JetBrains Mono']], s.font_family, v => saveSettings({ font_family: v }))),
    row('Density', segment([['compact', 'Compact'], ['comfortable', 'Comfy'], ['spacious', 'Roomy']], s.density, v => saveSettings({ density: v }))),
    row('Text size', slider(0.85, 1.4, 0.05, s.text_scale, v => saveSettings({ text_scale: v }), v => Math.round(v * 100) + '%')),
    row('Bubble corners', slider(2, 26, 1, s.bubble_radius, v => saveSettings({ bubble_radius: v }), v => v + 'px')),
    preview,
    h('h3', { style: { marginTop: '10px' } }, 'Default wallpaper'),
    h('p', { class: 'hint' }, 'Used by every chat that has no wallpaper of its own. Set one per chat from its ⋮ menu → Theme & wallpaper.'),
    walls,
    row('Wallpaper opacity', slider(0.15, 1, 0.05, s.wallpaper_opacity, v => saveSettings({ wallpaper_opacity: v }), v => Math.round(v * 100) + '%')),
    row('Wallpaper blur', slider(0, 14, 1, s.wallpaper_blur, v => saveSettings({ wallpaper_blur: v }), v => v + 'px')));
}

function accessibilitySection() {
  const s = S.settings;
  return h('section', {},
    h('h3', {}, 'Accessibility'),
    row('Reduce motion', toggle(s.reduce_motion, v => saveSettings({ reduce_motion: v }))),
    row('High contrast', toggle(s.high_contrast, v => saveSettings({ high_contrast: v }))),
    row('Animation speed', slider(0.5, 2, 0.1, s.animation_speed, v => saveSettings({ animation_speed: v }), v => v + '×')));
}

function notificationsSection() {
  const s = S.settings;
  return h('section', {},
    h('h3', {}, 'Notifications'),
    row('Preview', selectBox([['full', 'Sender and message'], ['sender_only', 'Sender only'], ['hidden', 'Just “New message”']], s.notif_preview, v => saveSettings({ notif_preview: v }))),
    row('Sound', h('div', { class: 'row-btns' },
      selectBox([['chime', 'Chime'], ['knock', 'Knock'], ['pop', 'Pop'], ['none', 'Silent']], s.notif_sound, v => saveSettings({ notif_sound: v })),
      h('button', { class: 'btn small ghost', onclick: async () => (await import('./notify.js')).playSound() }, 'Test'))),
    row('Custom sound', h('button', { class: 'btn small', onclick: () => filePick('audio/*', f => uploadPublic('sounds', f, 'notif_sound').then(() => toast('Custom sound saved'))) }, 'Upload'),
      'Uploaded tones are stored per account and play on this and every other device.'),
    row('Permission', h('button', {
      class: 'btn small', onclick: async () => { const ok = await (await import('./notify.js')).askPermission(); toast(ok ? 'Granted' : 'Denied'); },
    }, Notification.permission)));
}

function focusSection() {
  const s = S.settings;
  return h('section', {},
    h('h3', {}, 'Focus'),
    row('Focus mode', toggle(s.focus_mode, v => { saveSettings({ focus_mode: v }); }),
      'App-wide quiet: no sounds, no notifications, unread counts stay.'),
    row('Quiet hours', h('div', { class: 'row-btns' },
      h('input', { type: 'time', value: s.quiet_from || '', onchange: e => saveSettings({ quiet_from: e.target.value || null }) }),
      h('input', { type: 'time', value: s.quiet_to || '', onchange: e => saveSettings({ quiet_to: e.target.value || null }) }))));
}

function privacySection() {
  const s = S.settings;
  const vis = [['everyone', 'Everyone'], ['contacts', 'Contacts'], ['nobody', 'Nobody']];
  return h('section', {},
    h('h3', {}, 'Privacy'),
    row('Read receipts', toggle(s.read_receipts, v => saveSettings({ read_receipts: v })), 'Off means you stop sending them. You still see others.'),
    row('Last seen', selectBox(vis, s.last_seen_vis, v => saveSettings({ last_seen_vis: v }))),
    row('Online status', selectBox(vis, s.online_vis, v => saveSettings({ online_vis: v }))),
    row('Profile photo', selectBox(vis, s.photo_vis, v => saveSettings({ photo_vis: v })), 'Who can open your picture full size.'),
    row('About', selectBox(vis, s.about_vis, v => saveSettings({ about_vis: v }))),
    row('Default disappearing', selectBox([[0, 'Off'], [3600, '1 hour'], [86400, '24 hours'], [604800, '7 days'], [7776000, '90 days']].map(([v, l]) => [String(v), l]), String(s.default_disappear), v => saveSettings({ default_disappear: +v })), 'Applied to new chats you start.'),
    row('Media size cap', slider(4, 200, 4, s.media_limit_mb, v => saveSettings({ media_limit_mb: v }), v => v + ' MB')),
    h('button', { class: 'btn small', onclick: blockedList }, 'Blocked list'));
}

async function blockedList() {
  const rows = await sel('blocks', { eq: { blocker_id: S.me.id } });
  const ids = rows.map(r => r.blocked_id);
  const people = ids.length ? await rpc('people_info', { p_ids: ids }) : [];
  modal(h('h3', { class: 'display' }, 'Blocked'),
    people.length ? h('div', { class: 'stack' }, people.map(p => h('div', { class: 'member' },
      h('div', { class: 'av' }, initials(p.display_name)), p.display_name,
      h('button', {
        class: 'btn small ghost', onclick: async e => {
          await del('blocks', { blocker_id: S.me.id, blocked_id: p.id });
          e.target.closest('.member').remove(); toast('Unblocked');
        },
      }, 'Unblock')))) : h('p', { class: 'hint' }, 'Nobody blocked.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

async function securitySection() {
  const s = S.settings;
  const { data: keys } = await sb.from('user_keys').select('created_at').eq('user_id', S.me.id).maybeSingle();
  const devices = await sel('devices', { eq: { user_id: S.me.id }, order: ['last_active', 'desc'] });
  return h('section', {},
    h('h3', {}, 'Security'),
    row('Two-step PIN', h('button', {
      class: 'btn small', onclick: async () => {
        if (s.two_step_pin) {
          if (await confirmBox('Turn off the PIN?', 'You will only need your password after this.', 'Turn off')) {
            await rpc('set_two_step_pin', { p_pin: null }); S.settings.two_step_pin = null; openSettings();
          }
          return;
        }
        const pin = await promptBox('Set a PIN', { type: 'password', label: 'PIN', note: 'Asked when the app loads. Checked with bcrypt in Postgres. It gates this app, not the auth session itself.' });
        if (pin) { await rpc('set_two_step_pin', { p_pin: pin }); S.settings.two_step_pin = 'set'; openSettings(); }
      },
    }, s.two_step_pin ? 'On' : 'Off')),
    row('Encryption identity', h('small', { class: 'hint' }, keys ? 'created ' + shortWhen(keys.created_at) : 'not created')),
    h('p', { class: 'hint' }, 'Encryption is per chat: an AES-256-GCM chat key wrapped to each member\u2019s RSA key. No forward secrecy, no safety numbers. Encrypted chats are excluded from server-side search and digests.'),
    h('h3', { style: { marginTop: '10px' } }, 'Devices'),
    ...devices.map(d => h('div', { class: 'member' },
      h('div', {}, h('div', {}, d.platform), h('small', { class: 'hint' }, (d.label || '').slice(0, 44)),
        h('small', { class: 'hint' }, 'active ' + shortWhen(d.last_active))),
      h('button', { class: 'role btn small ghost', onclick: async () => { await del('devices', { id: d.id }); openSettings(); } }, 'Forget'))),
    h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox('Log out everywhere?', 'Every session for this account ends, including this one.', 'Log out all')) signOutEverywhere(); } }, 'Log out of all devices'));
}

function accountSection() {
  return h('section', {},
    h('h3', {}, 'Account'),
    h('div', { class: 'row-btns' },
      h('button', {
        class: 'btn small', onclick: async () => {
          try {
            const data = await rpc('export_my_data');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: `wisp-export-${Date.now()}.json` });
            document.body.append(a); a.click(); a.remove();
          } catch (e) { oops(e); }
        },
      }, 'Export my data'),
      h('button', { class: 'btn small ghost', onclick: signOut }, 'Sign out')),
    h('button', {
      class: 'btn small danger', onclick: async () => {
        if (!await confirmBox('Delete this account?', 'Profile, memberships and settings go. Message bodies you sent are wiped. This cannot be undone.', 'Delete forever')) return;
        const typed = await promptBox('Type DELETE to confirm');
        if (typed !== 'DELETE') return toast('Not deleted.');
        try { await rpc('delete_my_account'); await sb.auth.signOut(); location.reload(); } catch (e) { oops(e); }
      },
    }, 'Delete account'));
}

export async function openSettings() {
  const wrap = h('div', {},
    h('div', { class: 'side-head' }, h('h3', { class: 'display' }, 'Settings'),
      h('button', { class: 'btn small ghost', onclick: () => openSide(null) }, 'Close')),
    profileHero(), appearanceSection(), notificationsSection(), focusSection(),
    privacySection(), accessibilitySection(), accountSection());
  openSide(wrap);
  wrap.insertBefore(await securitySection(), wrap.lastChild);
}
