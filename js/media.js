// Client-side compression + upload. Images are re-encoded to WebP within a max
// edge; video keeps its bytes (browsers can't transcode reliably) but we grab a
// poster frame and enforce the account's size cap.
//
// Private media
// ─────────────
// An attachment sent in a conversation that lives in Private Vault is encrypted
// in the browser before it is uploaded, with that conversation's AES-256-GCM
// end-to-end key — the same key its message bodies use, wrapped per member with
// their RSA key, which the server never sees unwrapped. So object storage holds
// ciphertext: a signed URL for private media returns bytes nobody can open
// without being a member of the conversation *and* holding the key.
//
// Reading goes the other way: fetch, decrypt in memory, hand out a blob: URL
// that vault.js tracks and revokes the instant the vault locks. Decrypted bytes
// are cached, but only inside the vault's encrypted store — never in the plain
// browser HTTP cache and never in a plain IndexedDB record.
//
// This applies from the moment a conversation is vaulted, exactly like the
// existing encryption toggle: media sent before that keeps whatever state it
// had. Nothing rewrites history behind your back.
import { upload, signedUrl } from './db.js';
import { S } from './state.js';
import { uuid, bytes, toast } from './util.js';
import { isVaulted, getVaultBlob, setVaultBlob, trackedBlobUrl } from './vault.js';
import { chatKey } from './crypto.js';

const MAX_EDGE = 1600, Q = 0.82;

const b64 = buf => {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function compressImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return { blob: file, w: 0, h: 0 };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
  const cv = new OffscreenCanvas(w, hgt);
  cv.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
  const blob = await cv.convertToBlob({ type: 'image/webp', quality: Q });
  bmp.close();
  return blob.size < file.size ? { blob, w, h: hgt } : { blob: file, w: bmp.width, h: bmp.height };
}

export async function videoPoster(file) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.src = URL.createObjectURL(file);
    v.onloadeddata = async () => {
      try {
        v.currentTime = Math.min(0.6, (v.duration || 1) / 3);
        await new Promise(r => v.onseeked = r);
        const cv = new OffscreenCanvas(Math.min(640, v.videoWidth), Math.round(Math.min(640, v.videoWidth) * v.videoHeight / v.videoWidth));
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        const blob = await cv.convertToBlob({ type: 'image/webp', quality: 0.7 });
        res({ poster: blob, duration: v.duration, w: v.videoWidth, h: v.videoHeight });
      } catch { res({ poster: null, duration: v.duration || 0 }); }
      URL.revokeObjectURL(v.src);
    };
    v.onerror = () => res({ poster: null, duration: 0 });
  });
}

export function kindFor(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

export async function stageFile(file) {
  const cap = (S.settings?.media_limit_mb || 64) * 1048576;
  if (file.size > cap) { toast(`${file.name} is ${bytes(file.size)}, over your ${S.settings.media_limit_mb} MB limit.`, true); return null; }
  const kind = kindFor(file);
  const item = { id: uuid(), file, kind, name: file.name, caption: '', viewOnce: false };
  if (kind === 'image') {
    const { blob, w, h } = await compressImage(file);
    item.blob = blob; item.w = w; item.h = h;
    item.previewUrl = URL.createObjectURL(blob);
  } else if (kind === 'video') {
    const { poster, duration, w, h } = await videoPoster(file);
    item.blob = file; item.poster = poster; item.duration = duration; item.w = w; item.h = h;
    item.previewUrl = URL.createObjectURL(poster || file);
  } else {
    item.blob = file;
  }
  return item;
}

/* ── private-media encryption ──────────────────────────────────────────── */

// The conversation's shared end-to-end key, not the vault's local key. It has
// to be the shared one: the person on the other side needs to open the photo,
// and the vault key never leaves this device (by design — see
// docs/PRIVATE-VAULT.md on why vault key material is not synchronised).
async function mediaKey(chatId) {
  const memberIds = S.members?.length ? S.members.map(m => m.user_id) : [];
  return chatKey(chatId, memberIds);
}

async function sealBytes(chatId, blob) {
  const key = await mediaKey(chatId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await blob.arrayBuffer());
  return { blob: new Blob([ct], { type: 'application/octet-stream' }), iv: b64(iv) };
}

export async function uploadStaged(chatId, item) {
  const ext = (item.name.split('.').pop() || 'bin').toLowerCase().slice(0, 6);
  const base = `${chatId}/${uuid()}`;
  const bucket = item.kind === 'voice' ? 'voice' : 'media';
  const path = `${base}.${item.kind === 'image' ? 'webp' : ext}`;
  const priv = isVaulted(chatId);

  let body = item.blob, enc = null, posterBody = item.poster, posterEnc = null;
  if (priv) {
    const sealed = await sealBytes(chatId, item.blob);
    body = sealed.blob; enc = { alg: 'AES-GCM', iv: sealed.iv, v: 1 };
    if (item.poster) {
      const sp = await sealBytes(chatId, item.poster);
      posterBody = sp.blob; posterEnc = { alg: 'AES-GCM', iv: sp.iv, v: 1 };
    }
  }

  // Upload the ciphertext as an opaque octet-stream when private, so the stored
  // content type does not describe the plaintext either.
  await upload(bucket, path, body, priv ? 'application/octet-stream' : (item.blob.type || undefined));
  let thumb = null;
  if (posterBody) {
    thumb = `${base}.poster.webp`;
    await upload(bucket, thumb, posterBody, priv ? 'application/octet-stream' : 'image/webp');
  }
  return {
    bucket, path, thumb, name: item.name,
    mime: item.blob.type || 'application/octet-stream',
    size: item.blob.size, w: item.w || null, h: item.h || null,
    duration: item.duration || null, waveform: item.waveform || null,
    noise_level: item.noiseLevel || null,
    enc, thumb_enc: posterEnc,
  };
}

// chat id is the first path segment by the storage path convention
// (media/<chat_id>/<uuid>.<ext>), so a decrypt does not need the open chat.
const chatIdOf = a => String(a?.path || '').split('/')[0] || null;

async function openSealed(a, { thumb = false } = {}) {
  const bucket = a.bucket || 'media';
  const path = thumb ? a.thumb : a.path;
  const box = thumb ? a.thumb_enc : a.enc;
  const cacheKey = bucket + '/' + path;
  const mime = thumb ? 'image/webp' : (a.mime || 'application/octet-stream');

  const hit = await getVaultBlob(cacheKey);
  if (hit) return trackedBlobUrl(hit);

  const url = await signedUrl(bucket, path);
  const res = await fetch(url);
  if (!res.ok) throw new Error('That file could not be fetched.');
  const ct = await res.arrayBuffer();
  const key = await mediaKey(chatIdOf(a));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, ct);
  await setVaultBlob(cacheKey, pt, mime);
  return trackedBlobUrl(new Blob([pt], { type: mime }));
}

/**
 * A URL the UI can point an <img>/<video>/<audio> at.
 *
 * Plain attachment: a signed storage URL, as before.
 * Private attachment: a blob: URL over bytes decrypted in this tab, tracked by
 * vault.js so it dies the moment the vault locks. There is no code path that
 * produces a working URL for private media while the vault is locked.
 */
export async function attUrl(a) {
  if (!a?.path) return null;
  if (a.enc) return openSealed(a);
  return signedUrl(a.bucket || 'media', a.path);
}

export async function thumbUrl(a) {
  if (!a) return null;
  if (a.thumb && a.thumb_enc) return openSealed(a, { thumb: true });
  if (a.thumb) return signedUrl(a.bucket || 'media', a.thumb);
  return attUrl(a);
}
