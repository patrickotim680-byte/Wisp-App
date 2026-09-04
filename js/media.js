// Client-side compression + upload. Images are re-encoded to WebP within a max
// edge; video keeps its bytes (browsers can't transcode reliably) but we grab a
// poster frame and enforce the account's size cap.
import { upload, signedUrl } from './db.js';
import { S } from './state.js';
import { uuid, bytes, toast } from './util.js';

const MAX_EDGE = 1600, Q = 0.82;

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

export async function uploadStaged(chatId, item) {
  const ext = (item.name.split('.').pop() || 'bin').toLowerCase().slice(0, 6);
  const base = `${chatId}/${uuid()}`;
  const bucket = item.kind === 'voice' ? 'voice' : 'media';
  const path = `${base}.${item.kind === 'image' ? 'webp' : ext}`;
  await upload(bucket, path, item.blob, item.blob.type);
  let thumb = null;
  if (item.poster) { thumb = `${base}.poster.webp`; await upload(bucket, thumb, item.poster, 'image/webp'); }
  return {
    bucket, path, thumb, name: item.name, mime: item.blob.type || 'application/octet-stream',
    size: item.blob.size, w: item.w || null, h: item.h || null,
    duration: item.duration || null, waveform: item.waveform || null,
  };
}

export const attUrl = a => a?.path ? signedUrl(a.bucket || 'media', a.path) : Promise.resolve(null);
export const thumbUrl = a => a?.thumb ? signedUrl(a.bucket || 'media', a.thumb) : attUrl(a);
