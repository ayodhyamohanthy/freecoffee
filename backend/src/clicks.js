/* Verified clicks. An ad click goes through GET /c/<campaignId>. We look the
   campaign up in the served feed, count the click server-side, and forward to
   the sponsor with tracking parameters so the sponsor's own analytics can count
   it too. This only ever forwards to a URL already in the served feed, so it is
   not an open redirect. It credits nothing: earnings rules are unchanged. */
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha(t) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(t))); }

export function clickRoute(method, pathname) {
  const m = /^\/c\/([A-Za-z0-9_.-]{1,40})$/.exec(pathname);
  if (method === 'GET' && m) return { campaignId: m[1] };
  return null;
}

export function trackedUrl(clickUrl, campaignId) {
  const u = new URL(clickUrl);
  if (u.protocol !== 'https:') return null;
  if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'freecoffee');
  if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'ad_slot');
  if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campaignId);
  return u.href;
}

export async function handleClick(request, env, campaignId, deps) {
  const feed = await deps.getFeed(env);
  const camp = (feed.campaigns || []).find(c => c && c.id === campaignId);
  const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!camp || camp.allowClicks === false || !(Number(camp.cpm) >= deps.minCpm)) return notFound();
  let dest = null;
  try { dest = trackedUrl(camp.clickUrl, campaignId); } catch (e) { dest = null; }
  if (!dest) return notFound();
  if (env && env.SITE_KV) {
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const hour = now.toISOString().slice(0, 13);
      /* One counted click per network per campaign per hour. The network id is
         hashed with the day, so no raw address is stored and it can't be linked
         across days. */
      const who = await sha('clk:' + day + ':' + deps.ip(request));
      const seen = 'clkseen:' + campaignId + ':' + hour + ':' + who.slice(0, 24);
      if (!(await env.SITE_KV.get(seen))) {
        await env.SITE_KV.put(seen, '1', { expirationTtl: 3700 });
        const ck = 'clk:' + campaignId + ':' + day;
        const n = Number(await env.SITE_KV.get(ck)) || 0;
        await env.SITE_KV.put(ck, String(n + 1), { expirationTtl: 60 * 60 * 24 * 120 });
      }
    } catch (e) { /* counting is best effort; the visitor still reaches the sponsor */ }
  }
  return new Response(null, { status: 302, headers: { location: dest, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

export async function adminClicks(request, env, campaignId, days, json) {
  const out = [];
  for (let i = 0; i < Math.min(Math.max(days || 7, 1), 31); i++) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, clicks: Number(await env.SITE_KV.get('clk:' + campaignId + ':' + day)) || 0 });
  }
  return json({ ok: true, campaignId, days: out, note: 'Counts are lower bounds: one click per network per hour, and the counter is a best-effort tally.' }, 200);
}
