import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { loadEnv } from './env.js';

export let sb = null;

export async function initDb() {
  const env = await loadEnv();
  if (!env) return null;
  sb = createClient(env.url, env.anonKey, {
    // sessionStorage (not localStorage) on purpose: localStorage is shared by
    // every tab of the same origin, so two tabs signed into two accounts would
    // fight over one session and Supabase's own cross-tab sync would flip one
    // tab to the other account. sessionStorage is private per tab, so each tab
    // keeps its own account — closing a tab ends that tab's session, same as
    // opening a fresh browser profile per account would.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.sessionStorage },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return sb;
}

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
export async function sel(table, build) {
  let q = sb.from(table).select(build.select || '*');
  if (build.eq) for (const [k, v] of Object.entries(build.eq)) q = q.eq(k, v);
  if (build.in) for (const [k, v] of Object.entries(build.in)) q = q.in(k, v);
  if (build.order) q = q.order(build.order[0], { ascending: build.order[1] !== 'desc' });
  if (build.limit) q = q.limit(build.limit);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
export async function ins(table, row, opts) {
  const { data, error } = await sb.from(table).insert(row).select(opts?.select || '*');
  if (error) throw error;
  return data;
}
export async function upd(table, patch, match) {
  let q = sb.from(table).update(patch);
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { error } = await q;
  if (error) throw error;
}
export async function del(table, match) {
  let q = sb.from(table).delete();
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { error } = await q;
  if (error) throw error;
}

/* Realtime: one channel per logical concern so we can drop them cleanly. */
const channels = new Map();
export function channel(key, build) {
  drop(key);
  const ch = sb.channel(key);
  build(ch);
  ch.subscribe();
  channels.set(key, ch);
  return ch;
}
export function drop(key) {
  const old = channels.get(key);
  if (old) { sb.removeChannel(old); channels.delete(key); }
}
export const dropAll = () => { [...channels.keys()].forEach(drop); };

/* Storage */
export async function upload(bucket, path, file, contentType) {
  const { error } = await sb.storage.from(bucket).upload(path, file, {
    contentType: contentType || file.type || 'application/octet-stream', upsert: true,
  });
  if (error) throw error;
  return path;
}
const signedCache = new Map();
export async function signedUrl(bucket, path, secs = 3600) {
  const key = bucket + '/' + path;
  const hit = signedCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, secs);
  if (error) throw error;
  signedCache.set(key, { url: data.signedUrl, exp: Date.now() + (secs - 60) * 1000 });
  return data.signedUrl;
}
export const publicUrl = (bucket, path) =>
  path ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : null;
