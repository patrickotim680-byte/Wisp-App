// ── Wisp Private Vault — local security core ────────────────────────────
//
// This module is the security boundary. Nothing above it is trusted to keep a
// secret: the UI can only ask for a key, and it only gets one while the vault
// is unlocked, in this document's memory.
//
// What it actually does
// ─────────────────────
//   • A Vault Master Key (VMK): 32 bytes from crypto.getRandomValues. It is
//     never written anywhere in the clear.
//   • The VMK is wrapped with AES-256-GCM under a key derived from the vault
//     code with PBKDF2-SHA-256 (600k iterations, 16-byte random salt). Only
//     the wrap is stored, in IndexedDB, on this device. The code itself is
//     never stored — not raw, not hashed, not on the server. A wrong code just
//     fails GCM authentication, so there is no separate verifier to grind.
//   • Optionally a second wrap of the same VMK under a key derived from a
//     WebAuthn PRF secret: a secret only this device's platform authenticator
//     can produce, and only after a successful biometric / device-credential
//     check. Where the browser has no PRF extension we do not ship a weaker
//     imitation — see biometricSupport() for why.
//   • Per-conversation keys come from HKDF-SHA-256 over the VMK with the
//     conversation id as `info`, so each private conversation's local data is
//     encrypted under its own key with nothing extra to store.
//   • Vault-protected local storage is a separate IndexedDB database in which
//     every record is AES-GCM ciphertext. The normal message cache
//     (js/cache.js, `wisp-cache`) never holds a private conversation.
//   • Every record is namespaced by account id, so signing out and signing in
//     as somebody else on the same browser cannot reach the first account's
//     vault.
//
// Every primitive here is a platform WebCrypto primitive — AES-GCM, PBKDF2,
// HKDF, SHA-256. Nothing cryptographic is invented or hand-rolled in this
// codebase.
//
// What this does NOT protect against is written down in docs/PRIVATE-VAULT.md
// and repeated in the UI. Short version: it protects Wisp's data on this
// device from somebody who gets hold of your unlocked phone. It is not
// protection against a compromised operating system, malware running with your
// privileges, or a second phone pointed at the screen.

import { rpc } from './db.js';
import { S, emit } from './state.js';

/* ── constants ─────────────────────────────────────────────────────────── */

const DB_NAME = 'wisp-vault';
const DB_VERSION = 1;
const META = 'meta';
const THREADS = 'threads';
const BLOBS = 'blobs';

const KDF = { hash: 'SHA-256', iterations: 600000 };
const PRF_LABEL = 'wisp.private.vault.prf.v1';
const INFO_CHAT = 'wisp.vault.chat.v1:';
const INFO_META = 'wisp.vault.meta.v1';

// Failed-code backoff in ms, indexed by how many failures have piled up.
// Deliberately not "destroy everything on the tenth try" by default: an angry
// sibling should not be able to wipe your data by guessing badly.
const BACKOFF = [0, 0, 0, 15e3, 30e3, 60e3, 300e3, 900e3, 1800e3, 3600e3];
const MAX_BACKOFF = 3600e3;
export const WIPE_AFTER = 10;

export const AUTOLOCK_OPTIONS = [
  ['0', 'Immediately'],
  ['30', 'After 30 seconds'],
  ['60', 'After 1 minute'],
  ['300', 'After 5 minutes'],
  ['foreground', 'When Wisp leaves the foreground'],
  ['devicelock', 'When the device locks'],
];
export const AUTOLOCK_DEFAULT = '60';

/* ── byte helpers ──────────────────────────────────────────────────────── */

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
// Best effort only — JavaScript gives no guarantee a copy was not made
// elsewhere. It still shortens the window in which raw key bytes sit in a live
// buffer, which is worth doing.
const zero = u8 => { try { u8 && u8.fill(0); } catch { /* frozen view */ } };

const uid = () => S.me?.id || 'anon';
const cfgKey = () => 'config:' + uid();
const guardKey = () => 'guard:' + uid();
const threadKey = chatId => uid() + ':' + chatId;
const blobKey = k => uid() + ':' + k;

/* ── IndexedDB ─────────────────────────────────────────────────────────── */

let dbPromise = null;
function openDb() {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      [META, THREADS, BLOBS].forEach(s => { db.objectStoreNames.contains(s) || db.createObjectStore(s); });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function idbGet(store, key) {
  return openDb().then(db => db && new Promise(resolve => {
    try {
      const tx = db.transaction(store, 'readonly');
      const r = tx.objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  }));
}

function idbPut(store, key, value) {
  return openDb().then(db => db && new Promise(resolve => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  }));
}

function idbDel(store, key) {
  return openDb().then(db => db && new Promise(resolve => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  }));
}

// Only this account's records, so a shared browser does not lose another
// account's vault when this one is erased.
function idbDropMine() {
  const prefix = uid() + ':';
  return openDb().then(db => db && new Promise(resolve => {
    try {
      const tx = db.transaction([META, THREADS, BLOBS], 'readwrite');
      tx.objectStore(META).delete(cfgKey());
      tx.objectStore(META).delete(guardKey());
      [THREADS, BLOBS].forEach(name => {
        const store = tx.objectStore(name);
        const req = store.getAllKeys();
        req.onsuccess = () => (req.result || []).forEach(k => {
          if (typeof k === 'string' && k.startsWith(prefix)) store.delete(k);
        });
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  }));
}

const readConfig = () => idbGet(META, cfgKey());
const writeConfig = cfg => idbPut(META, cfgKey(), cfg);

/* ── key derivation ────────────────────────────────────────────────────── */

async function kekFromCode(code, salt, iterations = KDF.iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF.hash },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function kekFromSecret(secretBytes, salt) {
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(PRF_LABEL) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapVmk(kek, vmkBytes) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, vmkBytes);
  return { iv: b64(iv), ct: b64(ct) };
}

async function unwrapVmk(kek, wrap) {
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrap.iv) }, kek, unb64(wrap.ct));
  return new Uint8Array(raw);
}

/* ── live (unlocked) state — memory only ───────────────────────────────── */

let vmk = null;                  // non-extractable HKDF CryptoKey, or null
let hkdfSalt = null;             // Uint8Array
const derived = new Map();       // info string -> AES-GCM CryptoKey
const memThreads = new Map();    // chat_id -> decrypted thread payload
const liveUrls = new Set();      // blob: URLs handed out for private media

export const isUnlocked = () => !!vmk;

async function subKey(info) {
  if (derived.has(info)) return derived.get(info);
  if (!vmk) throw new Error('Private Vault is locked.');
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: enc.encode(info) },
    vmk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  derived.set(info, key);
  return key;
}

/** Per-conversation local key. Throws while the vault is locked, by design. */
export const chatLocalKey = chatId => subKey(INFO_CHAT + chatId);
const metaLocalKey = () => subKey(INFO_META);

async function seal(key, bytes) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return new Uint8Array(pt);
}

/* ── setup / unlock / lock ─────────────────────────────────────────────── */

/** 'absent' (never set up on this device) | 'locked' | 'unlocked' */
export async function vaultState() {
  if (vmk) return 'unlocked';
  return (await readConfig()) ? 'locked' : 'absent';
}
export const vaultConfigured = async () => !!(await readConfig());

const WEAK = new Set(['012345', '123456', '1234567', '12345678', '123456789', '1234567890',
  '654321', '000000', '111111', '121212', 'password', 'letmein', 'qwerty', 'iloveyou']);

function codeComplaint(code) {
  const s = String(code ?? '');
  if (s.length < 6) return 'Use at least 6 characters.';
  if (/^(.)\1+$/.test(s)) return 'That is one character repeated. Pick something else.';
  if (WEAK.has(s.toLowerCase())) return 'That is one of the most-guessed codes. Pick something else.';
  return null;
}

/**
 * First-time setup on this device.
 *
 * The vault code is deliberately independent of the Wisp account password. An
 * account password gets typed on other devices, travels through a reset email,
 * and is held in this tab's sessionStorage so encrypted chats can be read — so
 * reusing it would mean the vault adds no boundary at all.
 */
export async function setupVault(code, { accountPassword = null } = {}) {
  const bad = codeComplaint(code);
  if (bad) return { ok: false, error: bad };
  if (accountPassword && code === accountPassword) {
    return { ok: false, error: 'That is your Wisp account password. The vault code has to be different, or the vault adds nothing.' };
  }
  if (await readConfig()) return { ok: false, error: 'A vault already exists on this device.' };

  const vmkBytes = rand(32);
  const salt = rand(16);
  const hs = rand(32);
  try {
    const wrap = await wrapVmk(await kekFromCode(code, salt), vmkBytes);
    const stored = await writeConfig({
      v: 1,
      kdf: { alg: 'PBKDF2', hash: KDF.hash, iterations: KDF.iterations, salt: b64(salt) },
      codeWrap: wrap,
      hkdfSalt: b64(hs),
      prf: null,
      wipeAfterFails: false,
      createdAt: new Date().toISOString(),
    });
    if (!stored) return { ok: false, error: 'This browser would not let Wisp store the vault on this device.' };
    await idbPut(META, guardKey(), { fails: 0, until: 0 });
    await adopt(vmkBytes, hs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'The vault could not be created on this device.' };
  } finally {
    zero(vmkBytes);
  }
}

async function adopt(vmkBytes, saltBytes) {
  vmk = await crypto.subtle.importKey('raw', vmkBytes, 'HKDF', false, ['deriveKey']);
  hkdfSalt = saltBytes;
  derived.clear();
  S.vault.unlocked = true;
  emit('vault', { unlocked: true });
}

/* ── failed-attempt throttle (persisted, so closing the tab does not reset) */

export async function guardStatus() {
  const g = (await idbGet(META, guardKey())) || { fails: 0, until: 0 };
  return { fails: g.fails || 0, waitMs: Math.max(0, (g.until || 0) - Date.now()) };
}
async function noteFail() {
  const g = (await idbGet(META, guardKey())) || { fails: 0, until: 0 };
  const fails = (g.fails || 0) + 1;
  const wait = BACKOFF[Math.min(fails, BACKOFF.length - 1)] ?? MAX_BACKOFF;
  await idbPut(META, guardKey(), { fails, until: Date.now() + wait });
  return { fails, waitMs: wait };
}
const clearFails = () => idbPut(META, guardKey(), { fails: 0, until: 0 });

/**
 * Unlock with the vault code.
 *
 * There is no other way in. No account-password override, no recovery code the
 * server could hand out, no support path that opens this for you, no developer
 * or admin key. Any of those would be exactly the bypass this feature exists to
 * prevent, so they are not implemented anywhere in this codebase.
 */
export async function unlockWithCode(code) {
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: 'No vault on this device yet.' };

  const pre = await guardStatus();
  if (pre.waitMs > 0) return { ok: false, error: 'Too many wrong codes.', waitMs: pre.waitMs, fails: pre.fails };

  let vmkBytes = null;
  try {
    const kek = await kekFromCode(code, unb64(cfg.kdf.salt), cfg.kdf.iterations);
    vmkBytes = await unwrapVmk(kek, cfg.codeWrap);
  } catch {
    const g = await noteFail();
    if (cfg.wipeAfterFails && g.fails >= WIPE_AFTER) {
      await eraseLocalVault();
      return {
        ok: false, erased: true,
        error: `Wrong code ${WIPE_AFTER} times, so this device's vault data was erased, as you asked it to be. Your private conversations are still private and still in the vault — set a new code here to read them on this device again.`,
      };
    }
    return { ok: false, error: 'That code is not right.', waitMs: g.waitMs, fails: g.fails };
  }
  try {
    await adopt(vmkBytes, unb64(cfg.hkdfSalt));
    await clearFails();
    return { ok: true };
  } finally {
    zero(vmkBytes);
  }
}

/**
 * Lock everything, right now. The primitive behind the quick "Lock Private
 * Vault" action, the auto-relock timer, leaving the page and signing out:
 *   • the master key and every derived key leave memory
 *   • decrypted conversations and decrypted media go, and every blob: URL
 *     handed out for private media is revoked
 *   • callers (see chats.js) pull private conversations back out of the live
 *     list, so nothing private is left in application state
 *   • notification handling falls back to the protected wording
 *
 * Synchronous on purpose. A lock that awaits anything is a lock that can be
 * beaten by the person taking the phone out of your hand.
 */
export function lockVault(reason = 'manual') {
  const was = !!vmk;
  vmk = null;
  hkdfSalt = null;
  derived.clear();
  memThreads.clear();
  liveUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  liveUrls.clear();
  clearTimeout(idleTimer);
  idleTimer = null;
  S.vault.unlocked = false;
  S.vault.chats = [];
  if (was) emit('vault', { unlocked: false, reason });
  return was;
}

/** Change the code. Requires the current one — this is a change, not a reset. */
export async function changeCode(currentCode, nextCode) {
  const bad = codeComplaint(nextCode);
  if (bad) return { ok: false, error: bad };
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: 'No vault on this device yet.' };

  let vmkBytes = null;
  try {
    const kek = await kekFromCode(currentCode, unb64(cfg.kdf.salt), cfg.kdf.iterations);
    vmkBytes = await unwrapVmk(kek, cfg.codeWrap);
  } catch {
    const g = await noteFail();
    return { ok: false, error: 'That current code is not right.', waitMs: g.waitMs };
  }
  try {
    const salt = rand(16);
    const codeWrap = await wrapVmk(await kekFromCode(nextCode, salt, KDF.iterations), vmkBytes);
    // The biometric wrap holds the same master key, so it stays valid.
    await writeConfig({
      ...cfg,
      kdf: { alg: 'PBKDF2', hash: KDF.hash, iterations: KDF.iterations, salt: b64(salt) },
      codeWrap,
    });
    await clearFails();
    return { ok: true };
  } finally {
    zero(vmkBytes);
  }
}

/* ── biometric / device authentication (WebAuthn) ───────────────────────── */

/**
 * Honest capability check.
 *   'ready'       — a platform authenticator is present and the browser looks
 *                   able to derive a key from it (PRF extension).
 *   'no-prf'      — biometrics exist, but this browser cannot turn them into a
 *                   key. We refuse to fake it. See below.
 *   'unsupported' — no platform authenticator at all.
 *
 * Why there is no fallback: without PRF, WebAuthn can only tell us "a human
 * passed a device check". To turn that into an unlock we would have to keep a
 * second copy of the master key wrapped under something stored on this device
 * in the clear — which anyone holding the unlocked phone could read straight
 * out of IndexedDB without ever touching the fingerprint sensor. That is a
 * decorative lock, and it would quietly undo the code. So on those browsers
 * the code is the only way in, and the UI says exactly that.
 */
export async function biometricSupport() {
  if (!('PublicKeyCredential' in window) || !navigator.credentials?.create) return 'unsupported';
  try {
    const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();
    if (!platform) return 'unsupported';
  } catch { return 'unsupported'; }
  try {
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && caps['extension:prf'] === false) return 'no-prf';
    }
  } catch { /* fall through: enrolment is the definitive answer */ }
  return 'ready';
}

export const biometricEnrolled = async () => !!(await readConfig())?.prf;

async function prfSecret(credId, prfSalt) {
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: unb64(credId), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const first = assertion?.getClientExtensionResults?.()?.prf?.results?.first;
    return first ? new Uint8Array(first) : null;
  } catch {
    return null;
  }
}

/**
 * Turn on biometric unlock. Needs the vault code once, because the raw master
 * key is never kept in memory in extractable form — the only way to re-wrap it
 * is to unwrap it again. Asking for the code here is the price of not holding
 * exportable key bytes around for a whole session, and it is worth paying.
 */
export async function enrolBiometric(code) {
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: 'Set a vault code first.' };

  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { id: location.hostname, name: 'Wisp' },
        user: {
          id: enc.encode(uid()),
          name: S.me?.email || 'wisp',
          displayName: S.me?.display_name || 'Wisp',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        timeout: 60000,
        attestation: 'none',
        extensions: { prf: {} },
      },
    });
  } catch (e) {
    if (e?.name === 'NotAllowedError') return { ok: false, error: 'The device check was cancelled, so nothing changed.' };
    return { ok: false, error: e?.message || 'This device would not register a key for the vault.' };
  }
  if (!cred) return { ok: false, error: 'No credential was created.' };
  if (cred.getClientExtensionResults?.()?.prf?.enabled === false) {
    return {
      ok: false, code: 'no-prf',
      error: 'This browser can check your fingerprint or face but cannot derive a key from it, so it cannot open the vault on its own. Your code stays the only way in on this device.',
    };
  }

  const credId = b64(cred.rawId);
  const prfSalt = rand(32);
  const secret = await prfSecret(credId, prfSalt);
  if (!secret) {
    return {
      ok: false, code: 'no-prf',
      error: 'This browser did not return a usable key from the device check, so biometric unlock is not available here. Your code still works.',
    };
  }

  let vmkBytes = null;
  try {
    const kek = await kekFromCode(code, unb64(cfg.kdf.salt), cfg.kdf.iterations);
    vmkBytes = await unwrapVmk(kek, cfg.codeWrap);
  } catch {
    zero(secret);
    const g = await noteFail();
    return { ok: false, error: 'That code is not right, so biometric unlock was not turned on.', waitMs: g.waitMs };
  }
  try {
    const salt = rand(16);
    const wrap = await wrapVmk(await kekFromSecret(secret, salt), vmkBytes);
    await writeConfig({ ...cfg, prf: { credId, prfSalt: b64(prfSalt), salt: b64(salt), wrap } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'Biometric unlock could not be stored.' };
  } finally {
    zero(vmkBytes);
    zero(secret);
  }
}

/** Unlock with this device's biometrics / device credential. */
export async function unlockWithBiometric() {
  const cfg = await readConfig();
  if (!cfg?.prf) return { ok: false, error: 'Biometric unlock is not set up on this device.', fallback: true };
  const pre = await guardStatus();
  if (pre.waitMs > 0) return { ok: false, error: 'Too many wrong codes.', waitMs: pre.waitMs };

  const secret = await prfSecret(cfg.prf.credId, unb64(cfg.prf.prfSalt));
  if (!secret) return { ok: false, error: 'The device check did not go through. Use your code instead.', fallback: true };

  let vmkBytes = null;
  try {
    const kek = await kekFromSecret(secret, unb64(cfg.prf.salt));
    vmkBytes = await unwrapVmk(kek, cfg.prf.wrap);
  } catch {
    zero(secret);
    return { ok: false, error: 'That device credential no longer matches this vault. Use your code.', fallback: true };
  }
  try {
    await adopt(vmkBytes, unb64(cfg.hkdfSalt));
    await clearFails();
    return { ok: true };
  } finally {
    zero(vmkBytes);
    zero(secret);
  }
}

export async function dropBiometric() {
  const cfg = await readConfig();
  if (cfg) await writeConfig({ ...cfg, prf: null });
}

export async function setWipeAfterFails(on) {
  const cfg = await readConfig();
  if (cfg) await writeConfig({ ...cfg, wipeAfterFails: !!on });
}
export const wipeAfterFailsOn = async () => !!(await readConfig())?.wipeAfterFails;

/**
 * Remove this device's vault: the wrapped key, the encrypted local copies of
 * private conversations and their media, and the attempt counter.
 *
 * This is not a bypass and not a recovery route — it destroys the local key, so
 * it cannot reveal anything. Conversations stay in the vault for this account,
 * so they do not reappear in the normal list; set a new code on this device to
 * read them here again (they are re-fetched from the server, still end-to-end
 * encrypted).
 */
export async function eraseLocalVault() {
  lockVault('erased');
  await idbDropMine();
  emit('vault', { unlocked: false, reason: 'erased', erased: true });
}

/* ── vault-protected local storage ─────────────────────────────────────── */

/** Decrypted thread already in memory. Synchronous, so the UI can paint with
 *  no I/O wait, exactly like the normal cache does. */
export const getMemVaultThread = chatId => (vmk ? memThreads.get(chatId) || null : null);

export async function getVaultThread(chatId) {
  if (!vmk) return null;
  if (memThreads.has(chatId)) return memThreads.get(chatId);
  const box = await idbGet(THREADS, threadKey(chatId));
  if (!box) return null;
  try {
    const bytes = await unseal(await chatLocalKey(chatId), box);
    const payload = JSON.parse(dec.decode(bytes));
    memThreads.set(chatId, payload);
    return payload;
  } catch {
    // Wrong key or a damaged record: behave as "nothing cached" rather than
    // throwing something cryptic into the thread renderer.
    return null;
  }
}

export async function setVaultThread(chatId, payload) {
  if (!vmk) return;
  memThreads.set(chatId, payload);
  try {
    const box = await seal(await chatLocalKey(chatId), enc.encode(JSON.stringify(payload)));
    await idbPut(THREADS, threadKey(chatId), box);
  } catch { /* a cache write is never worth breaking the UI over */ }
}

export async function dropVaultThread(chatId) {
  memThreads.delete(chatId);
  await idbDel(THREADS, threadKey(chatId));
}

/** Sealed local copy of decrypted private media bytes. */
export async function getVaultBlob(key) {
  if (!vmk) return null;
  const box = await idbGet(BLOBS, blobKey(key));
  if (!box) return null;
  try {
    const bytes = await unseal(await metaLocalKey(), box);
    return new Blob([bytes], { type: box.mime || 'application/octet-stream' });
  } catch { return null; }
}

export async function setVaultBlob(key, arrayBuffer, mime) {
  if (!vmk) return;
  try {
    const box = await seal(await metaLocalKey(), new Uint8Array(arrayBuffer));
    await idbPut(BLOBS, blobKey(key), { ...box, mime: mime || 'application/octet-stream' });
  } catch { /* cache only */ }
}

/**
 * Hand out a blob: URL for private media and remember it, so locking the vault
 * revokes it instead of leaving a live handle to decrypted bytes behind in the
 * document.
 */
export function trackedBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  return url;
}

/* ── which conversations are private ───────────────────────────────────── */

/**
 * The set of conversation ids that live in the vault, kept even while locked.
 *
 * That is on purpose: it is what lets the client route an incoming private
 * message to a contentless notification and keep it out of the normal cache. It
 * carries no message content, no name and no preview — while the vault is
 * locked the client never even asks the server for those, because
 * chat_overview() excludes private conversations server-side.
 */
export async function loadVaultIds() {
  try {
    const ids = await rpc('vault_chat_ids');
    S.vault.ids = new Set(ids || []);
  } catch {
    // Server without the migration applied yet: behave as "nothing is private"
    // rather than failing boot.
    S.vault.ids = new Set();
  }
  return S.vault.ids;
}
export const isVaulted = chatId => S.vault.ids.has(chatId);

/* ── screen security + auto-relock ─────────────────────────────────────── */

let idleTimer = null;
let armed = false;

const autolockMode = () => String(S.settings?.vault_autolock ?? AUTOLOCK_DEFAULT);
const screenGuardOn = () => S.settings?.vault_screen_guard !== false;

function clearIdle() { clearTimeout(idleTimer); idleTimer = null; }

function scheduleIdle() {
  clearIdle();
  if (!isUnlocked()) return;
  const mode = autolockMode();
  if (mode === 'foreground' || mode === 'devicelock') return;   // event-driven
  const secs = Number(mode);
  if (!Number.isFinite(secs)) return;
  if (secs <= 0) { lockVault('immediate'); return; }
  idleTimer = setTimeout(() => lockVault('timeout'), secs * 1000);
}

/**
 * Mark private content as being on screen right now — the vault view, or an
 * open private conversation. Drives both the screen guard and the countdown:
 * leaving private content starts the clock, coming back stops it.
 */
export function setVaultVisible(on) {
  S.vault.visible = !!on;
  if (on) clearIdle(); else scheduleIdle();
}

/** The app-switcher / screenshot cover. */
export function shroud(on) {
  const el = document.getElementById('vault-shroud');
  if (!el) return;
  el.hidden = !on;
  document.documentElement.classList.toggle('vault-shrouded', !!on);
}

function onHidden() {
  // Paint the cover first and synchronously: browsers take their app-switcher
  // snapshot around this event, so anything awaited here is already too late.
  // This is the strongest thing the web platform offers — it is not a guarantee
  // that no frame was captured, and docs/PRIVATE-VAULT.md says so plainly.
  if (isUnlocked() && (S.vault.visible || screenGuardOn())) shroud(true);
  const mode = autolockMode();
  if (mode === 'foreground' || mode === 'devicelock' || mode === '0') {
    lockVault(mode === '0' ? 'immediate' : mode);
    return;
  }
  scheduleIdle();
}

function onVisible() {
  shroud(false);
  // Back before the countdown fired: cancel it. Back after: the vault is
  // already locked and the UI will ask again.
  if (S.vault.visible) clearIdle();
}

export function armVaultLifecycle() {
  if (armed) return;
  armed = true;
  document.addEventListener('visibilitychange', () => {
    document.visibilityState === 'hidden' ? onHidden() : onVisible();
  });
  addEventListener('blur', () => { if (autolockMode() === 'foreground') lockVault('foreground'); });
  // A reload always starts locked: nothing about the unlocked state survives a
  // page load, because the master key only ever lived in this document's memory.
  addEventListener('pagehide', () => { shroud(true); lockVault('pagehide'); });
}

/** Reset the countdown on real interaction inside the vault. */
export const noteVaultActivity = () => { if (S.vault.visible) clearIdle(); else scheduleIdle(); };
