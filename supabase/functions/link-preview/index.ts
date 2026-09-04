// Fetches OpenGraph tags for a URL and caches them in public.link_previews.
// Called from the client with the user's JWT; the row is then readable by
// everyone (previews are not private data).
//
// Deploy: supabase functions deploy link-preview

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } });

const pick = (html: string, ...names: string[]) => {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`, 'i');
    const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = re.exec(html) ?? alt.exec(html);
    if (m) return m[1];
  }
  return null;
};

Deno.serve(async req => {
  try {
    const { url } = await req.json();
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return new Response('bad scheme', { status: 400 });
    // block obvious SSRF targets
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(target.hostname)) {
      return new Response('blocked host', { status: 400 });
    }
    const { data: cached } = await db.from('link_previews').select('*').eq('url', url).maybeSingle();
    if (cached) return Response.json({ preview: cached });

    const res = await fetch(target, {
      headers: { 'user-agent': 'WispBot/1.0 (+link preview)', accept: 'text/html' },
      redirect: 'follow', signal: AbortSignal.timeout(6000),
    });
    const html = (await res.text()).slice(0, 300_000);
    const preview = {
      url,
      title: pick(html, 'og:title', 'twitter:title') ?? /<title>([^<]+)<\/title>/i.exec(html)?.[1] ?? target.hostname,
      description: pick(html, 'og:description', 'description', 'twitter:description'),
      image: pick(html, 'og:image', 'twitter:image'),
      site: pick(html, 'og:site_name') ?? target.hostname,
    };
    await db.from('link_previews').upsert(preview);
    return Response.json({ preview });
  } catch (e) {
    return Response.json({ preview: null, error: String(e) });
  }
});
