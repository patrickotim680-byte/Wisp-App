// Fires on new rows in public.messages (Database Webhook -> this function) and
// pushes to every device of every other chat member, honouring mute, focus
// mode, quiet hours, notify_level and notification-preview privacy.
//
// Transport: FCM HTTP v1. Android high-priority pushes ring through a closed
// app. iOS lock-screen ringing needs native CallKit/PushKit and cannot be done
// from this codebase; see the README.
//
// Deploy:  supabase functions deploy push-notify --no-verify-jwt
// Secrets: SERVICE_ROLE_KEY, SUPABASE_URL, FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SERVICE_ROLE_KEY')!;
const FCM_PROJECT = Deno.env.get('FCM_PROJECT_ID') ?? '';
const FCM_EMAIL = Deno.env.get('FCM_CLIENT_EMAIL') ?? '';
const FCM_KEY = (Deno.env.get('FCM_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n');

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/* ── FCM auth: sign a service-account JWT, exchange for an access token ── */
let cachedToken: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string | null> {
  if (!FCM_PROJECT || !FCM_EMAIL || !FCM_KEY) return null;
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: FCM_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const b64u = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = `${b64u(header)}.${b64u(claim)}`;

  const pem = FCM_KEY.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = await res.json();
  if (!json.access_token) { console.error('fcm token', json); return null; }
  cachedToken = { token: json.access_token, exp: Date.now() + 3500_000 };
  return json.access_token;
}

function inQuietHours(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const a = fh * 60 + fm, b = th * 60 + tm;
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

Deno.serve(async req => {
  try {
    const body = await req.json();
    const m = body.record ?? body.new ?? body;      // webhook payload or manual call
    if (!m?.chat_id) return new Response('no record', { status: 400 });
    if (m.kind === 'system') return new Response('skip system');

    const [{ data: chat }, { data: members }, { data: sender }, { data: mentions }] = await Promise.all([
      db.from('chats').select('id, name, type').eq('id', m.chat_id).single(),
      db.from('chat_members').select('user_id, notify_level, muted_until, mute_forever').eq('chat_id', m.chat_id),
      db.from('profiles').select('display_name').eq('id', m.sender_id).maybeSingle(),
      db.from('mentions').select('user_id').eq('message_id', m.id),
    ]);
    const mentioned = new Set((mentions ?? []).map(r => r.user_id));
    const targets = (members ?? []).filter(r =>
      r.user_id !== m.sender_id &&
      !r.mute_forever &&
      !(r.muted_until && new Date(r.muted_until) > new Date()) &&
      r.notify_level !== 'none' &&
      !(r.notify_level === 'mentions' && !mentioned.has(r.user_id)));
    if (!targets.length) return new Response('nobody to notify');

    const ids = targets.map(t => t.user_id);
    const [{ data: settings }, { data: devices }] = await Promise.all([
      db.from('user_settings').select('user_id, notif_preview, focus_mode, quiet_from, quiet_to').in('user_id', ids),
      db.from('devices').select('user_id, token, platform').in('user_id', ids),
    ]);
    const token = await accessToken();
    const sent: string[] = [];

    for (const t of targets) {
      const s = (settings ?? []).find(x => x.user_id === t.user_id);
      if (s?.focus_mode || inQuietHours(s?.quiet_from ?? null, s?.quiet_to ?? null)) continue;
      const who = chat?.type === 'dm' ? (sender?.display_name ?? 'New message') : (chat?.name ?? 'Group');
      const preview = s?.notif_preview ?? 'full';
      const title = preview === 'hidden' ? 'Wisp' : who;
      const bodyText = preview === 'full'
        ? (m.body ? String(m.body).slice(0, 160) : `[${m.kind}]`)
        : 'New message';

      for (const d of (devices ?? []).filter(x => x.user_id === t.user_id)) {
        if (!token) { console.log('no FCM credentials: would notify', d.token, title); continue; }
        const payload = {
          message: {
            token: d.token,
            notification: { title, body: bodyText },
            data: { chat_id: m.chat_id, message_id: m.id ?? '', kind: m.kind ?? 'text', title, body: bodyText },
            android: { priority: m.kind === 'call' ? 'HIGH' : 'HIGH', ttl: '120s' },
            apns: { headers: { 'apns-priority': '10' } },
          },
        };
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM_PROJECT}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (r.ok) sent.push(d.token);
        else {
          const err = await r.text();
          console.warn('fcm send failed', err);
          if (err.includes('UNREGISTERED') || err.includes('NOT_FOUND')) {
            await db.from('devices').delete().eq('token', d.token);
          }
        }
      }
    }
    return Response.json({ notified: sent.length });
  } catch (e) {
    console.error(e);
    return new Response(String(e), { status: 500 });
  }
});
