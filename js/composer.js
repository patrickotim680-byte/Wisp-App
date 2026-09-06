import { sb, rpc, ins, upd, del } from './db.js';
import { S, person, nameOf } from './state.js';
import { $, h, clear, toast, oops, modal, closeModal, promptBox, uuid, dur, debounce, icon, iconEl, initials } from './util.js';
import { stageFile, uploadStaged } from './media.js';
import { sealBody } from './crypto.js';
import { renderThread, appendMessage } from './thread.js';
import { unlockKeysInteractive } from './auth.js';

const input = () => $('#input');

/* ── sending ───────────────────────────────────────────────────────────── */
export async function send() {
  const chat = S.chat;
  if (!chat) return;
  const text = input().value.trim();
  if (!text && !S.pending.length) return;

  const staged = S.pending.splice(0);
  input().value = ''; autosize();
  const reply = S.replyTo?.id || null;
  S.replyTo = null; $('#reply-chip').hidden = true;
  renderAttachRow();

  try {
    if (staged.length) {
      for (let i = 0; i < staged.length; i++) {
        const item = staged[i];
        const att = await uploadStaged(chat.chat_id, item);
        await pushMessage({
          kind: item.kind, body: i === 0 ? (text || item.caption || null) : (item.caption || null),
          attachment: att, reply_to: i === 0 ? reply : null, view_once: !!item.viewOnce,
        });
      }
    } else {
      await pushMessage({ kind: 'text', body: text, reply_to: reply });
    }
  } catch (e) { oops(e); }
}

export async function pushMessage(base) {
  const chat = S.chat;
  const clientId = uuid();

  // broadcast list: fan out to individual DMs so replies stay private
  if (chat.type === 'broadcast') {
    const targets = S.members.filter(m => m.user_id !== S.me.id).map(m => m.user_id);
    for (const uid of targets) {
      const dm = await rpc('get_or_create_dm', { p_other: uid });
      await ins('messages', { ...base, chat_id: dm, sender_id: S.me.id, client_id: uuid() });
    }
    await ins('messages', {
      chat_id: chat.chat_id, sender_id: S.me.id, kind: 'system',
      body: `Broadcast to ${targets.length}: ${(base.body || '[media]').slice(0, 80)}`,
    });
    toast(`Sent to ${targets.length} chats.`);
    return;
  }

  let row = { ...base, chat_id: chat.chat_id, sender_id: S.me.id, client_id: clientId };

  if (chat.e2ee && row.body) {
    if (!S.keys && !await unlockKeysInteractive()) return toast('Encryption key locked, message not sent.', true);
    const memberIds = S.members.map(m => m.user_id);
    const { cipher, iv } = await sealBody(chat.chat_id, memberIds, row.body);
    row = { ...row, cipher, iv, body: null };
  }

  // optimistic bubble
  const temp = { ...row, id: 'tmp-' + clientId, created_at: new Date().toISOString(), pendingSend: true, body: base.body };
  S.msgs.push(temp);
  renderThread(true);

  try {
    const [saved] = await ins('messages', row);
    const i = S.msgs.findIndex(m => m.id === temp.id);
    if (i >= 0) S.msgs[i] = { ...saved, body: base.body ?? saved.body };
    renderThread(false);
  } catch (e) {
    temp.pendingSend = false; temp.failed = true;
    renderThread(false);
    throw e;
  }
}

/* ── typing ────────────────────────────────────────────────────────────── */
const ping = debounce(() => { if (S.chat) rpc('set_typing', { p_chat: S.chat.chat_id }).catch(() => {}); }, 900);

function autosize() {
  const el = input();
  el.style.height = 'auto';
  el.style.height = Math.min(180, el.scrollHeight) + 'px';
}

/* ── attachments ───────────────────────────────────────────────────────── */
export function renderAttachRow() {
  const row = $('#attach-row');
  row.hidden = !S.pending.length;
  clear(row);
  S.pending.forEach(item => {
    const thumb = h('div', { class: 'attach-thumb' },
      item.previewUrl ? h('img', { src: item.previewUrl, alt: '' })
        : h('div', { class: 'doc-glyph', style: { width: '100%', height: '100%' } }, (item.name.split('.').pop() || '?').toUpperCase()),
      h('button', { title: 'Remove', onclick: () => { S.pending = S.pending.filter(x => x !== item); renderAttachRow(); } }, '✕'));
    if (item.kind === 'image' || item.kind === 'video') {
      thumb.onclick = () => { item.viewOnce = !item.viewOnce; thumb.style.outline = item.viewOnce ? '2px solid var(--accent)' : 'none'; toast(item.viewOnce ? 'View once on' : 'View once off'); };
      thumb.title = 'Click to toggle view-once';
    }
    row.append(thumb);
  });
  if (S.pending.length) row.append(h('small', { class: 'hint' }, 'Caption goes in the message box. Click a photo to make it view-once.'));
}

async function pickFiles(accept, capture) {
  const el = $('#file-input');
  el.accept = accept || '';
  if (capture) el.setAttribute('capture', capture); else el.removeAttribute('capture');
  el.click();
}

function attachMenu() {
  const item = (label, fn) => h('button', { class: 'btn', onclick: () => { closeModal(); fn(); } }, label);
  modal(h('h3', { class: 'display' }, 'Attach'), h('div', { class: 'stack' },
    item('Photos & videos', () => pickFiles('image/*,video/*')),
    item('Camera', () => pickFiles('image/*', 'environment')),
    item('Document', () => pickFiles('')),
    item('Location', shareLocation),
    item('Contact card', shareContact),
    item('Poll', createPoll),
    item('Sticker', stickerPicker)));
}

const STICKERS = ['🫠', '🙃', '🫡', '🤌', '🐈', '🌵', '🍜', '☕️', '🛟', '🧊', '🪩', '📮', '🛼', '🧃', '🪴', '🫧'];
function stickerPicker() {
  modal(h('h3', { class: 'display' }, 'Stickers'),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' } },
      STICKERS.map(s => h('button', { class: 'btn ghost', style: { fontSize: '34px' }, onclick: async () => { closeModal(); await pushMessage({ kind: 'sticker', body: s }); } }, s))));
}

async function shareLocation() {
  if (!navigator.geolocation) return toast('No geolocation in this browser.', true);
  const live = await new Promise(res => modal(h('h3', { class: 'display' }, 'Share location'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn', onclick: () => { closeModal(); res(0); } }, 'Send current pin'),
      h('button', { class: 'btn', onclick: () => { closeModal(); res(15); } }, 'Live for 15 minutes'),
      h('button', { class: 'btn', onclick: () => { closeModal(); res(60); } }, 'Live for 1 hour'))));
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const expires = live ? new Date(Date.now() + live * 60000).toISOString() : null;
    const before = S.msgs.length;
    await pushMessage({ kind: 'location', meta: { lat, lng, live: !!live, expires_at: expires } });
    const m = S.msgs.at(-1);
    if (!m?.id || String(m.id).startsWith('tmp-')) return;
    await ins('live_locations', { message_id: m.id, lat, lng, live: !!live, expires_at: expires });
    if (live) {
      const watch = navigator.geolocation.watchPosition(async p => {
        try { await upd('live_locations', { lat: p.coords.latitude, lng: p.coords.longitude, updated_at: new Date().toISOString() }, { message_id: m.id }); } catch {}
      }, () => {}, { enableHighAccuracy: true });
      setTimeout(() => navigator.geolocation.clearWatch(watch), live * 60000);
      toast(`Live location on for ${live} min.`);
    }
  }, e => toast(e.message, true), { enableHighAccuracy: true });
}

async function shareContact() {
  const q = await promptBox('Share a contact', { label: 'Search name or email' });
  if (!q) return;
  const rows = await rpc('search_people', { p_query: q });
  if (!rows.length) return toast('Nobody matched.', true);
  modal(h('h3', { class: 'display' }, 'Pick a contact'), h('div', { class: 'stack' },
    rows.map(r => h('button', {
      class: 'btn', onclick: async () => {
        closeModal();
        await pushMessage({ kind: 'contact', meta: { name: r.display_name, user_id: r.id } });
      },
    }, r.display_name))));
}

async function createPoll() {
  const qIn = h('input', { placeholder: 'Question' });
  const opts = [h('input', { placeholder: 'Option 1' }), h('input', { placeholder: 'Option 2' })];
  const box = h('div', { class: 'stack' }, ...opts);
  const multi = h('input', { type: 'checkbox' });
  modal(h('h3', { class: 'display' }, 'New poll'), h('label', {}, 'Question', qIn), box,
    h('button', { class: 'btn small ghost', onclick: () => { const i = h('input', { placeholder: 'Option ' + (opts.length + 1) }); opts.push(i); box.append(i); } }, '+ Option'),
    h('label', { class: 'member' }, multi, 'Allow multiple answers'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const labels = opts.map(i => i.value.trim()).filter(Boolean);
          if (!qIn.value.trim() || labels.length < 2) return toast('Need a question and two options.', true);
          closeModal();
          try {
            const [m] = await ins('messages', {
              chat_id: S.chat.chat_id, sender_id: S.me.id, kind: 'poll',
              body: qIn.value.trim(), meta: { question: qIn.value.trim() },
            });
            const [poll] = await ins('polls', { message_id: m.id, question: qIn.value.trim(), multi: multi.checked });
            await ins('poll_options', labels.map((label, position) => ({ poll_id: poll.id, label, position })));
            renderThread(true);
          } catch (e) { oops(e); }
        },
      }, 'Post')));
}

/* ── voice notes ───────────────────────────────────────────────────────── */
let rec = null;
async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
    const chunks = [], peaks = [];
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const cv = $('#rec-wave');
    $('#rec-strip').hidden = false;
    rec = { mr, stream, chunks, peaks, ctx, t0: Date.now(), pausedAt: 0, pausedTotal: 0, paused: false };
    setPauseUI(false);
    const tick = () => {
      if (!rec) return;
      if (!rec.paused) {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
        peaks.push(Math.min(1, peak * 1.6));
        $('#rec-time').textContent = dur((Date.now() - rec.t0 - rec.pausedTotal) / 1000);
      }
      const w = cv.width = cv.clientWidth, hh = cv.height = 28;
      const g = cv.getContext('2d');
      g.clearRect(0, 0, w, hh);
      g.fillStyle = getComputedStyle(document.body).getPropertyValue(rec.paused ? '--ink-2' : '--accent');
      const show = peaks.slice(-Math.floor(w / 3));
      show.forEach((v, i) => { const bh = Math.max(2, v * hh); g.fillRect(i * 3, (hh - bh) / 2, 2, bh); });
      requestAnimationFrame(tick);
    };
    mr.ondataavailable = e => chunks.push(e.data);
    mr.start(120);
    requestAnimationFrame(tick);
  } catch (e) { oops(e); }
}
function toggleRecPause() {
  if (!rec || rec.mr.state === 'inactive') return;
  if (rec.paused) {
    rec.mr.resume();
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.paused = false;
  } else {
    rec.mr.pause();
    rec.pausedAt = Date.now();
    rec.paused = true;
  }
  setPauseUI(rec.paused);
}
function setPauseUI(isPaused) {
  const btn = $('#rec-pause');
  if (btn) { btn.innerHTML = icon(isPaused ? 'play' : 'pause', 16); btn.title = isPaused ? 'Resume' : 'Pause'; }
  $('#rec-dot')?.classList.toggle('paused', isPaused);
}
async function stopRec(sendIt) {
  if (!rec) return;
  const { mr, stream, chunks, peaks, t0, ctx, pausedTotal, paused, pausedAt } = rec;
  rec = null;
  $('#rec-strip').hidden = true;
  const finalPausedTotal = pausedTotal + (paused ? Date.now() - pausedAt : 0);
  await new Promise(r => { if (mr.state === 'inactive') return r(); mr.onstop = r; mr.stop(); });
  stream.getTracks().forEach(t => t.stop());
  ctx.close();
  if (!sendIt) return;
  const blob = new Blob(chunks, { type: mr.mimeType });
  const duration = (Date.now() - t0 - finalPausedTotal) / 1000;
  if (duration < 0.4) return toast('Too short.');
  const step = Math.max(1, Math.floor(peaks.length / 48));
  const wave = [];
  for (let i = 0; i < peaks.length; i += step) wave.push(+peaks.slice(i, i + step).reduce((a, b) => Math.max(a, b), 0).toFixed(2));
  try {
    const att = await uploadStaged(S.chat.chat_id, { kind: 'voice', blob, name: 'voice.webm', duration, waveform: wave });
    await pushMessage({ kind: 'voice', attachment: att });
  } catch (e) { oops(e); }
}

/* ── emoji + mentions ──────────────────────────────────────────────────── */
const EMOJI_SET = ['😀','😂','🥲','😊','😍','😘','🤔','🫡','😴','🤒','🥳','😎','🤝','👍','👎','🙏','👏','💪','🔥','✨','🎉','❤️','🧡','💜','🖤','💔','☕️','🍕','🎧','🚀','🌧','🌈','📌','✅','❌','⏳','💡','📎','🐈','🐕'];
function emojiPop() {
  const shell = $('.input-shell');
  const old = shell.querySelector('.emoji-pop');
  if (old) return old.remove();
  const pop = h('div', { class: 'emoji-pop' }, EMOJI_SET.map(e => h('button', {
    onclick: () => { insertAtCursor(e); pop.remove(); },
  }, e)));
  shell.append(pop);
}
function insertAtCursor(txt) {
  const el = input(), p = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, p) + txt + el.value.slice(el.selectionEnd ?? p);
  el.focus(); el.selectionStart = el.selectionEnd = p + txt.length;
  autosize();
}

function mentionUI() {
  const el = input(), pop = $('#mention-pop');
  const upto = el.value.slice(0, el.selectionStart);
  const m = /@(\w*)$/.exec(upto);
  if (!m || S.chat?.type === 'dm') { pop.hidden = true; return; }
  const q = m[1].toLowerCase();
  const cands = S.members.filter(x => x.user_id !== S.me.id)
    .map(x => person(x.user_id)).filter(p => p && p.display_name.toLowerCase().replace(/\s/g, '').includes(q)).slice(0, 6);
  if (!cands.length) { pop.hidden = true; return; }
  pop.hidden = false;
  clear(pop).append(cands.map(p => h('button', {
    onclick: () => {
      const handle = p.display_name.replace(/\s/g, '');
      el.value = el.value.slice(0, el.selectionStart - m[1].length - 1) + '@' + handle + ' ' + el.value.slice(el.selectionStart);
      pop.hidden = true; el.focus(); autosize();
    },
  }, h('div', { class: 'av', style: { width: '24px', height: '24px', fontSize: '10px' } }, initials(p.display_name)), p.display_name)));
}

/* ── scheduled send ────────────────────────────────────────────────────── */
function scheduleDialog() {
  const text = input().value.trim();
  const when = h('input', { type: 'datetime-local', value: new Date(Date.now() + 3600e3).toISOString().slice(0, 16) });
  const rep = h('select', {}, h('option', { value: '' }, 'Once'), h('option', { value: 'daily' }, 'Daily'),
    h('option', { value: 'weekdays' }, 'Weekdays'), h('option', { value: 'weekly' }, 'Weekly'));
  const body = h('textarea', { rows: 3 }); body.value = text;
  modal(h('h3', { class: 'display' }, 'Schedule this message'),
    h('p', { class: 'hint' }, 'Row lives in scheduled_messages, which RLS hides from the recipient until the dispatcher sends it.'),
    h('label', {}, 'Message', body), h('label', {}, 'Send at', when), h('label', {}, 'Repeat', rep),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          if (!body.value.trim()) return toast('Nothing to schedule.', true);
          try {
            await ins('scheduled_messages', {
              chat_id: S.chat.chat_id, sender_id: S.me.id, kind: 'text',
              body: body.value.trim(), send_at: new Date(when.value).toISOString(),
              recurrence: rep.value || null,
            });
            closeModal(); input().value = ''; autosize(); toast('Scheduled.');
          } catch (e) { oops(e); }
        },
      }, 'Schedule')));
}

export function mountComposer() {
  const el = input();
  el.addEventListener('input', () => { autosize(); ping(); mentionUI(); });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape') { S.replyTo = null; $('#reply-chip').hidden = true; $('#mention-pop').hidden = true; }
  });
  $('#btn-send').onclick = send;
  $('#btn-attach').onclick = attachMenu;
  $('#btn-emoji').onclick = emojiPop;
  $('#btn-schedule').onclick = scheduleDialog;

  const mic = $('#btn-mic');
  mic.addEventListener('pointerdown', startRec);
  mic.addEventListener('pointerup', () => { if (rec) toast('Recording. Use Send or Discard.'); });
  $('#rec-pause').onclick = toggleRecPause;
  $('#rec-send').onclick = () => stopRec(true);
  $('#rec-cancel').onclick = () => stopRec(false);

  $('#file-input').onchange = async e => {
    for (const f of e.target.files) { const item = await stageFile(f); if (item) S.pending.push(item); }
    e.target.value = '';
    renderAttachRow();
  };
  const thread = $('#thread');
  thread.addEventListener('dragover', e => { e.preventDefault(); });
  thread.addEventListener('drop', async e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) { const item = await stageFile(f); if (item) S.pending.push(item); }
    renderAttachRow();
  });
  document.addEventListener('paste', async e => {
    if (!S.chat) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    for (const f of files) { const item = await stageFile(f); if (item) S.pending.push(item); }
    renderAttachRow();
  });
}
