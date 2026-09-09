// Resolves Supabase credentials. Order:
//   1. /api/config  (Vercel serverless function reading env vars)
//   2. localStorage (set from the in-app setup screen, dev convenience)
// The anon key is the only key that ever reaches the browser.
//
// Everything is normalised and validated *here*, before it can reach
// createClient(): supabase-js parses the project URL itself and throws
// "Invalid supabaseUrl: Provided URL is malformed" synchronously for anything
// it cannot make sense of. That throw happens during boot, so the failure the
// person actually saw was a frozen splash screen with nothing tappable behind
// it — the message only existed in the console. Values arrive dirty more often
// than not: a copy out of a dashboard or an .env file brings a trailing
// newline, a quote pair, or a stray space; a hand-typed one is missing the
// scheme or carries a trailing slash or path. Anything repairable gets
// repaired, anything else is rejected with a reason the setup screen can show.

const scrub = v => String(v ?? '').trim().replace(/^["']+|["']+$/g, '').replace(/\s+/g, '');

export function normalizeUrl(raw) {
  let s = scrub(raw);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.origin;            // drops any path, query, hash or trailing slash
  } catch { return null; }
}
export const normalizeKey = raw => scrub(raw) || null;

/* Why the last attempt failed, so the setup screen can say something more
   useful than "connect a project". */
let lastError = null;
export const envError = () => lastError;
export const noteEnvError = msg => { lastError = msg || null; };

const KEYS = { url: 'wisp.url', key: 'wisp.key' };

export async function loadEnv() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      const url = normalizeUrl(j.url), anonKey = normalizeKey(j.anonKey);
      if (url && anonKey) return { url, anonKey };
      if (j.url && !url) noteEnvError('SUPABASE_URL on the server is not a usable URL.');
      else if (url && !anonKey) noteEnvError('SUPABASE_ANON_KEY is missing on the server.');
    }
  } catch { /* static host without functions */ }

  const url = normalizeUrl(localStorage.getItem(KEYS.url));
  const anonKey = normalizeKey(localStorage.getItem(KEYS.key));
  if (url && anonKey) return { url, anonKey };
  // A stored value that cannot be repaired is worse than none at all: it would
  // fail the same way on every single reload. Clear it so setup starts clean.
  if (localStorage.getItem(KEYS.url) && !url) {
    noteEnvError('The project URL saved in this browser was not a valid URL, so it has been cleared.');
    forgetEnvLocally();
  }
  return null;
}

export function saveEnvLocally(url, anonKey) {
  const u = normalizeUrl(url), k = normalizeKey(anonKey);
  if (!u || !k) throw new Error('Enter the full project URL and the anon key.');
  localStorage.setItem(KEYS.url, u);
  localStorage.setItem(KEYS.key, k);
  return { url: u, anonKey: k };
}
export function forgetEnvLocally() {
  try { localStorage.removeItem(KEYS.url); localStorage.removeItem(KEYS.key); } catch {}
}
