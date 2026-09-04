// Hands the browser the public config only. The service-role key must never be
// referenced here.
export default function handler(req, res) {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json({
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
    iceServers,
  });
}
