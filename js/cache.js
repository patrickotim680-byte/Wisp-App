// Local, per-device message cache — two layers.
//
//   mem   (Map, synchronous)  — what makes chat-open feel instant. Reading
//                               it costs nothing: no promise, no I/O, no
//                               event loop hop.
//   IndexedDB (async, on disk) — survives reloads/app restarts so the first
//                               chat you open in a new session still has
//                               something better than blank to show.
//
// main() calls warmAllCached() as the very first thing on boot — before
// login even resolves — to pull every thread this device has ever cached
// up from IndexedDB into `mem`. loadChats() also calls warmCache() once the
// chat list is known, as a fallback covering any chat that bulk warm-up
// somehow missed. Either way, by the time a human actually taps a row,
// `mem` has almost always already caught up — so openChat() can read it
// synchronously and paint before the very first frame, with no async gap
// at all. That's the difference between "instant" and "instant-ish":
// WhatsApp's client works the same way, keeping its local store warm in
// memory rather than hitting disk fresh on every chat open.

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

/**
 * Fire-and-forget bulk warm-up: pulls *every* thread this device has ever
 * cached straight off disk into `mem`, in one transaction — no chat list
 * required. warmCache() above can only start once loadChats()'s network
 * round trip answers with which chats exist, which on a fresh sign-in is
 * after loadMe()/loadFolders() have already made their own round trips too.
 * A human still needs to see the chat list render and tap a row after all
 * of that, which is normally enough slack for warmCache() to win its race —
 * but there's no reason to leave it racing anything. This has zero
 * dependency on auth or the network, so call it as the very first thing on
 * boot: by the time the sign-in round trips above even finish, `mem` is
 * almost certainly already fully warm, and the first chat you tap after
 * signing back in is just as instant as switching chats mid-session.
 */
export function warmAllCached() {
  return openDb().then(db => new Promise(resolve => {
    if (!db) return resolve();
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.onerror = () => resolve();
      tx.oncomplete = () => {
        const keys = keysReq.result || [], vals = valsReq.result || [];
        keys.forEach((id, i) => { if (!mem.has(id) && vals[i]) mem.set(id, vals[i]); });
        resolve();
      };
    } catch { resolve(); }
  }));
}
