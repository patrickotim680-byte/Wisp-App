// Local, per-device message cache — two layers.
//
//   mem   (Map, synchronous)  — what makes chat-open feel instant. Reading
//                               it costs nothing: no promise, no I/O, no
//                               event loop hop.
//   IndexedDB (async, on disk) — survives reloads/app restarts so the first
//                               chat you open in a new session still has
//                               something better than blank to show.
//
// loadChats() calls warmCache() the moment the chat list is known, which
// pulls every chat's last-known thread up from IndexedDB into `mem` in the
// background. By the time a human actually taps a row, `mem` has almost
// always already caught up — so openChat() can read it synchronously and
// paint before the very first frame, with no async gap at all. That's the
// difference between "instant" and "instant-ish": WhatsApp's client works
// the same way, keeping its local store warm in memory rather than hitting
// disk fresh on every chat open.

const DB_NAME = 'wisp-cache';
const STORE = 'threads';
const VERSION = 1;

const mem = new Map(); // chatId -> payload

/** Synchronous, zero-latency read. Returns null if not warmed yet. */
export function getMemThread(chatId) {
  return mem.get(chatId) || null;
}

let dbPromise = null;
function openDb() {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => { req.result.objectStoreNames.contains(STORE) || req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    // A broken/unavailable IndexedDB should never block chat from working —
    // it just means this session runs without the disk-backed cache.
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

function readDisk(chatId) {
  return openDb().then(db => {
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(chatId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  });
}

export async function getCachedThread(chatId) {
  if (mem.has(chatId)) return mem.get(chatId);
  const payload = await readDisk(chatId);
  if (payload) mem.set(chatId, payload);
  return payload;
}

export async function setCachedThread(chatId, payload) {
  mem.set(chatId, payload); // instantly available for the rest of this session
  const db = await openDb();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(payload, chatId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

/**
 * Fire-and-forget prefetch of every chat's disk cache into `mem`. Call this
 * once the chat list is known (right after login, and after every
 * loadChats() refresh) — NOT when a chat is tapped, since the whole point
 * is for the warm-up to already be done by then.
 */
export function warmCache(chatIds) {
  chatIds.forEach(id => { if (!mem.has(id)) readDisk(id).then(p => { if (p) mem.set(id, p); }); });
}
