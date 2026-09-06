/* ==========================================================================
   FreeCoffee backend — Cloudflare Worker (free tier, KV), plain ES module.

   SECURITY MODEL
   --------------
   • The device id is the ONLY identifier the platform ever sees: a random
     UUID generated client-side and kept in the browser's localStorage. No
     account, no email, no PII beyond that random id.
   • Money math is 100% server-side. The client reports only {deviceId,
     type, campaignId, minutes}; every amount is computed from the campaign
     CPM looked up in the SERVED feed, and the click caps are read from the
     STORED ledger — a tampered client cannot mint money.
   • Keys (`feed:current`, `earn:{deviceId}`) are treated as secrets: they
     are never echoed into responses, errors, or logs.
   • Admin routes require `Authorization: Bearer ${env.ADMIN_TOKEN}`
     (length-safe constant-time compare; ADMIN_TOKEN is an encrypted
     Worker variable — `wrangler secret put ADMIN_TOKEN` or dashboard →
     Settings → Variables → Encrypt). No secrets are ever committed to
     this repo — wrangler.toml ships placeholders only.
   • CORS: `access-control-allow-origin: *` on EVERY response (the API is
     public and holds no credentials) + OPTIONS preflight → 204.
   • Abuse caps enforced server-side: ≤5 paid clicks/day per device and
     paid clicks ≤25% of that device's impressions this month. The daily
     cap counts click REPORTS (paid or not) — spammers burn their own quota.
   • Honest limits: `minutes` is client-reported (MVP trusts it; the caps
     bound the blast radius). KV is eventually consistent — the ledger is a
     best-effort read-modify-write (last-write-wins on the free tier).

   EARNINGS MODEL (mirrors the demo ledger's public model)
   -------------------------------------------------------
   • Impression: minutes × cpm ÷ 1000 × 0.65 (user base share). `minutes`
     is the reported length of the placement batch (0–60 per report,
     clamped server-side; defaults to 1 when absent).
   • Click: flat $0.05 when the caps allow.
   • Rounded to 4 decimals internally while accumulating; served at 2.
   ========================================================================== */

/* ------------------------------ constants ------------------------------- */
var USER_SHARE = 0.65;          // transparent 65% of auction revenue
var CLICK_BONUS = 0.05;         // $ per verified click
var CLICK_MAX_PER_DAY = 5;
var CLICK_CAP_SHARE = 0.25;     // ≤25% of monthly impressions
var MAX_MINUTES_PER_REPORT = 60;
var ROWS_KEPT = 200;            // ledger rows retained in KV
var ROWS_SERVED = 50;           // rows returned by GET /earnings
var CPM_MIN = 0, CPM_MAX = 100;
var MAX_CAMPAIGNS = 20;
var MAX_UPSTREAM = 500;         // work bound on upstream feed entries
var FEED_TTL_S = 600;           // adapter feed cached 10 minutes
var ID_MAX = 40, SPONSOR_MAX = 40, TAGLINE_MAX = 90, LOGO_MAX = 2;
var DEFAULT_ACCENT = '#C98F4E';
var DEVICE_ID_RE = /^[a-f0-9-]{8,64}$/i;

/* Pure helpers are exported for unit tests (backend/test.mjs). The Workers
   fetch listener sits at the bottom behind a
   `typeof addEventListener !== 'undefined'` guard so `node --check` and a
   plain `import` work with no Workers runtime present. */

function round4(n) { return Math.round(n * 10000) / 10000; }
function round2(n) { return Math.round(n * 100) / 100; }

/* UTC date / month keys for the daily + monthly caps. */
function todayKey(ts) {
  var d = new Date(typeof ts === 'number' && isFinite(ts) ? ts : 0);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getUTCDate()).slice(-2);
}
function monthKey(ts) {
  var d = new Date(typeof ts === 'number' && isFinite(ts) ? ts : 0);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}

/* --------------------------- feed validation ----------------------------
   Mirrors assets/js/demo.js → fetchLiveCampaigns: https-only URLs,
   trimmed length-capped strings, cpm coerced + clamped 0–100, dedupe by
   id, cap 20. The server is stricter than the web client in exactly one
   place: `id` is REQUIRED here (it is the earnings pay-key). Entries
   with an http:/data: clickUrl keep rendering but the URL is dropped —
   same rule as the web. Optional `allowClicks` (default true) lets a
   campaign opt out of the $0.05 click bonus.                            */
function capStr(val, max) {
  if (typeof val !== 'string') return '';
  return val.replace(/^\s+|\s+$/g, '').slice(0, max);
}

function isValidHttpsUrl(val) {
  if (typeof val !== 'string') return false;
  return /^https:\/\//i.test(val);
}

function validateCampaigns(raw) {
  if (!Array.isArray(raw)) return [];
  var seen = {}, out = [];
  for (var i = 0; i < raw.length && out.length < MAX_CAMPAIGNS; i++) {
    var r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    var id = capStr(r.id, ID_MAX);
    var sponsor = capStr(r.sponsor, SPONSOR_MAX);
    if (!id) continue;                        // server: id required (pay-key)
    if (!sponsor) continue;                   // unusable without a name
    if (seen[id]) continue;                   // dedupe by id
    var click = isValidHttpsUrl(r.clickUrl) ? r.clickUrl : '';
    var cpm = Number(r.cpm);
    if (!isFinite(cpm)) cpm = 0;
    cpm = Math.min(CPM_MAX, Math.max(CPM_MIN, cpm));
    seen[id] = true;
    out.push({
      id: id,
      sponsor: sponsor,
      tagline: capStr(r.tagline, TAGLINE_MAX),
      clickUrl: click,
      cpm: cpm,
      logoText: capStr(r.logoText, LOGO_MAX) ||
        sponsor.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(),
      accent: (typeof r.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.accent))
        ? r.accent : DEFAULT_ACCENT,
      allowClicks: r.allowClicks === undefined ? true : !!r.allowClicks
    });
  }
  return out;
}

/* ------------------------------- pickRoute ------------------------------
   Pure router: (method, pathname) → {handled, route, deviceId?}.        */
function pickRoute(method, pathname) {
  if (method === 'OPTIONS') return { handled: true, route: 'preflight' };
  if (method === 'GET' && pathname === '/feed.json') return { handled: true, route: 'feed' };
  if (method === 'GET' && pathname === '/health') return { handled: true, route: 'health' };
  if (method === 'POST' && pathname === '/track') return { handled: true, route: 'track' };
  if (method === 'POST' && pathname === '/admin/feed') return { handled: true, route: 'adminFeed' };
  if (method === 'GET' && /^\/earnings\/[^/]+$/.test(pathname)) {
    return { handled: true, route: 'earnings', deviceId: pathname.split('/')[2] || '' };
  }
  return { handled: false, route: null };
}

/* ------------------------------- ledger --------------------------------- */
function freshLedger(now) {
  var ts = typeof now === 'number' && isFinite(now) ? now : Date.now();
  return {
    total: 0,
    today: { date: todayKey(ts), total: 0 },
    monthly: { month: monthKey(ts), total: 0, impressions: 0 },
    rows: [],
    counters: { impressions: 0, clicks: 0, todayClicks: { date: todayKey(ts), count: 0 } }
  };
}

/* Deep-clone via JSON — every value in the ledger is JSON-shaped, and the
   helpers stay PURE (the input ledger is never mutated). */
function cloneLedger(l) {
  try { return JSON.parse(JSON.stringify(l)); } catch (e) { return null; }
}

/* ------------------------------ applyEarnings ---------------------------
   The money brain — PURE (never mutates its inputs), no network, no KV.

   applyEarnings(ledger, report, campaigns, now)
     ledger    stored ledger object (or null → fresh)
     report    the CLIENT request body: {type, campaignId, minutes}
     campaigns the SERVED feed (validated array) — the ONLY source of cpms
     now       epoch ms (injected so tests are deterministic)
   returns {ledger, earned, note, error}
     error  structural client error (bad type/campaignId) → 400 upstream
     earned the awarded amount at internal 4-decimal precision (the HTTP
            layer serves it rounded to 2)
     note   human-readable reason when earned is 0 (cap / unknown campaign)
   ------------------------------------------------------------------------ */
function applyEarnings(ledger, report, campaigns, now) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var type = report && report.type;
  if (type !== 'impression' && type !== 'click') {
    return { ledger: ledger, earned: 0, note: null, error: "type must be 'impression' or 'click'" };
  }
  var campaignId = typeof report.campaignId === 'string' ? capStr(report.campaignId, ID_MAX) : '';
  if (!campaignId) {
    return { ledger: ledger, earned: 0, note: null, error: 'campaignId required' };
  }

  /* cpm + click eligibility come from the SERVED feed — never the client. */
  var campaign = null;
  var feed = Array.isArray(campaigns) ? campaigns : [];
  for (var i = 0; i < feed.length; i++) {
    if (feed[i] && feed[i].id === campaignId) { campaign = feed[i]; break; }
  }
  var cpm = campaign ? Number(campaign.cpm) : 0;
  if (!isFinite(cpm)) cpm = 0;

  var day = todayKey(ts);
  var month = monthKey(ts);

  /* Caps read from the STORED ledger (rolled to the current day/month). */
  var l = (ledger && typeof ledger === 'object') ? cloneLedger(ledger) : freshLedger(ts);
  if (!l || typeof l !== 'object') l = freshLedger(ts);
  if (!l.counters || typeof l.counters !== 'object') l.counters = {};
  if (!l.counters.todayClicks || l.counters.todayClicks.date !== day) {
    l.counters.todayClicks = { date: day, count: 0 };
  }
  if (!l.today || l.today.date !== day) l.today = { date: day, total: 0 };
  if (!l.monthly || l.monthly.month !== month) l.monthly = { month: month, total: 0, impressions: 0 };
  if (!Array.isArray(l.rows)) l.rows = [];

  var attemptsToday = Number(l.counters.todayClicks.count) || 0;
  var monthImpressions = Number(l.monthly.impressions) || 0;
  var earned = 0;
  var note = null;

  if (type === 'impression') {
    /* minutes: reported length of this placement batch. Absent → 1;
       garbage/negative → 0 (pays nothing); clamped to 0–60. */
    var minutes;
    if (report.minutes === undefined || report.minutes === null || report.minutes === '') {
      minutes = 1;
    } else {
      minutes = Math.floor(Number(report.minutes));
      if (!isFinite(minutes) || minutes < 0) minutes = 0;
    }
    if (minutes > MAX_MINUTES_PER_REPORT) minutes = MAX_MINUTES_PER_REPORT;

    earned = round4(minutes * cpm / 1000 * USER_SHARE);
    if (!campaign) note = 'unknown campaign — cpm 0';

    l.total = round4((Number(l.total) || 0) + earned);
    l.today.total = round4((Number(l.today.total) || 0) + earned);
    l.monthly.total = round4((Number(l.monthly.total) || 0) + earned);
    l.monthly.impressions = monthImpressions + minutes;
    l.rows.push({ t: ts, type: type, campaignId: campaignId, amount: earned });
    l.counters.impressions = (Number(l.counters.impressions) || 0) + minutes;
  } else {
    /* Click: flat $0.05 when the campaign allows AND both caps allow.
       The daily cap counts ATTEMPTS (paid or not). */
    var clickAllowed = !!(campaign && campaign.allowClicks !== false);
    var capShare = CLICK_CAP_SHARE * monthImpressions;   // exact ≤25% rule

    if (attemptsToday + 1 > CLICK_MAX_PER_DAY) {
      note = 'daily click cap reached (' + CLICK_MAX_PER_DAY + '/day)';
    } else if (attemptsToday + 1 > capShare) {
      note = 'monthly click-share cap reached (≤' + Math.round(CLICK_CAP_SHARE * 100) +
        '% of ' + monthImpressions + ' impressions this month)';
    } else if (!clickAllowed) {
      note = campaign ? 'campaign does not allow paid clicks' : 'unknown campaign — not payable';
    } else {
      earned = round4(CLICK_BONUS);
    }

    l.total = round4((Number(l.total) || 0) + earned);
    l.today.total = round4((Number(l.today.total) || 0) + earned);
    l.monthly.total = round4((Number(l.monthly.total) || 0) + earned);
    l.rows.push({ t: ts, type: type, campaignId: campaignId, amount: earned });
    l.counters.clicks = (Number(l.counters.clicks) || 0) + 1;
    l.counters.todayClicks.count = attemptsToday + 1;
  }

  if (l.rows.length > ROWS_KEPT) l.rows = l.rows.slice(-ROWS_KEPT);
  return { ledger: l, earned: earned, note: note, error: null };
}

/* Serve shape: {total, today:{date,total}, monthly:{month,total},
   rows (last 50, stored order), counters}. */
function ledgerView(ledger) {
  var l = (ledger && typeof ledger === 'object') ? ledger : {};
  var today = (l.today && typeof l.today === 'object') ? l.today : { date: '', total: 0 };
  var monthly = (l.monthly && typeof l.monthly === 'object') ? l.monthly : { month: '', total: 0 };
  var counters = (l.counters && typeof l.counters === 'object') ? l.counters : {};
  return {
    total: round2(Number(l.total) || 0),
    today: { date: today.date || '', total: round2(Number(today.total) || 0) },
    monthly: { month: monthly.month || '', total: round2(Number(monthly.total) || 0) },
    rows: (Array.isArray(l.rows) ? l.rows.slice(-ROWS_SERVED) : []),
    counters: {
      impressions: Number(counters.impressions) || 0,
      clicks: Number(counters.clicks) || 0,
      todayClicks: (counters.todayClicks && typeof counters.todayClicks === 'object')
        ? counters.todayClicks : { date: '', count: 0 }
    }
  };
}

/* Length-safe constant-time-ish compare (length leak is harmless here). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var diff = a.length ^ b.length;
  for (var i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------- plumbing ------------------------------- */
function corsHeaders(extra) {
  var h = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-max-age': '86400',
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders(extra) });
}

/* ---------------------------- KV-backed feed ----------------------------
   Sources, in order:
     1. KV `feed:current` — admin-uploaded (no TTL) or the adapter cache
        (10-min TTL; expires on its own so the adapter is re-polled).
     2. env.ADAPTER_URL — upstream feed, fetched + validated with the same
        rules as the web client, cached to KV with a 10-min TTL, served.
     3. Neither → {campaigns: []} with 200 (clients handle empty).        */
function feedFromKVText(text) {
  if (!text) return null;
  try {
    var parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return validateCampaigns(parsed);
  } catch (e) { return null; }
}

async function getFeed(env) {
  var kv = (env && env.SITE_KV) ? env.SITE_KV : null;

  var cached = null;
  if (kv) {
    try { cached = await kv.get('feed:current'); } catch (e) { cached = null; }
  }
  var fromCache = feedFromKVText(cached);
  if (fromCache && fromCache.length) return { campaigns: fromCache, source: 'kv' };

  var adapterUrl = env && env.ADAPTER_URL ? String(env.ADAPTER_URL) : '';
  if (isValidHttpsUrl(adapterUrl)) {
    try {
      var res = await fetch(adapterUrl, { cf: { cacheTtl: 0 } });
      if (res && res.ok) {
        var parsed = JSON.parse(await res.text());
        var list = Array.isArray(parsed)
          ? parsed
          : (parsed && Array.isArray(parsed.data)) ? parsed.data : [];
        var valid = validateCampaigns(list.slice(0, MAX_UPSTREAM));
        if (valid.length) {
          if (kv) {
            try {
              await kv.put('feed:current', JSON.stringify(valid), { expirationTtl: FEED_TTL_S });
            } catch (e2) { /* KV write failure is non-fatal — serve from memory */ }
          }
          return { campaigns: valid, source: 'adapter' };
        }
      }
    } catch (e) { /* upstream failed — fall through to empty */ }
  }
  return { campaigns: [], source: 'empty' };
}

/* --------------------------- request handlers --------------------------- */
async function handleFeed(env) {
  var feed = await getFeed(env);
  return json({ campaigns: feed.campaigns }, 200, { 'cache-control': 'public, max-age=60' });
}

async function handleTrack(req, env) {
  if (!env || !env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);

  var body;
  try { body = await req.json(); }
  catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'invalid body' }, 400);
  }
  var deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  if (!DEVICE_ID_RE.test(deviceId)) {
    return json({ ok: false, error: 'invalid deviceId' }, 400);
  }

  var feed = await getFeed(env);

  /* Best-effort atomic-ish read-modify-write. KV is eventually consistent;
     free tier = last-write-wins (documented in the security model). */
  var key = 'earn:' + deviceId;
  var ledger = null;
  try {
    var raw = await env.SITE_KV.get(key);
    if (raw) {
      try { ledger = JSON.parse(raw); } catch (e2) { ledger = null; }
    }
  } catch (e3) { ledger = null; }

  var result = applyEarnings(ledger, body, feed.campaigns, Date.now());
  if (result.error) return json({ ok: false, error: result.error }, 400);

  try {
    await env.SITE_KV.put(key, JSON.stringify(result.ledger));
  } catch (e4) {
    return json({ ok: false, error: 'ledger unavailable' }, 503);
  }
  var resp = { ok: true, earned: round2(result.earned), total: round2(result.ledger.total) };
  if (result.note) resp.note = result.note;
  return json(resp, 200);
}

async function handleEarnings(deviceId, env) {
  if (!DEVICE_ID_RE.test(deviceId)) {
    return json({ ok: false, error: 'invalid deviceId' }, 400);
  }
  if (!env || !env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  var ledger = null;
  try {
    var raw = await env.SITE_KV.get('earn:' + deviceId);
    if (raw) { try { ledger = JSON.parse(raw); } catch (e) { ledger = null; } }
  } catch (e2) { ledger = null; }
  return json(ledgerView(ledger), 200);
}

async function handleAdminFeed(req, env) {
  var auth = req.headers.get('authorization') || '';
  var expected = 'Bearer ' + (env && env.ADMIN_TOKEN ? env.ADMIN_TOKEN : '');
  if (!(env && env.ADMIN_TOKEN && safeEqual(auth, expected))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);

  var body;
  try { body = await req.json(); }
  catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  var arr = Array.isArray(body) ? body
    : (body && Array.isArray(body.campaigns)) ? body.campaigns : null;
  if (!arr) return json({ ok: false, error: 'feed must be a JSON array of campaigns' }, 400);
  var valid = validateCampaigns(arr);
  try {
    await env.SITE_KV.put('feed:current', JSON.stringify(valid));
  } catch (e2) {
    return json({ ok: false, error: 'KV unavailable' }, 503);
  }
  return json({ ok: true, count: valid.length }, 200);
}

/* ------------------------------ entrypoint ------------------------------ */
async function handleFetch(request, env, ctx) {
  var url = new URL(request.url);
  var picked = pickRoute(request.method, url.pathname);
  if (!picked.handled) return json({ ok: false, error: 'not found' }, 404);
  try {
    switch (picked.route) {
      case 'preflight':
        return new Response(null, { status: 204, headers: corsHeaders() });
      case 'feed':
        return await handleFeed(env);
      case 'track':
        return await handleTrack(request, env);
      case 'earnings': {
        var deviceId = '';
        try { deviceId = decodeURIComponent(picked.deviceId || ''); }
        catch (e) { return json({ ok: false, error: 'invalid deviceId' }, 400); }
        return await handleEarnings(deviceId, env);
      }
      case 'adminFeed':
        return await handleAdminFeed(request, env);
      case 'health':
        return json({ ok: true }, 200);
    }
  } catch (e) {
    return json({ ok: false, error: 'internal error' }, 500);
  }
  return json({ ok: false, error: 'not found' }, 404);
}

/* Workers service-worker-format listener (guarded — the deployed Worker is
   the ES-module `export default` above; standalone `node --check` and plain
   `import` never register anything). */
if (typeof addEventListener !== 'undefined') {
  addEventListener('fetch', function (event) {
    event.respondWith(handleFetch(event.request, typeof SITE_KV !== 'undefined' ? {
      SITE_KV: SITE_KV,
      ADAPTER_URL: typeof ADAPTER_URL !== 'undefined' ? ADAPTER_URL : '',
      ADMIN_TOKEN: typeof ADMIN_TOKEN !== 'undefined' ? ADMIN_TOKEN : ''
    } : (typeof env !== 'undefined' ? env : {})));
  });
}

/* ES-module format entrypoint (wrangler v3+) — the deploy target. */
export default { fetch: handleFetch };
export {
  handleFetch as workerFetch,
  validateCampaigns,
  applyEarnings,
  pickRoute,
  ledgerView,
  freshLedger,
  round2,
  round4,
  todayKey,
  monthKey,
  USER_SHARE,
  CLICK_BONUS,
  CLICK_MAX_PER_DAY,
  CLICK_CAP_SHARE
};
