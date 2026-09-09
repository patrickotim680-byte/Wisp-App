import { sb, rpc, sel, upd, del, ins, upload, publicUrl } from './db.js';
import { S, person } from './state.js';
import { $, h, clear, toast, oops, modal, closeModal, confirmBox, promptBox, initials,
         bytes, shortWhen, icon, iconEl, debounce, copyText } from './util.js';
import { ACCENTS, FONTS, applySettings, saveSettings, toCustom, parseCustom, applyWallpaper } from './theme.js';
import { signOut, signOutEverywhere } from './auth.js';
import { compressImage } from './media.js';
import { openSide, sidePanel, sideAction } from './panels.js';

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
  return h('div', { style: { display: 'grid', gap: '4px', minWidth: '150px' } }, s, out);
}
function selectBox(options, value, onpick) {
  return h('select', { onchange: e => onpick(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}
const card = (...kids) => h('div', { class: 'card' }, kids.flat(3).filter(Boolean));

/* ── the from-scratch OKLCH picker ────────────────────────────────── */
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
  const live = () => {
    const st = document.documentElement.style;
    st.setProperty('--acc-l', l); st.setProperty('--acc-c', c); st.setProperty('--acc-h', hue);
    paint(); commit();
  };
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
  const isSound = bucket === 'sounds';
  let payload = file, mime = file.type, ext = (file.name.split('.').pop() || 'mp3');
  if (!isSound) { const { blob } = await compressImage(file); payload = blob; mime = 'image/webp'; ext = 'webp'; }
  const path = `${S.me.id}/${crypto.randomUUID()}.${ext}`;
  await upload(bucket, path, payload, mime);
  await saveSettings({ [patchKey]: path });
  return path;
}
function filePick(accept, cb) {
  const i = h('input', { type: 'file', accept, hidden: true, onchange: e => e.target.files[0] && cb(e.target.files[0]) });
  document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
}

/* ── sections ──────────────────────────────────────────────── */
function profileSection() {
  const s = S.me;
  const avatar = s.photo_url
    ? h('img', { class: 'av', src: s.photo_url, style: { width: '84px', height: '84px' } })
    : h('div', { class: 'av', style: { width: '84px', height: '84px', fontSize: '1.3em' } }, initials(s.display_name));
  return h('div', {},
    h('section', {},
      h('div', { class: 'profile-hero' }, avatar,
        h('b', {}, s.display_name),
        h('small', { class: 'hint' }, s.email),
        h('button', {
          class: 'btn small', onclick: () => filePick('image/*', async f => {
            try {
              const { blob } = await compressImage(f);
              const path = `${S.me.id}/avatar.webp`;
              await upload('avatars', path, blob, 'image/webp');
              const url = publicUrl('avatars', path) + '?v=' + Date.now();
              await upd('profiles', { photo_url: url }, { id: S.me.id });
              S.me.photo_url = url; $('#me-avatar').src = url;
              toast('Photo updated'); openSettings('profile');
            } catch (e) { oops(e); }
          }),
        }, 'Change photo'))),
    h('section', {},
      card(
        row('Display name', h('button', {
          class: 'btn small', onclick: async () => {
            const v = await promptBox('Display name', { value: S.me.display_name });
            if (v) { await upd('profiles', { display_name: v }, { id: S.me.id }); S.me.display_name = v; openSettings('profile'); }
          },
        }, S.me.display_name)),
        row('About', h('button', {
          class: 'btn small', onclick: async () => {
            const v = await promptBox('About', { value: S.me.about || '' });
            if (v !== null) { await upd('profiles', { about: v }, { id: S.me.id }); S.me.about = v; openSettings('profile'); }
          },
        }, (S.me.about || 'Add one').slice(0, 22)),
          'A line about you, shown on your profile.'),
        row('Email', h('button', { class: 'btn small ghost', onclick: () => copyText(S.me.email) }, 'Copy')))));
}

function appearanceSection() {
  const s = S.settings;
  const swatches = h('div', { class: 'swatches' },
    Object.entries(ACCENTS).map(([key, a]) => h('button', {
      class: 'swatch' + (!s.custom_accent && s.accent === key ? ' is-on' : ''),
      title: a.label, style: { background: `oklch(${a.l} ${a.c} ${a.h})` },
      onclick: async () => { await saveSettings({ accent: key, custom_accent: null }); openSettings('appearance'); },
    })));
  const preview = h('div', {
    class: 'bub', style: { background: 'var(--accent)', color: 'var(--on-accent)', maxWidth: '80%' },
  }, 'Live preview of your text size and bubble shape.');
  return h('div', {},
    h('section', {},
      h('h3', {}, 'Theme'),
      card(
        row('Mode', segment([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], s.theme_mode, v => saveSettings({ theme_mode: v }))),
        row('Typeface', selectBox([['sans', 'Instrument Sans'], ['neo', 'Inter'], ['serif', 'Newsreader'], ['mono', 'JetBrains Mono']], s.font_family, v => saveSettings({ font_family: v }))),
        row('Spacing', segment([['compact', 'Compact'], ['comfortable', 'Comfy'], ['spacious', 'Roomy']], s.density, v => saveSettings({ density: v }))),
        row('Text size', slider(0.85, 1.4, 0.05, s.text_scale, v => saveSettings({ text_scale: v }), v => Math.round(v * 100) + '%')),
        row('Bubble corners', slider(2, 26, 1, s.bubble_radius, v => saveSettings({ bubble_radius: v }), v => v + 'px')),
        preview)),
    h('section', {},
      h('h3', {}, 'Accent'),
      card(swatches, colorPicker())),
    h('section', {},
      h('h3', {}, 'Wallpaper'),
      card(
        h('div', { class: 'swatches' },
          ['', 'dune', 'grid', 'dots'].map(name => h('button', {
            class: 'swatch', title: name || 'None',
            style: { background: name ? 'var(--accent-quiet)' : 'var(--sunken)', backgroundImage: builtinWall(name) },
            onclick: async () => { await saveSettings({ wallpaper_url: name ? 'builtin:' + name : null }); applyWallpaper(); },
          }))),
        row('Custom image', h('button', {
          class: 'btn small',
          onclick: () => filePick('image/*', f => uploadPublic('wallpapers', f, 'wallpaper_url')
            .then(() => { applyWallpaper(); toast('Wallpaper set'); }).catch(oops)),
        }, 'Upload')),
        row('Dim', slider(0.15, 1, 0.05, s.wallpaper_opacity ?? 1, v => saveSettings({ wallpaper_opacity: v }), v => Math.round(v * 100) + '%')),
        row('Blur', slider(0, 14, 1, s.wallpaper_blur ?? 0, v => saveSettings({ wallpaper_blur: v }), v => v + 'px')))));
}
function builtinWall(name) {
  if (name === 'dune') return 'repeating-linear-gradient(20deg, transparent 0 12px, oklch(0.6 0.05 70 / .18) 12px 14px)';
  if (name === 'grid') return 'linear-gradient(oklch(0.5 0 0 / .12) 1px, transparent 1px), linear-gradient(90deg, oklch(0.5 0 0 / .12) 1px, transparent 1px)';
  if (name === 'dots') return 'radial-gradient(oklch(0.5 0 0 / .18) 1px, transparent 1px)';
  return 'none';
}

function accessibilitySection() {
  const s = S.settings;
  return h('div', {}, h('section', {},
    card(
      row('Reduce motion', toggle(s.reduce_motion, v => saveSettings({ reduce_motion: v })),
        'Turns off the sliding indicators, bubble rises and panel transitions.'),
      row('High contrast', toggle(s.high_contrast, v => saveSettings({ high_contrast: v }))),
      row('Animation speed', slider(0.5, 2, 0.1, s.animation_speed, v => saveSettings({ animation_speed: v }), v => v + '×')))));
}

/* Notifications, including whether background delivery is actually live.
   The old panel showed Notification.permission raw ("default", "denied"),
   which tells you nothing about what to do next. */
function notificationsSection() {
  const s = S.settings;
  const custom = typeof s.notif_sound === 'string' && s.notif_sound.includes('/');
  const soundOptions = [['chime', 'Chime'], ['knock', 'Knock'], ['pop', 'Pop'], ['none', 'Silent']];
  if (custom) soundOptions.push([s.notif_sound, 'Your upload']);

  const permState = {
    granted: ['Notifications are on', 'check'],
    denied: ['Blocked by the browser — turn them back on in site settings', 'ban'],
    unsupported: ['This browser has no notification support', 'alert'],
  }[Notification.permission] || ['Not asked yet — tap to allow', 'bell'];

  const status = h('small', { class: 'hint' }, 'checking background delivery\u2026');
  import('./notify.js').then(async n => {
    const st = await n.pushStatus();
    status.textContent = st.message;
  }).catch(() => { status.textContent = ''; });

  return h('div', {},
    h('section', {},
      h('h3', {}, 'Delivery'),
      card(
        row(permState[0], h('button', {
          class: 'btn small', onclick: async () => {
            const n = await import('./notify.js');
            const ok = await n.askPermission();
            if (ok) await n.subscribePush();
            openSettings('notifications');
          },
        }, Notification.permission === 'granted' ? 'Re-check' : 'Allow')),
        h('div', {}, h('div', { class: 'hint' }, 'Background notifications'), status),
        h('button', {
          class: 'btn small', onclick: async () => {
            try {
              const n = await import('./notify.js');
              await n.subscribePush(true);
              openSettings('notifications');
            } catch (e) { oops(e); }
          },
        }, 'Register this device'))),
    h('section', {},
      h('h3', {}, 'What they say'),
      card(
        row('Preview', selectBox([['full', 'Sender and message'], ['sender_only', 'Sender only'], ['hidden', 'Just “New message”']], s.notif_preview, v => saveSettings({ notif_preview: v }))),
        row('Sound', h('div', { style: { display: 'flex', gap: '6px' } },
          selectBox(soundOptions, s.notif_sound, v => saveSettings({ notif_sound: v })),
          h('button', { class: 'btn small ghost', onclick: async () => (await import('./notify.js')).playSound() }, 'Test'))),
        row('Custom sound', h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', {
            class: 'btn small',
            onclick: () => filePick('audio/*', f => uploadPublic('sounds', f, 'notif_sound')
              .then(() => { toast('Custom sound saved'); openSettings('notifications'); }).catch(oops)),
          }, 'Upload'),
          custom && h('button', {
            class: 'btn small ghost',
            onclick: async () => { await saveSettings({ notif_sound: 'chime' }); openSettings('notifications'); },
          }, 'Remove')),
          'Stored per account, so it plays on every device you sign in on.'))));
}

function focusSection() {
  const s = S.settings;
  return h('div', {}, h('section', {},
    card(
      row('Focus mode', toggle(s.focus_mode, v => saveSettings({ focus_mode: v })),
        'App-wide quiet: no sounds, no notifications, unread counts stay.'),
      row('Quiet hours', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('label', { style: { gap: '2px' } }, 'From',
          h('input', { type: 'time', value: s.quiet_from || '', onchange: e => saveSettings({ quiet_from: e.target.value || null }) })),
        h('label', { style: { gap: '2px' } }, 'To',
          h('input', { type: 'time', value: s.quiet_to || '', onchange: e => saveSettings({ quiet_to: e.target.value || null }) }))),
        'Both empty means quiet hours are off. Applied on this device and by the push function.'))));
}

function privacySection() {
  const s = S.settings;
  const vis = [['everyone', 'Everyone'], ['contacts', 'Contacts'], ['nobody', 'Nobody']];
  return h('div', {},
    h('section', {},
      h('h3', {}, 'Who can see'),
      card(
        row('Last seen', selectBox(vis, s.last_seen_vis, v => saveSettings({ last_seen_vis: v }))),
        row('Online status', selectBox(vis, s.online_vis, v => saveSettings({ online_vis: v }))),
        row('Profile photo', selectBox(vis, s.photo_vis, v => saveSettings({ photo_vis: v }))),
        row('About', selectBox(vis, s.about_vis, v => saveSettings({ about_vis: v }))))),
    h('section', {},
      h('h3', {}, 'Messages'),
      card(
        row('Read receipts', toggle(s.read_receipts, v => saveSettings({ read_receipts: v })), 'Off means you stop sending them. You still see others.'),
        row('Default disappearing', selectBox([[0, 'Off'], [3600, '1 hour'], [86400, '24 hours'], [604800, '7 days'], [7776000, '90 days']], s.default_disappear, v => saveSettings({ default_disappear: +v })), 'Applied to new chats you start.'),
        row('Media size cap', slider(4, 200, 4, s.media_limit_mb, v => saveSettings({ media_limit_mb: v }), v => v + ' MB')))),
    h('section', {},
      h('h3', {}, 'People'),
      h('div', { class: 'set-group' },
        sideAction('ban', 'Blocked list', 'Nobody blocked can post to a chat you share', blockedList))));
}

async function blockedList() {
  const rows = await sel('blocks', { eq: { blocker_id: S.me.id } });
  const ids = rows.map(r => r.blocked_id);
  const people = ids.length ? await rpc('people_info', { p_ids: ids }) : [];
  modal(h('h3', { class: 'display' }, 'Blocked'),
    people.length
      ? h('div', { class: 'card' }, people.map(p => h('div', { class: 'member' },
        h('div', { class: 'av', style: { width: '32px', height: '32px', fontSize: '11px' } }, initials(p.display_name)),
        p.display_name,
        h('button', {
          class: 'role btn small ghost', onclick: async e => {
            try {
              await del('blocks', { blocker_id: S.me.id, blocked_id: p.id });
              e.target.closest('.member').remove(); toast('Unblocked');
            } catch (err) { oops(err); }
          },
        }, 'Unblock'))))
      : h('p', { class: 'hint' }, 'Nobody blocked.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')));
}

async function securitySection() {
  const s = S.settings;
  const { data: keys } = await sb.from('user_keys').select('created_at').eq('user_id', S.me.id).maybeSingle();
  const devices = await sel('devices', { eq: { user_id: S.me.id }, order: ['last_active', 'desc'] });
  const label = d => d.platform === 'webpush' ? 'This kind of browser (push registered)' : d.platform;
  return h('div', {},
    h('section', {},
      h('h3', {}, 'Locks'),
      card(
        row('Two-step PIN', h('button', {
          class: 'btn small', onclick: async () => {
            if (s.two_step_pin) {
              if (await confirmBox('Turn off the PIN?', 'You will only need your password after this.', 'Turn off')) {
                await rpc('set_two_step_pin', { p_pin: null }); S.settings.two_step_pin = null; openSettings('security');
              }
              return;
            }
            const pin = await promptBox('Set a PIN', { type: 'password', label: 'PIN', note: 'Asked when the app loads. Checked with bcrypt in Postgres. It gates this app, not the auth session itself.' });
            if (pin) { await rpc('set_two_step_pin', { p_pin: pin }); S.settings.two_step_pin = 'set'; openSettings('security'); }
          },
        }, s.two_step_pin ? 'On' : 'Off'), 'Asked once when the app loads.'),
        row('Encryption identity', h('small', { class: 'hint' }, keys ? 'created ' + shortWhen(keys.created_at) : 'not created')),
        h('p', { class: 'hint' }, 'Encryption is per chat: an AES-256-GCM chat key wrapped to each member\u2019s RSA key. No forward secrecy, no safety numbers. Encrypted chats are excluded from server-side search and digests.'))),
    h('section', {},
      h('h3', {}, `Devices (${devices.length})`),
      card(devices.length ? devices.map(d => h('div', { class: 'member' },
        h('span', { class: 'sheet-ico', html: icon(d.platform === 'webpush' ? 'globe' : 'monitor', 18) }),
        h('div', {}, h('div', {}, label(d)),
          h('small', { class: 'hint' }, (d.label || '').slice(0, 44)),
          h('small', { class: 'hint' }, 'active ' + shortWhen(d.last_active))),
        h('button', {
          class: 'role btn small ghost',
          onclick: async () => { try { await del('devices', { id: d.id }); openSettings('security'); } catch (e) { oops(e); } },
        }, 'Forget')))
        : h('p', { class: 'hint' }, 'No devices registered for notifications yet.'))),
    h('section', {},
      h('div', { class: 'set-group' },
        sideAction('log-out', 'Log out of all devices', 'Ends every session for this account, including this one', async () => {
          if (await confirmBox('Log out everywhere?', 'Every session for this account ends, including this one.', 'Log out all')) signOutEverywhere();
        }, true))));
}

function accountSection() {
  return h('div', {}, h('section', {},
    h('div', { class: 'set-group' },
      sideAction('down', 'Export my data', 'Everything we hold on you, as JSON', async () => {
        try {
          const data = await rpc('export_my_data');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `wisp-export-${Date.now()}.json` });
          document.body.append(a); a.click(); a.remove();
        } catch (e) { oops(e); }
      }),
      sideAction('log-out', 'Sign out', 'Just this device', signOut),
      sideAction('trash', 'Delete account', 'Profile, memberships and settings go for good', async () => {
        if (!await confirmBox('Delete this account?', 'Profile, memberships and settings go. Message bodies you sent are wiped. This cannot be undone.', 'Delete forever')) return;
        const typed = await promptBox('Type DELETE to confirm');
        if (typed !== 'DELETE') return toast('Not deleted.');
        try { await rpc('delete_my_account'); await sb.auth.signOut(); location.reload(); } catch (e) { oops(e); }
      }, true))));
}

function aboutSection() {
  return h('div', {}, h('section', {},
    h('div', { class: 'profile-hero' },
      h('img', { src: '/assets/wisp-logo.png', alt: 'Wisp', style: { width: '64px' } }),
      h('b', {}, 'Wisp'),
      h('small', { class: 'hint' }, 'A Softronics product')),
    card(
      row('Storage used locally', h('small', { class: 'hint' }, 'cached threads only, cleared on sign out')),
      h('p', { class: 'hint' }, 'Chats are stored in Supabase. Encrypted chats are unreadable server-side. Calls are peer-to-peer over WebRTC, with a STUN/TURN relay only when a direct route cannot be found.'))));
}

/* ── index ────────────────────────────────────────────────── */
const SECTIONS = {
  profile:       { title: 'Profile', glyph: 'user', note: 'Photo, name, about', build: profileSection },
  appearance:    { title: 'Appearance', glyph: 'palette', note: 'Theme, accent, text size, wallpaper', build: appearanceSection },
  notifications: { title: 'Notifications', glyph: 'bell', note: 'Permission, previews, sound', build: notificationsSection },
  focus:         { title: 'Focus', glyph: 'moon', note: 'Focus mode and quiet hours', build: focusSection },
  privacy:       { title: 'Privacy', glyph: 'eye', note: 'Last seen, receipts, blocked list', build: privacySection },
  security:      { title: 'Security', glyph: 'shield-lock', note: 'PIN, encryption identity, devices', build: securitySection },
  accessibility: { title: 'Accessibility', glyph: 'sliders', note: 'Motion, contrast, animation speed', build: accessibilitySection },
  account:       { title: 'Account', glyph: 'key', note: 'Export, sign out, delete', build: accountSection },
  about:         { title: 'About Wisp', glyph: 'info', note: 'How this thing works', build: aboutSection },
};

export async function openSettings(section = null) {
  if (section && SECTIONS[section]) {
    const def = SECTIONS[section];
    let body;
    try { body = await def.build(); } catch (e) { oops(e); return; }
    openSide(sidePanel(def.title, body, { onBack: () => openSettings() }));
    return;
  }

  const me = h('button', {
    class: 'set-row', onclick: () => openSettings('profile'),
  },
    S.me.photo_url
      ? h('img', { class: 'av', src: S.me.photo_url, style: { width: '46px', height: '46px' } })
      : h('div', { class: 'av', style: { width: '46px', height: '46px' } }, initials(S.me.display_name)),
    h('span', { class: 'sheet-label' },
      h('b', {}, S.me.display_name),
      h('small', {}, S.me.about || S.me.email)),
    h('span', { class: 'chev', html: icon('chevron-right', 16) }));

  const group = keys => h('div', { class: 'set-group' },
    keys.map(k => sideAction(SECTIONS[k].glyph, SECTIONS[k].title, SECTIONS[k].note, () => openSettings(k))));

  openSide(sidePanel('Settings', h('div', {},
    h('section', {}, me),
    h('section', {}, h('h3', {}, 'Look and feel'), group(['appearance', 'accessibility'])),
    h('section', {}, h('h3', {}, 'Alerts'), group(['notifications', 'focus'])),
    h('section', {}, h('h3', {}, 'Privacy and security'), group(['privacy', 'security'])),
    h('section', {}, h('h3', {}, 'Account'), group(['account', 'about'])))));
}
