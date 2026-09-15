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
     Settings → Variables → Encrypt). No CREDENTIAL is ever committed to
     this repo: wrangler.toml ships no secrets. It does carry the Cloudflare
     account id and KV namespace id, which are non-secret identifiers (they
     grant nothing on their own and appear in every dashboard URL) — they are
     committed deliberately so `wrangler deploy` works out of the box. Fork
     the repo and swap them for your own before deploying.
   • CORS: `access-control-allow-origin: *` on EVERY response (the API is
     public and holds no credentials) + OPTIONS preflight → 204.
   • Abuse caps enforced server-side: ≤5 paid clicks/day per device and
     paid clicks ≤25% of that device's impressions this month. The daily
     cap counts click REPORTS (paid or not) — spammers burn their own quota.
   • Referral codes are NOT device ids. A share link carries a short random
     code the user registers (`refcode:{code}` → deviceId, first writer
     wins); the device id itself is never put in a URL. `GET /referrals/{code}`
     is public because the owner shares the code themselves, but it is
     aggregate-only: anonymous "referee N" rows, no device ids, no ledger
     rows. A referee's credit is held until it passes the 60-minute / 30-day
     activation gate and is voided after the 12-month term; a referee can
     never be its own referrer, and a code can never be re-pointed at a
     different device.
   • `platform` on a report is advisory attribution only (mac | web | pwa |
     agent | …): unrecognised values are counted as 'unknown', and it can
     never change an amount.
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
var ID_MAX = 40, SPONSOR_MAX = 40, TAGLINE_MAX = 90, LOGO_MAX = 2, URL_MAX = 500;
var DEFAULT_ACCENT = '#C98F4E';
var DEVICE_ID_RE = /^[a-f0-9-]{8,64}$/i;

/* --------------------------- flywheel constants -------------------------
   The loop this file closes, server-side:

     capture (any platform)  →  activate (60 verified minutes)  →
     earn (65% base share)   →  share (attributed link)         →  capture…

   with the second, reinforcing half: more verified minutes → advertiser
   value → higher winning bids → bigger user earnings → more sharing.

   Everything money-shaped is here: the referrer's 10% is computed from the
   REFEREE's own base award (platform-side money — the referee's 65% is never
   reduced), gated on activation, and capped at a 12-month term. */
var REFERRAL_SHARE = 0.10;        // 10% of the referee's BASE earnings
var REFERRAL_TERM_DAYS = 365;     // 12-month referral term
var REFERRAL_GATE_MINUTES = 60;   // activation gate: verified minutes…
var REFERRAL_GATE_DAYS = 30;      // …inside the referee's first 30 days
var REF_CODE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;    // lowercase share codes
var PLATFORM_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;   // mac | web | pwa | agent …
var REFERRALS_MAX = 200;          // referees tracked per referrer code
var PLATFORM_MAX = 12;            // distinct platforms counted per ledger

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
  // Object.create(null): ids like "__proto__" must not collide with
  // Object.prototype (a plain {} would wrongly skip them — or throw on
  // assignment under strict-mode runtimes).
  var seen = Object.create(null), out = [];
  for (var i = 0; i < raw.length && out.length < MAX_CAMPAIGNS; i++) {
    var r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    var id = capStr(r.id, ID_MAX);
    var sponsor = capStr(r.sponsor, SPONSOR_MAX);
    if (!id) continue;                        // server: id required (pay-key)
    if (!sponsor) continue;                   // unusable without a name
    if (seen[id]) continue;                   // dedupe by id
    var clickRaw = capStr(r.clickUrl, URL_MAX);
    var click = isValidHttpsUrl(clickRaw) ? clickRaw : '';
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

/* --------------------------- flywheel helpers ---------------------------
   All PURE, all exported for backend/test.mjs.

   Referee binding  (KV `ref:{refereeDeviceId}`)
     { code, t0, minutes, windowMinutes, pending, paid, gated, void }
       minutes        lifetime verified minutes since the claim
       windowMinutes  verified minutes inside the first 30 days (gate fuel)
       pending        credit earned but HELD (gate not passed yet)
       paid           credit already released to the referrer
   Owner record     (KV `refcode:{code}`)   { code, deviceId, t }
   Referee index    (KV `refs:{code}`)      [refereeDeviceId, …]

   `code` is deliberately NOT the device id: the device id is the only
   identifier this platform holds and `GET /earnings/{deviceId}` is public,
   so a share link must never carry it. The client generates a random code
   and registers it — first writer wins, so a leaked code can never be
   re-pointed at someone else's device. */

function normalizeRefCode(val) {
  var c = (typeof val === 'string') ? val.replace(/^\s+|\s+$/g, '').toLowerCase() : '';
  return REF_CODE_RE.test(c) ? c : '';
}

/* Where a placement happened. Advisory only: anything unrecognised (or
   missing) is counted as 'unknown' — never dropped, never guessed. */
function normalizePlatform(val) {
  var p = (typeof val === 'string') ? val.replace(/^\s+|\s+$/g, '').toLowerCase() : '';
  return PLATFORM_RE.test(p) ? p : 'unknown';
}

function bumpPlatform(counters, platform, minutes, clicks) {
  if (!counters || typeof counters !== 'object') return 'unknown';
  if (!counters.platforms || typeof counters.platforms !== 'object') counters.platforms = {};
  var key = normalizePlatform(platform);
  var cur = counters.platforms[key];
  if (!cur || typeof cur !== 'object') {
    // Bound KV growth: beyond PLATFORM_MAX distinct keys, fold into 'other'.
    var known = 0;
    for (var k in counters.platforms) {
      if (Object.prototype.hasOwnProperty.call(counters.platforms, k)) known++;
    }
    if (known >= PLATFORM_MAX && key !== 'other') key = 'other';
    cur = counters.platforms[key];
    if (!cur || typeof cur !== 'object') cur = counters.platforms[key] = { minutes: 0, clicks: 0 };
  }
  cur.minutes = (Number(cur.minutes) || 0) + (Number(minutes) || 0);
  cur.clicks = (Number(cur.clicks) || 0) + (Number(clicks) || 0);
  return key;
}

/* Sorted {platform, minutes, clicks}[] from a ledger's counters. */
function platformsOf(counters) {
  var out = [];
  var p = (counters && typeof counters === 'object' && counters.platforms) || {};
  for (var k in p) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
    var v = (p[k] && typeof p[k] === 'object') ? p[k] : {};
    out.push({
      platform: k,
      minutes: Number(v.minutes) || 0,
      clicks: Number(v.clicks) || 0
    });
  }
  out.sort(function (a, b) {
    if (b.minutes !== a.minutes) return b.minutes - a.minutes;
    return a.platform < b.platform ? -1 : (a.platform > b.platform ? 1 : 0);
  });
  return out;
}

/* Owner side: bind `code` → `deviceId`. First writer wins. */
function applyReferralRegister(existing, deviceId, code, now) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var c = normalizeRefCode(code);
  if (!c) return { record: existing || null, created: false, error: 'invalid referral code (3–32 chars: a–z, 0–9, -)' };
  if (!DEVICE_ID_RE.test(String(deviceId || ''))) {
    return { record: existing || null, created: false, error: 'invalid deviceId' };
  }
  if (existing && typeof existing === 'object' && existing.deviceId) {
    return {
      record: existing, created: false, error: null,
      note: existing.deviceId === deviceId ? 'already registered' : 'code already registered to another device'
    };
  }
  return { record: { code: c, deviceId: deviceId, t: ts }, created: true, error: null, note: null };
}

/* Referee side: bind this device to a referrer code. Idempotent — the first
   claim wins and a later one is refused (not silently re-bound). */
function applyReferralClaim(existing, code, now) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var c = normalizeRefCode(code);
  if (!c) return { record: existing || null, claimed: false, error: 'invalid referral code', note: null };
  if (existing && typeof existing === 'object' && existing.code) {
    return { record: existing, claimed: false, error: null, note: 'already bound to ' + existing.code };
  }
  return {
    record: { code: c, t0: ts, minutes: 0, windowMinutes: 0, pending: 0, paid: 0, gated: false, void: false },
    claimed: true, error: null, note: null
  };
}

/* Referee accrual — called on every verified impression. Returns the updated
   binding plus the credit the REFERRER earns for it:
     • gate unmet  → credit 0, the amount is HELD in `pending`
     • gate passed → held credit is released retroactively (one payment)
     • gate missed (30 days under 60 minutes) or term ended → void, 0
   Pure: the input binding is never mutated. */
function applyReferralAccrual(binding, minutes, baseEarned, now) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  if (!binding || typeof binding !== 'object' || !binding.code) {
    return { binding: binding || null, credit: 0, note: null };
  }
  var b = cloneLedger(binding) || binding;
  var m = Math.floor(Number(minutes));
  if (!isFinite(m) || m < 0) m = 0;
  var base = Number(baseEarned);
  if (!isFinite(base) || base <= 0) base = 0;

  b.minutes = (Number(b.minutes) || 0) + m;
  var ageDays = (ts - (Number(b.t0) || ts)) / 86400000;

  if (ageDays > REFERRAL_TERM_DAYS) {
    b.void = true; b.pending = 0;
    return { binding: b, credit: 0, note: 'referral term ended (12 months)' };
  }

  var share = round4(base * REFERRAL_SHARE);

  if (!b.gated) {
    if (ageDays <= REFERRAL_GATE_DAYS) b.windowMinutes = (Number(b.windowMinutes) || 0) + m;
    b.pending = round4((Number(b.pending) || 0) + share);
    if ((Number(b.windowMinutes) || 0) >= REFERRAL_GATE_MINUTES) {
      var release = round4(Number(b.pending) || 0);
      b.gated = true; b.pending = 0; b.void = false;
      b.paid = round4((Number(b.paid) || 0) + release);
      return { binding: b, credit: release, note: 'gate passed — held credit released' };
    }
    if (ageDays > REFERRAL_GATE_DAYS) {
      b.void = true; b.pending = 0;
      return { binding: b, credit: 0, note: 'gate missed (≥60 verified minutes required in the first 30 days)' };
    }
    return { binding: b, credit: 0, note: 'gate pending (≥60 verified minutes in the first 30 days)' };
  }

  b.paid = round4((Number(b.paid) || 0) + share);
  return { binding: b, credit: share, note: null };
}

/* Referrer side: add a released credit to the referrer's own ledger — PURE.
   The row carries type 'referral' and an EMPTY campaignId on purpose: the
   advertiser-facing /stats rollup skips rows without a campaign id, so
   referral cost can never be billed to (or hidden inside) a campaign. */
function applyReferralCredit(ledger, amount, now) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var amt = round4(Number(amount) || 0);
  var l = (ledger && typeof ledger === 'object') ? cloneLedger(ledger) : freshLedger(ts);
  if (!l || typeof l !== 'object') l = freshLedger(ts);
  if (!l.referral || typeof l.referral !== 'object') l.referral = { total: 0 };
  if (!Array.isArray(l.rows)) l.rows = [];
  if (!l.today || l.today.date !== todayKey(ts)) l.today = { date: todayKey(ts), total: 0 };
  if (!l.monthly || l.monthly.month !== monthKey(ts)) l.monthly = { month: monthKey(ts), total: 0, impressions: 0 };
  if (amt > 0) {
    l.total = round4((Number(l.total) || 0) + amt);
    l.today.total = round4((Number(l.today.total) || 0) + amt);
    l.monthly.total = round4((Number(l.monthly.total) || 0) + amt);
    l.referral.total = round4((Number(l.referral.total) || 0) + amt);
    l.rows.push({ t: ts, type: 'referral', campaignId: '', amount: amt, minutes: 0 });
    if (l.rows.length > ROWS_KEPT) l.rows = l.rows.slice(-ROWS_KEPT);
  }
  return l;
}

/* Referee-side status for the earnings response. Aggregate-shaped only —
   no referrer identity beyond the public code, no device ids anywhere. */
function refereeView(binding, now) {
  var b = (binding && typeof binding === 'object') ? binding : null;
  if (!b || !normalizeRefCode(b.code)) return null;
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var ageDays = (ts - (Number(b.t0) || ts)) / 86400000;
  var gate = b.gated ? 'passed' : ((b.void || ageDays > REFERRAL_GATE_DAYS) ? 'void' : 'pending');
  return {
    refereeOf: normalizeRefCode(b.code),
    gate: gate,
    minutes: Math.round(Number(b.minutes) || 0),
    windowMinutes: Math.round(Number(b.windowMinutes) || 0),
    gateMinutes: REFERRAL_GATE_MINUTES,
    gateDaysLeft: gate === 'pending' ? Math.max(0, Math.ceil(REFERRAL_GATE_DAYS - ageDays)) : 0,
    termDaysLeft: Math.max(0, Math.ceil(REFERRAL_TERM_DAYS - ageDays))
  };
}

/* Referrer-side view: one anonymous row per referee ('referee 1', 'referee 2'
   …) — never a device id, never a ledger row. */
function referralView(code, bindings, ledger) {
  var c = normalizeRefCode(code);
  var list = Array.isArray(bindings) ? bindings : [];
  var out = [], gated = 0, minutes = 0, accrued = 0, held = 0;
  for (var i = 0; i < list.length && i < REFERRALS_MAX; i++) {
    var b = (list[i] && typeof list[i] === 'object') ? list[i] : {};
    var m = Math.round(Number(b.minutes) || 0);
    var paid = Number(b.paid) || 0;
    var pend = Number(b.pending) || 0;
    if (b.gated) gated++;
    minutes += m; accrued += paid; held += pend;
    out.push({
      label: 'referee ' + (i + 1),
      minutes: m,
      gate: b.gated ? 'passed' : (b.void ? 'void' : 'pending'),
      accrued: round2(paid)
    });
  }
  var l = (ledger && typeof ledger === 'object') ? ledger : {};
  return {
    code: c,
    referees: out,
    totals: {
      referees: out.length,
      gated: gated,
      minutes: minutes,
      accrued: round2(accrued),   // released into the referrer's ledger
      held: round2(held)          // earned but still gated — never paid early
    },
    termDays: REFERRAL_TERM_DAYS,
    gateMinutes: REFERRAL_GATE_MINUTES,
    gateDays: REFERRAL_GATE_DAYS,
    ledgerTotal: round2(Number(l.total) || 0)
  };
}

/* ------------------------------- pickRoute ------------------------------
   Pure router: (method, pathname) → {handled, route, deviceId?}.        */
function pickRoute(method, pathname) {
  if (method === 'OPTIONS') return { handled: true, route: 'preflight' };
  if (method === 'GET' && pathname === '/feed.json') return { handled: true, route: 'feed' };
  if (method === 'GET' && pathname === '/stats') return { handled: true, route: 'stats' };
  if (method === 'GET' && pathname === '/health') return { handled: true, route: 'health' };
  if (method === 'POST' && pathname === '/track') return { handled: true, route: 'track' };
  if (method === 'POST' && pathname === '/admin/feed') return { handled: true, route: 'adminFeed' };
  if (method === 'POST' && pathname === '/referral') return { handled: true, route: 'referral' };
  if (method === 'GET' && /^\/referrals\/[^/]+$/.test(pathname)) {
    return { handled: true, route: 'referrals', code: pathname.split('/')[2] || '' };
  }
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
    referral: { total: 0 },   // lifetime referral credit (referrer side)
    rows: [],
    counters: {
      impressions: 0,
      clicks: 0,
      todayClicks: { date: todayKey(ts), count: 0 },
      platforms: {}           // { mac: {minutes, clicks}, web: …, agent: … }
    }
  };
}

/* Deep-clone via JSON — every value in the ledger is JSON-shaped, and the
   helpers stay PURE (the input ledger is never mutated). */
function cloneLedger(l) {
  try { return JSON.parse(JSON.stringify(l)); } catch (e) { return null; }
}

/* ------------------------------ applyEarnings ---------------------------
   The money brain — PURE (never mutates its inputs), no network, no KV.

   applyEarnings(ledger, report, campaigns, now, referral)
     ledger    stored ledger object (or null → fresh)
     report    the CLIENT request body: {type, campaignId, minutes, platform}
     campaigns the SERVED feed (validated array) — the ONLY source of cpms
     now       epoch ms (injected so tests are deterministic)
     referral  this device's referee binding (KV `ref:{deviceId}`) or null —
               when present, the REFERRER's share is computed here, from the
               referee's own base award (never from the referee's balance)
   returns {ledger, earned, note, error, referrerCredit, referrerBinding,
            referralNote, platform}
     error  structural client error (bad type/campaignId) → 400 upstream
     earned the awarded amount at internal 4-decimal precision (the HTTP
            layer serves it rounded to 2)
     note   human-readable reason when earned is 0 (cap / unknown campaign)
     referrerCredit  what the REFERRER earns from this report (0 while the
                     gate is unmet — the amount is held in the binding)
     platform        the normalized platform key the placement was counted in
   ------------------------------------------------------------------------ */
function applyEarnings(ledger, report, campaigns, now, referral) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var type = report && report.type;
  if (type !== 'impression' && type !== 'click') {
    return { ledger: ledger, earned: 0, note: null, error: "type must be 'impression' or 'click'" };
  }
  var campaignId = typeof report.campaignId === 'string' ? capStr(report.campaignId, ID_MAX) : '';
  if (!campaignId) {
    return { ledger: ledger, earned: 0, note: null, error: 'campaignId required' };
  }
  var platform = normalizePlatform(report.platform);

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
  if (!l.referral || typeof l.referral !== 'object') l.referral = { total: 0 };
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
    // minutes rides along so delivery reporting can sum verified minutes
    // per campaign (rows written before v1.1.3 lack it and count as 1).
    l.rows.push({ t: ts, type: type, campaignId: campaignId, amount: earned, minutes: minutes });
    l.counters.impressions = (Number(l.counters.impressions) || 0) + minutes;
    bumpPlatform(l.counters, platform, minutes, 0);
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
    bumpPlatform(l.counters, platform, 0, 1);
  }

  if (l.rows.length > ROWS_KEPT) l.rows = l.rows.slice(-ROWS_KEPT);

  /* Referral accrual (impressions only): the referrer's 10% is derived from
     THIS referee's base award, held until the activation gate passes, and
     voided after the 30-day window or the 12-month term. A malformed binding
     can only ever yield credit 0 — it can never grow the referee's own pay. */
  var referrerCredit = 0, referrerBinding = null, referralNote = null;
  if (type === 'impression' && referral) {
    var acc = applyReferralAccrual(referral, minutes, earned, ts);
    referrerBinding = acc.binding || null;
    referrerCredit = Number(acc.credit) || 0;
    referralNote = acc.note || null;
  }

  return {
    ledger: l, earned: earned, note: note, error: null,
    referrerCredit: referrerCredit,
    referrerBinding: referrerBinding,
    referralNote: referralNote,
    platform: platform
  };
}

/* Serve shape: {total, today:{date,total}, monthly:{month,total}, referral,
   platforms, referee|null, rows (last 50, stored order), counters}.

   opts (optional) = { now, referral } — `referral` is this device's referee
   binding; when present the response carries the referee's own gate status
   (aggregate-shaped, no referrer identity beyond the public code). */
function ledgerView(ledger, opts) {
  var o = (opts && typeof opts === 'object') ? opts : {};
  var l = (ledger && typeof ledger === 'object') ? ledger : {};
  var today = (l.today && typeof l.today === 'object') ? l.today : { date: '', total: 0 };
  var monthly = (l.monthly && typeof l.monthly === 'object') ? l.monthly : { month: '', total: 0 };
  var counters = (l.counters && typeof l.counters === 'object') ? l.counters : {};
  var ref = (l.referral && typeof l.referral === 'object') ? l.referral : {};
  return {
    total: round2(Number(l.total) || 0),
    today: { date: today.date || '', total: round2(Number(today.total) || 0) },
    monthly: { month: monthly.month || '', total: round2(Number(monthly.total) || 0) },
    referral: { total: round2(Number(ref.total) || 0) },
    platforms: platformsOf(counters),
    referee: refereeView(o.referral, o.now),
    rows: (Array.isArray(l.rows) ? l.rows.slice(-ROWS_SERVED) : []),
    counters: {
      impressions: Number(counters.impressions) || 0,
      clicks: Number(counters.clicks) || 0,
      todayClicks: (counters.todayClicks && typeof counters.todayClicks === 'object')
        ? counters.todayClicks : { date: '', count: 0 }
    }
  };
}

/* ------------------------- delivery reporting ---------------------------
   GET /stats (PUBLIC, aggregate-only): per-campaign delivery rolled up
   across every stored ledger — verified minutes, reported clicks, and
   user-share spend — plus network totals and the served feed size. No
   device ids, no rows, no per-device anything ever leaves this endpoint,
   so the advertiser page calls it directly with no token. KV scanning is
   capped (STATS_MAX_KEYS) to bound the work on the free tier. */
var STATS_MAX_KEYS = 1000;

function aggregateStats(ledgers, feed) {
  var names = Object.create(null);   // feed ids can be "__proto__" too
  var f = Array.isArray(feed) ? feed : [];
  for (var i = 0; i < f.length; i++) {
    if (f[i] && typeof f[i].id === 'string') {
      names[f[i].id] = (typeof f[i].sponsor === 'string') ? f[i].sponsor : '';
    }
  }
  var per = Object.create(null);   // campaign ids can be "__proto__" etc.
  var plat = Object.create(null);  // { platform: {minutes, clicks} } — flywheel mix
  var referralSpend = 0;           // platform-side referral cost, never a campaign's
  var earners = 0;
  for (var d = 0; d < ledgers.length; d++) {
    var l = ledgers[d];
    // Count real ledger objects only — corrupt KV values (strings, arrays)
    // are skipped by the caller, but never let one mint an earner.
    if (!l || typeof l !== 'object' || Array.isArray(l) || !Array.isArray(l.rows)) continue;
    earners++;
    referralSpend += Number(l.referral && l.referral.total) || 0;
    var ps = platformsOf(l.counters);
    for (var pi = 0; pi < ps.length; pi++) {
      var pk = ps[pi].platform;
      var pe = plat[pk] || (plat[pk] = { platform: pk, minutes: 0, clicks: 0 });
      pe.minutes += ps[pi].minutes;
      pe.clicks += ps[pi].clicks;
    }
    var rows = l.rows;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || {};
      var id = (typeof row.campaignId === 'string') ? row.campaignId : '';
      if (!id) continue;
      var e = per[id] || (per[id] = { id: id, sponsor: names[id] || '', impressions: 0, clicks: 0, spend: 0 });
      var amt = round4(Number(row.amount) || 0);
      if (row.type === 'click') {
        e.clicks += 1;   // reported clicks (paid or not — caps burn quota)
      } else {
        // Explicit minutes:0 means 0 (matches ledger counters); only
        // missing/NaN (pre-v1.1.3 rows) falls back to 1.
        var mraw = row.minutes;
        var m = (mraw === undefined || mraw === null) ? NaN : Math.floor(Number(mraw));
        e.impressions += isFinite(m) ? Math.max(0, m) : 1;
      }
      e.spend = round4(e.spend + amt);
    }
  }
  var campaigns = [];
  var tI = 0, tC = 0, tS4 = 0;
  for (var k in per) {
    var c = per[k];
    tS4 = round4(tS4 + c.spend);
    c.spend = round2(c.spend);
    campaigns.push(c);
    tI += c.impressions; tC += c.clicks;
  }
  campaigns.sort(function (a, b) {
    if (b.spend !== a.spend) return b.spend - a.spend;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  var platforms = [];
  for (var pk2 in plat) {
    if (!Object.prototype.hasOwnProperty.call(plat, pk2)) continue;
    platforms.push(plat[pk2]);
  }
  platforms.sort(function (a, b) {
    if (b.minutes !== a.minutes) return b.minutes - a.minutes;
    return a.platform < b.platform ? -1 : (a.platform > b.platform ? 1 : 0);
  });
  return {
    campaigns: campaigns,
    totals: { impressions: tI, clicks: tC, spend: round2(tS4), earners: earners },
    platforms: platforms,
    referralSpend: round2(referralSpend),
    served: f.length
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
  /* A KV value that parses to an array is served as-is — including an EMPTY
     one. The adapter below only ever writes when it has at least one valid
     campaign, so `[]` in KV can only mean an admin deliberately cleared the
     feed (POST /admin/feed with []). Falling through on empty would silently
     resurrect the adapter feed the admin just turned off. */
  if (fromCache) return { campaigns: fromCache, source: 'kv' };

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

/* /stats — PUBLIC, aggregate-only. `totals` stays the delivery rollup (one
   key set advertisers already read); the flywheel additions ride alongside:
   `platforms` (where the verified minutes happened) and `referralSpend`
   (platform-side referral cost — never billed to a campaign). */
async function handleStats(env) {
  var feed = await getFeed(env);
  var zeros = {
    campaigns: [],
    totals: { impressions: 0, clicks: 0, spend: 0, earners: 0 },
    platforms: [],
    referralSpend: 0,
    served: feed.campaigns.length
  };
  if (!env || !env.SITE_KV || typeof env.SITE_KV.list !== 'function') {
    return json(zeros, 200, { 'cache-control': 'public, max-age=60' });
  }
  try {
    var ledgers = [];
    var cursor = undefined;
    for (var pages = 0; pages < 20; pages++) {
      var page = await env.SITE_KV.list({ prefix: 'earn:', limit: 100, cursor: cursor });
      if (!page || !Array.isArray(page.keys)) break;
      for (var i = 0; i < page.keys.length && ledgers.length < STATS_MAX_KEYS; i++) {
        try {
          var raw = await env.SITE_KV.get(page.keys[i].name);
          if (raw) { try { ledgers.push(JSON.parse(raw)); } catch (e) { /* skip corrupt */ } }
        } catch (e2) { /* skip unreadable */ }
      }
      if (page.list_complete || !page.cursor) break;
      cursor = page.cursor;
    }
    var agg = aggregateStats(ledgers, feed.campaigns);
    agg.served = feed.campaigns.length;
    return json(agg, 200, { 'cache-control': 'public, max-age=60' });
  } catch (e3) {
    return json({ ok: false, error: 'stats unavailable' }, 503);
  }
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

  /* Referee binding (KV `ref:{deviceId}`) — present only when this device
     arrived through someone's share link. A missing or corrupt binding means
     "no referral"; it can never block or inflate this device's own pay. */
  var binding = null;
  try {
    var braw = await env.SITE_KV.get('ref:' + deviceId);
    if (braw) { try { binding = JSON.parse(braw); } catch (e5) { binding = null; } }
  } catch (e6) { binding = null; }
  if (binding && !normalizeRefCode(binding.code)) binding = null;

  var result = applyEarnings(ledger, body, feed.campaigns, Date.now(), binding);
  if (result.error) return json({ ok: false, error: result.error }, 400);

  try {
    await env.SITE_KV.put(key, JSON.stringify(result.ledger));
  } catch (e4) {
    return json({ ok: false, error: 'ledger unavailable' }, 503);
  }

  var resp = { ok: true, earned: round2(result.earned), total: round2(result.ledger.total) };
  if (result.note) resp.note = result.note;
  resp.platform = result.platform;

  /* The loop closes HERE. If this report pushed the referee through (or past)
     the activation gate, the referrer's 10% is credited to the referrer's own
     ledger — platform-side money, separate from the referee's 65%. Both
     writes are best-effort: a failure never fails the referee's report. */
  if (binding && result.referrerBinding) {
    try {
      await env.SITE_KV.put('ref:' + deviceId, JSON.stringify(result.referrerBinding));
    } catch (e7) { /* binding refresh is best-effort */ }
  }
  if (binding && result.referrerCredit > 0) {
    var credited = await creditReferrer(env, binding.code, deviceId, result.referrerCredit, Date.now());
    resp.referral = {
      referrer: binding.code,
      released: round2(result.referrerCredit),
      credited: !!(credited && credited.credited)
    };
    if (credited && credited.note) resp.referral.note = credited.note;
  } else if (binding && result.referralNote) {
    resp.referral = { referrer: binding.code, released: 0, credited: false, note: result.referralNote };
  }
  return json(resp, 200);
}

/* Pay the referrer: `refcode:{code}` → the owner's device id → its ledger,
   add the released credit (applyReferralCredit), write it back. Guards: an
   unregistered code, a self-referral, or an unreadable ledger all end in
   `credited:false` with a reason — never in a silent wrong payment. */
async function creditReferrer(env, code, refereeDeviceId, amount, now) {
  var c = normalizeRefCode(code);
  if (!c) return { credited: false, note: 'invalid referral code' };
  if (!env || !env.SITE_KV) return { credited: false, note: 'KV not configured' };

  var owner = '';
  try {
    var craw = await env.SITE_KV.get('refcode:' + c);
    if (craw) {
      var rec = JSON.parse(craw);
      if (rec && typeof rec.deviceId === 'string') owner = rec.deviceId;
    }
  } catch (e) { owner = ''; }
  if (!DEVICE_ID_RE.test(owner)) return { credited: false, note: 'referrer code not registered' };
  if (owner === refereeDeviceId) return { credited: false, note: 'self-referral ignored' };

  var key = 'earn:' + owner;
  var ledger = null;
  try {
    var raw = await env.SITE_KV.get(key);
    if (raw) { try { ledger = JSON.parse(raw); } catch (e2) { ledger = null; } }
  } catch (e3) { ledger = null; }

  var next = applyReferralCredit(ledger, amount, now);
  try {
    await env.SITE_KV.put(key, JSON.stringify(next));
  } catch (e4) {
    return { credited: false, note: 'referrer ledger unavailable' };
  }
  return { credited: true, referrerTotal: round2(Number(next.total) || 0) };
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

  /* Referee side of the loop: if this device arrived through a share link,
     report its own activation-gate progress (aggregate-shaped — the referrer
     is a public code, nothing else). */
  var binding = null;
  try {
    var braw = await env.SITE_KV.get('ref:' + deviceId);
    if (braw) { try { binding = JSON.parse(braw); } catch (e3) { binding = null; } }
  } catch (e4) { binding = null; }

  return json(ledgerView(ledger, { now: Date.now(), referral: binding }), 200);
}

/* POST /referral — the two halves of a share link:
     action 'register' (default) → this device OWNS `code`
     action 'claim'              → this device IS a referee of `code`
   Split by an explicit `action` so a device can never register itself as its
   own referee (creditReferrer refuses self-referrals as a second line). */
async function handleReferral(req, env) {
  if (!env || !env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);

  var body;
  try { body = await req.json(); }
  catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'invalid body' }, 400);
  }
  var deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  if (!DEVICE_ID_RE.test(deviceId)) return json({ ok: false, error: 'invalid deviceId' }, 400);
  var code = normalizeRefCode(body.code);
  if (!code) return json({ ok: false, error: 'invalid referral code (3–32 chars: a–z, 0–9, -)' }, 400);

  var action = body.action === 'register' ? 'register' : 'claim';
  var now = Date.now();

  if (action === 'register') {
    var existing = null;
    try {
      var raw = await env.SITE_KV.get('refcode:' + code);
      if (raw) { try { existing = JSON.parse(raw); } catch (e1) { existing = null; } }
    } catch (e2) { existing = null; }
    var reg = applyReferralRegister(existing, deviceId, code, now);
    if (reg.error) return json({ ok: false, error: reg.error }, 400);
    if (reg.created) {
      try {
        await env.SITE_KV.put('refcode:' + code, JSON.stringify(reg.record));
      } catch (e3) {
        return json({ ok: false, error: 'KV unavailable' }, 503);
      }
    }
    return json({
      ok: true, action: 'register', code: code,
      created: !!reg.created, note: reg.note || null
    }, 200);
  }

  /* claim — the code must belong to a real (registered) owner, and this
     device must not already be bound: the first claim wins. */
  var ownerRecord = null;
  try {
    var craw = await env.SITE_KV.get('refcode:' + code);
    if (craw) { try { ownerRecord = JSON.parse(craw); } catch (e4) { ownerRecord = null; } }
  } catch (e5) { ownerRecord = null; }
  if (!ownerRecord || !DEVICE_ID_RE.test(String(ownerRecord.deviceId || ''))) {
    return json({ ok: true, action: 'claim', claimed: false, code: code, note: 'unknown referral code' }, 200);
  }
  if (ownerRecord.deviceId === deviceId) {
    return json({ ok: true, action: 'claim', claimed: false, code: code, note: 'self-referral ignored' }, 200);
  }

  var mine = null;
  try {
    var mraw = await env.SITE_KV.get('ref:' + deviceId);
    if (mraw) { try { mine = JSON.parse(mraw); } catch (e6) { mine = null; } }
  } catch (e7) { mine = null; }

  var claim = applyReferralClaim(mine, code, now);
  if (claim.error) return json({ ok: false, error: claim.error }, 400);
  if (!claim.claimed) {
    return json({ ok: true, action: 'claim', claimed: false, code: code, note: claim.note || null }, 200);
  }

  try {
    await env.SITE_KV.put('ref:' + deviceId, JSON.stringify(claim.record));
    var idx = [];
    try {
      var iraw = await env.SITE_KV.get('refs:' + code);
      if (iraw) { var parsedIdx = JSON.parse(iraw); if (Array.isArray(parsedIdx)) idx = parsedIdx; }
    } catch (e8) { idx = []; }
    if (idx.indexOf(deviceId) === -1 && idx.length < REFERRALS_MAX) {
      idx.push(deviceId);
      await env.SITE_KV.put('refs:' + code, JSON.stringify(idx));
    }
  } catch (e9) {
    return json({ ok: false, error: 'KV unavailable' }, 503);
  }
  return json({ ok: true, action: 'claim', claimed: true, code: code }, 200);
}

/* GET /referrals/{code} — the referrer's own view of the loop. PUBLIC by
   design (the referrer shares the code themselves) but aggregate-only: one
   anonymous row per referee, no device ids, no ledger rows, ever. */
async function handleReferrals(code, env) {
  var c = normalizeRefCode(code);
  if (!c) return json({ ok: false, error: 'invalid referral code' }, 400);
  if (!env || !env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);

  var owner = '';
  try {
    var craw = await env.SITE_KV.get('refcode:' + c);
    if (craw) {
      var rec = JSON.parse(craw);
      if (rec && typeof rec.deviceId === 'string') owner = rec.deviceId;
    }
  } catch (e) { owner = ''; }

  var ids = [];
  try {
    var iraw = await env.SITE_KV.get('refs:' + c);
    if (iraw) { var parsed = JSON.parse(iraw); if (Array.isArray(parsed)) ids = parsed; }
  } catch (e2) { ids = []; }

  var bindings = [];
  for (var i = 0; i < ids.length && i < REFERRALS_MAX; i++) {
    if (!DEVICE_ID_RE.test(String(ids[i] || ''))) continue;
    try {
      var braw = await env.SITE_KV.get('ref:' + ids[i]);
      if (!braw) continue;
      var b = JSON.parse(braw);
      if (b && normalizeRefCode(b.code) === c) bindings.push(b);
    } catch (e3) { /* skip an unreadable referee */ }
  }

  var ledger = null;
  if (DEVICE_ID_RE.test(owner)) {
    try {
      var lraw = await env.SITE_KV.get('earn:' + owner);
      if (lraw) { try { ledger = JSON.parse(lraw); } catch (e4) { ledger = null; } }
    } catch (e5) { ledger = null; }
  }

  var view = referralView(c, bindings, ledger);
  view.registered = !!owner;
  return json(view, 200);
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
  try {
    var url = new URL(request.url);
    var picked = pickRoute(request.method, url.pathname);
    if (!picked.handled) return json({ ok: false, error: 'not found' }, 404);
    switch (picked.route) {
      case 'preflight':
        return new Response(null, { status: 204, headers: corsHeaders() });
      case 'feed':
        return await handleFeed(env);
      case 'stats':
        return await handleStats(env);
      case 'track':
        return await handleTrack(request, env);
      case 'earnings': {
        var deviceId = '';
        try { deviceId = decodeURIComponent(picked.deviceId || ''); }
        catch (e) { return json({ ok: false, error: 'invalid deviceId' }, 400); }
        return await handleEarnings(deviceId, env);
      }
      case 'referral':
        return await handleReferral(request, env);
      case 'referrals': {
        var refCode = '';
        try { refCode = decodeURIComponent(picked.code || ''); }
        catch (e) { return json({ ok: false, error: 'invalid referral code' }, 400); }
        return await handleReferrals(refCode, env);
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
  aggregateStats,
  pickRoute,
  ledgerView,
  freshLedger,
  getFeed,
  round2,
  round4,
  todayKey,
  monthKey,
  USER_SHARE,
  CLICK_BONUS,
  CLICK_MAX_PER_DAY,
  CLICK_CAP_SHARE,
  /* flywheel */
  normalizeRefCode,
  normalizePlatform,
  bumpPlatform,
  platformsOf,
  applyReferralRegister,
  applyReferralClaim,
  applyReferralAccrual,
  applyReferralCredit,
  refereeView,
  referralView,
  REFERRAL_SHARE,
  REFERRAL_TERM_DAYS,
  REFERRAL_GATE_MINUTES,
  REFERRAL_GATE_DAYS,
  REFERRALS_MAX
};
