// ── Optional per-chat end-to-end encryption ──────────────────────────────
// Design (documented honestly in the README):
//   • Each account has an RSA-OAEP 2048 keypair. The public key is public.
//     The private key is wrapped with AES-GCM using a PBKDF2 key derived from
//     the account password, so the server stores only ciphertext.
//   • Each e2ee chat has one AES-256-GCM key, wrapped once per member with
//     that member's public key (chat_keys).
//   • Message bodies are AES-GCM encrypted client-side; the server sees only
//     ciphertext + IV.
// Limitations: no forward secrecy, no post-compromise security, no key
// verification/safety numbers, no ratchet. Server-side full-text search and
// the SQL digest cannot read encrypted chats, by design.

import { sb, rpc } from './db.js';
import { S } from './state.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pwKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function createIdentity(password) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']);
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
    await pwKey(password, salt), enc.encode(JSON.stringify(privJwk)));
  const { error } = await sb.from('user_keys').upsert({
    user_id: (await sb.auth.getUser()).data.user.id,
    public_jwk: pubJwk, private_wrapped: b64(wrapped), kdf_salt: b64(salt), kdf_iv: b64(iv),
  });
  if (error) throw error;
  S.keys = { pub: pair.publicKey, priv: pair.privateKey };
  sessionStorage.setItem('wisp.priv', JSON.stringify(privJwk));
}

export async function unlockIdentity(password) {
  const cached = sessionStorage.getItem('wisp.priv');
  const { data } = await sb.from('user_keys').select('*').eq('user_id', S.me.id).maybeSingle();
  if (!data) { if (password) await createIdentity(password); return !!S.keys; }
  const pub = await crypto.subtle.importKey('jwk', data.public_jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
  let privJwk = cached ? JSON.parse(cached) : null;
  if (!privJwk) {
    if (!password) return false;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(data.kdf_iv) },
        await pwKey(password, unb64(data.kdf_salt)), unb64(data.private_wrapped));
      privJwk = JSON.parse(dec.decode(plain));
      sessionStorage.setItem('wisp.priv', JSON.stringify(privJwk));
    } catch { return false; }
  }
  const priv = await crypto.subtle.importKey('jwk', privJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
  S.keys = { pub, priv };
  return true;
}

export async function chatKey(chatId, memberIds) {
  if (S.chatKeys.has(chatId)) return S.chatKeys.get(chatId);
  const { data: mine } = await sb.from('chat_keys').select('wrapped_key').eq('chat_id', chatId)
    .eq('user_id', S.me.id).maybeSingle();
  if (mine && S.keys?.priv) {
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, S.keys.priv, unb64(mine.wrapped_key));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
    S.chatKeys.set(chatId, key);
    return key;
  }
  // first member to turn encryption on mints the key and wraps it for everyone
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', key);
  const { data: keys } = await sb.from('user_keys').select('user_id, public_jwk').in('user_id', memberIds);
  const rows = [];
  for (const k of keys || []) {
    const pub = await crypto.subtle.importKey('jwk', k.public_jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    rows.push({ chat_id: chatId, user_id: k.user_id, wrapped_key: b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw)) });
  }
  if (rows.length) await sb.from('chat_keys').insert(rows);
  S.chatKeys.set(chatId, key);
  return key;
}

export async function sealBody(chatId, memberIds, text) {
  const key = await chatKey(chatId, memberIds);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { cipher: b64(ct), iv: b64(iv) };
}
export async function openBody(chatId, cipher, iv) {
  try {
    const key = await chatKey(chatId, []);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(cipher)));
  } catch { return null; }
}
export const forgetKeys = () => { sessionStorage.removeItem('wisp.priv'); S.keys = null; S.chatKeys.clear(); };
