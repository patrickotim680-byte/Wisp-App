// Local, per-device message cache (IndexedDB).
//
// This is the piece that makes opening a chat feel instant instead of
// "loading a webpage": the very first thing loadMessages() does is paint
// whatever we already have on disk for that chat, with zero network round
// trips. The real data is fetched right after and reconciled in, same as
// WhatsApp's own client keeps a local store it trusts first and syncs
// after. Nothing here replaces the server as the source of truth — it's
// purely a "what did this chat look like last time" snapshot.

const DB_NAME = 'wisp-cache';
const STORE = 'threads';
const VERSION = 1;

let dbPromise = null;
function openDb() {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => { req.result.objectStoreNames.contains(STORE) || req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    // A broken/unavailable IndexedDB should never block chat from working —
    // it just means this session runs without the instant-paint cache.
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function getCachedThread(chatId) {
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(chatId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function setCachedThread(chatId, payload) {
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
