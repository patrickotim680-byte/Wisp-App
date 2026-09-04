// Resolves Supabase credentials. Order:
//   1. /api/config  (Vercel serverless function reading env vars)
//   2. localStorage (set from the in-app setup screen, dev convenience)
// The anon key is the only key that ever reaches the browser.
export async function loadEnv() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.url && j.anonKey) return j;
    }
  } catch { /* static host without functions */ }
  const url = localStorage.getItem('wisp.url');
  const anonKey = localStorage.getItem('wisp.key');
  if (url && anonKey) return { url, anonKey };
  return null;
}
export function saveEnvLocally(url, anonKey) {
  localStorage.setItem('wisp.url', url.trim().replace(/\/$/, ''));
  localStorage.setItem('wisp.key', anonKey.trim());
}
