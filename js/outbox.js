// Persistent send outbox: what makes "the text gets there" actually true on
// a flaky 2G link instead of just usually true.
//
// Before this module, composer.js's pushMessage() caught a failed insert,
// painted a red "!" on the bubble, and stopped — there was no retry, no
// backoff, and nothing durable: reload the tab (or have it get killed in the
// background, which mobile browsers do aggressively) and the failed message
// was simply gone, with no trace it was ever typed. On a weak connection
// that is the single worst thing a messenger can do, because weak
// connections are exactly where sends fail most.
//
// The fix: every message that fails to insert is written to IndexedDB
// immediately (survives reload/app-kill), then retried with backoff
// whenever the network looks up again. The `messages` table already has
// `unique (sender_id, client_id) where client_id is not null` (see
// schema.sql) specifically so a retried insert that actually *did* land the
// first time (ack lost, not the write) fails with 23505 instead of
// duplicating the message — this module is the first thing that actually
// exploits that guarantee, by treating 23505 on retry as success and
// fetching the row that already exists.
import { sb, ins } from './db.js';
import { S } from './state.js';
import { isOnline, onNetworkChange } from './net.js';

const DB_NAME = 'wisp-outbox';
const STORE = 'queue';
let dbPromise = null;

function openDb() {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'clientId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // no durable outbox is better than a crashed app
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
async function diskDelete(clientId) {
  const db = await openDb();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(clientId);
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

// In-memory mirror of the disk queue, keyed by clientId, for synchronous
// reads (mergeIntoThread needs to run inline with render, not after an
// IndexedDB round trip).
const mem = new Map();
let started = false;
let pumping = false;

/** Call once at boot (after state/db are ready). Pulls any messages left
 *  over from a previous session back into memory and starts the retry loop
 *  — so a message typed right before the tab died still goes out once the
 *  app restarts and sees a connection. */
export async function initOutbox() {
  if (started) return;
  started = true;
  const rows = await diskAll();
  rows.forEach(r => mem.set(r.clientId, r));
  onNetworkChange(() => pump());
  setInterval(pump, 4000); // backstop: 'online' doesn't always fire on a radio that's merely congested, not truly down
  pump();
}

function backoff(attempts) {
  return Math.min(30000, 1000 * 2 ** attempts); // 1s, 2s, 4s, 8s, ... capped at 30s
}

/** Queue a message whose insert just failed. `row` is exactly what would
 *  have been passed to ins('messages', row) (already sealed, if e2ee).
 *  `displayBody` is the plaintext shown in the optimistic bubble (null for
 *  e2ee, since row.body is null and the ciphertext isn't the display text). */
export function enqueue(tempId, displayBody, row) {
  const entry = { clientId: row.client_id, tempId, chatId: row.chat_id, row, displayBody, attempts: 0, nextAt: Date.now() + 1200, createdAt: Date.now() };
  mem.set(entry.clientId, entry);
  diskPut(entry);
  setTimeout(pump, 1200);
  return entry;
}

function applySuccess(entry, saved) {
  mem.delete(entry.clientId);
  diskDelete(entry.clientId);
  if (S.chat?.chat_id === entry.chatId) {
    const i = S.msgs.findIndex(m => m.id === entry.tempId || m.client_id === entry.clientId);
    if (i >= 0) S.msgs[i] = { ...saved, body: entry.displayBody ?? saved.body };
    // thread.js isn't imported statically here to avoid a module cycle
    // (thread.js dynamic-imports this module for tap-to-retry) — lazy import
    // costs nothing once the app is already running.
    import('./thread.js').then(({ renderThread }) => renderThread(false));
  }
}

async function attempt(entry) {
  try {
    const [saved] = await ins('messages', entry.row);
    applySuccess(entry, saved);
    return true;
  } catch (e) {
    if (e?.code === '23505') {
      // Unique (sender_id, client_id) tripped: the earlier attempt actually
      // landed, only its response got lost. Fetch the row that's already
      // there instead of telling the person their message failed twice.
      try {
        const { data } = await sb.from('messages').select('*').eq('client_id', entry.row.client_id).eq('sender_id', entry.row.sender_id).single();
        if (data) { applySuccess(entry, data); return true; }
      } catch { /* fall through to normal backoff */ }
    }
    entry.attempts++;
    entry.nextAt = Date.now() + backoff(entry.attempts);
    mem.set(entry.clientId, entry);
    diskPut(entry);
    if (S.chat?.chat_id === entry.chatId) {
      const i = S.msgs.findIndex(m => m.id === entry.tempId || m.client_id === entry.clientId);
      if (i >= 0) { S.msgs[i] = { ...S.msgs[i], pendingSend: false, failed: true }; import('./thread.js').then(({ renderThread }) => renderThread(false)); }
    }
    return false;
  }
}

async function pump() {
  if (pumping || !isOnline()) return;
  pumping = true;
  try {
    const now = Date.now();
    for (const entry of [...mem.values()]) {
      if (entry.nextAt > now) continue;
      await attempt(entry);
    }
  } finally { pumping = false; }
}

/** Tap-to-retry: jump the queue regardless of backoff. */
export function retryNow(clientId) {
  const entry = mem.get(clientId);
  if (!entry) return;
  entry.nextAt = 0;
  if (S.chat?.chat_id === entry.chatId) {
    const i = S.msgs.findIndex(m => m.client_id === clientId);
    if (i >= 0) { S.msgs[i] = { ...S.msgs[i], pendingSend: true, failed: false }; import('./thread.js').then(({ renderThread }) => renderThread(false)); }
  }
  pump();
}

/** Called right after a chat's real history has loaded, so any message that
 *  failed (or was still queued) before a reload reappears in place instead
 *  of silently vanishing. */
export function mergeIntoThread(chatId) {
  let added = false;
  for (const entry of mem.values()) {
    if (entry.chatId !== chatId) continue;
    if (S.msgs.some(m => m.id === entry.tempId || m.client_id === entry.clientId)) continue;
    S.msgs.push({
      ...entry.row, id: entry.tempId, created_at: new Date(entry.createdAt || Date.now()).toISOString(),
      body: entry.displayBody, pendingSend: entry.attempts === 0, failed: entry.attempts > 0,
    });
    added = true;
  }
  if (added) S.msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return added;
}

export const isQueued = clientId => mem.has(clientId);
