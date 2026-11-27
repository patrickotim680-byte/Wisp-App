// Resumable, parallel, network-adaptive media uploads.
//
// Before this module, media.js's uploadStaged() did one single
// `sb.storage.from(bucket).upload(path, file, ...)` call: the whole file in
// one HTTP PUT, on one TCP stream, with no resume. That has three concrete
// costs, all of which matter most exactly when the person can least afford
// them (a weak or metered connection):
//   - one stream rarely saturates real throughput, so uploads are slower
//     than the link actually allows;
//   - the plain (non-resumable) Storage endpoint caps a single request well
//     below what the `media` bucket itself allows, which is also why a big
//     video upload would sometimes fail outright rather than just go slow;
//   - a dropped connection or a backgrounded tab getting killed (outbox.js's
//     docblock already notes mobile browsers do this aggressively) throws
//     away 100% of the bytes sent so far, not just the interrupted chunk.
//
// This module replaces that single PUT with Supabase Storage's resumable
// (TUS) upload endpoint via tus-js-client: each file is split into chunks,
// several chunks go out concurrently (fewer on a slow/metered link, more on
// a good one — net.js's isSlowNetwork() decides), and an interrupted upload
// resumes from its last confirmed byte. The blob itself is staged into
// IndexedDB first — the same durability move outbox.js makes for message
// text — so resumePendingUploads() can finish the job after a full tab kill
// and reload, not just after a network blip while the tab stayed alive.
import * as tus from 'https://esm.sh/tus-js-client@4.2.2';
import { sb } from './db.js';
import { loadEnv } from './env.js';
import { isSlowNetwork } from './net.js';

const DB_NAME = 'wisp-uploads';
const STORE = 'queue';
let dbPromise = null;

function openDb() {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // no durable upload queue beats a crashed app
  });
  return dbPromise;
}
async function diskPut(entry) {
  const db = await openDb();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}
async function diskDelete(id) {
  const db = await openDb();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}
/** Stamps `extra` onto an already-queued upload's durable record, without
 *  disturbing the transfer in progress. Called from media.js the moment
 *  send() is actually invoked (not at attach-time, when the message's body/
 *  reply/caption aren't decided yet) — so a tab-kill after that point still
 *  has everything resumePendingUploads() needs to finish the send, not just
 *  the raw bytes. */
export async function attachExtra(id, extra) {
  const db = await openDb();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) store.put({ ...req.result, extra }); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

async function diskAll() {
  const db = await openDb();
  if (!db) return [];
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

/* Cross-file concurrency cap: N files in flight at once, each file itself
   further split into parallel chunks by tus below. Uncapped would mean a
   10-photo album opens dozens of simultaneous streams, which congests a weak
   link rather than speeding it up. */
const MAX_CONCURRENT_FILES = 3;
let activeFiles = 0;
const waiters = [];
async function acquireSlot() {
  if (activeFiles < MAX_CONCURRENT_FILES) { activeFiles++; return; }
  await new Promise(r => waiters.push(r));
  activeFiles++;
}
function releaseSlot() {
  activeFiles--;
  const next = waiters.shift();
  if (next) next();
}

/* 6MB matches Supabase's documented resumable-upload chunk size. What we do
   adapt to the link is how many of those chunks go out at once: 1 at a time
   on a slow/metered connection (net.js's isSlowNetwork() — Data Saver or
   2G/3G effectiveType), several at once otherwise. */
const CHUNK_SIZE = 6 * 1024 * 1024;
const parallelism = () => isSlowNetwork() ? 1 : 4;

let envPromise = null;
const getEnv = () => envPromise || (envPromise = loadEnv());

async function authToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || null;
}

function runTus({ bucket, path, blob, contentType, onProgress }) {
  return new Promise(async (resolve, reject) => {
    const env = await getEnv();
    const token = await authToken();
    if (!env || !token) return reject(new Error('Not signed in to a project — cannot upload.'));

    const upload = new tus.Upload(blob, {
      endpoint: `${env.url}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      chunkSize: CHUNK_SIZE,
      parallelUploads: parallelism(),
      removeFingerprintOnSuccess: true,
      headers: { authorization: `Bearer ${token}`, apikey: env.anonKey, 'x-upsert': 'true' },
      uploadDataDuringCreation: true,
      metadata: { bucketName: bucket, objectName: path, contentType: contentType || 'application/octet-stream', cacheControl: '3600' },
      onError: reject,
      onProgress: (sent, total) => onProgress?.(sent, total),
      onSuccess: () => resolve(),
    });
    const previous = await upload.findPreviousUploads().catch(() => []);
    if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
    upload.start();
  });
}

/**
 * Upload one blob to Supabase Storage, resumably and in parallel chunks.
 * Returns immediately with a handle; call `.done` to await completion.
 * `extra` is optional bookkeeping (e.g. the pending chat message this upload
 * belongs to) carried only so resumePendingUploads() can finish the job
 * after a full tab kill — enqueueUpload itself doesn't interpret it.
 */
export function enqueueUpload(bucket, path, blob, contentType, { onProgress, extra } = {}) {
  const id = `${bucket}/${path}`;
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

  (async () => {
    await diskPut({ id, bucket, path, blob, contentType, extra: extra || null, createdAt: Date.now() });
    await acquireSlot();
    try {
      await runTus({ bucket, path, blob, contentType, onProgress });
      await diskDelete(id);
      resolveDone(path);
    } catch (e) {
      // Left on disk on purpose: resumePendingUploads() (run at next boot,
      // same trigger point as outbox.js's initOutbox()) will retry it. A
      // live in-session retry/backoff loop, matching outbox.js's pump(),
      // is the natural next step once this is seen to carry real traffic.
      rejectDone(e);
    } finally { releaseSlot(); }
  })();

  return { id, done };
}

/** Call once at boot, after sign-in. Finishes any upload whose blob survived
 *  a tab kill in IndexedDB but never completed — tus resumes each one from
 *  its last confirmed byte rather than from zero. `onFinish(extra, path)` is
 *  called once a resumed upload completes, so the caller (app.js, via a
 *  dynamic import of composer.js) can send the chat message that was
 *  waiting on it. */
export async function resumePendingUploads(onFinish) {
  const rows = await diskAll();
  for (const row of rows) {
    enqueueResumed(row, onFinish);
  }
}
function enqueueResumed(row, onFinish) {
  (async () => {
    await acquireSlot();
    try {
      await runTus({ bucket: row.bucket, path: row.path, blob: row.blob, contentType: row.contentType });
      await diskDelete(row.id);
      if (row.extra) await onFinish?.(row.extra, row.path);
    } catch {
      // Still on disk; the next boot (or a future live retry loop) tries again.
    } finally { releaseSlot(); }
  })();
}
