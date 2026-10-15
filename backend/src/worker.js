import { PILOT_LIST_KEY, PILOT_KEY_PREFIX, newPilot, transitionPilot,
  confirmPilotRevenue, fundPromotionalPool, eligiblePilotView, proofGate,
  settlementGate } from './pilots.js';

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
     activation gate and is voided after the 30-day term; a referee can
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
    • Impression: minutes × cpm ÷ 1000 × 0.70 (user base share). `minutes`
     is the reported length of the placement batch (0–60 per report,
     clamped server-side; defaults to 1 when absent).
   • Click: flat $0.05 when the caps allow.
   • Rounded to 4 decimals internally while accumulating; served at 2.
   ========================================================================== */

/* ------------------------------ constants ------------------------------- */
var USER_SHARE = 0.70;
var LAUNCH_SHARE = 0.10;
var REFEREE_SHARE = 0.05;
var REFERRAL_CLICK_DAYS = 14;
var SERVING_MIN_CPM = 2;
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

      capture (any platform)  →  activate (first valid impression)  →
      earn (70% base share)   →  share (attributed link)         →  capture…

    with the second, reinforcing half: more verified minutes → advertiser
    value → higher winning bids → bigger user earnings → more sharing.

    Everything money-shaped is here: the referrer's 5% is computed from the
    REFEREE's own base award (platform-side money — the referee's 70% is never
    reduced), with a 5% referee bonus, 14-day last-click attribution, and a 30-day term. */
var REFERRAL_SHARE = 0.05;
var REFERRAL_TERM_DAYS = 30;
var REFERRAL_GATE_MINUTES = 0;
var REFERRAL_GATE_DAYS = 30;
var REF_CODE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;    // lowercase share codes
var PLATFORM_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;   // mac | web | pwa | agent …
var REFERRALS_MAX = 200;          // referees tracked per referrer code
var PLATFORM_MAX = 12;            // distinct platforms counted per ledger
var REGION_LIST_MAX = 40;         // regions/surfaces reported per campaign

/* --------------------------------- slots ---------------------------------
   A SLOT is one hour-block on one UTC calendar day: the atomic unit of
   Mac status area inventory. Advertisers bid a CPM on any number of slots; on each
   slot the HIGHEST BID takes the whole window (winner takes all), ties going
   to the earlier bid. Slots are independent — winning Tue 08–12 says nothing
   about Tue 12–16.

   Storage is one KV key per calendar month, `slots:YYYY-MM`, holding
     { "YYYY-MM-DD": { "<block>": [bid, …] } }
   so a whole month's grid is a single read and a bid rewrites only the month
   it lands in. A bid carries the same campaign payload as a feed campaign, so
   a slot winner is served — and paid — by the existing engine untouched:
   applyEarnings looks its cpm up by campaignId in the served list.
   ------------------------------------------------------------------------- */
var SLOT_BLOCK_HOURS = 4;                      // 6 blocks/day: 00–04 … 20–24
var SLOT_BLOCKS_PER_DAY = 24 / SLOT_BLOCK_HOURS;
var SLOT_MIN_CPM = 2;
var SLOT_MAX_PER_REQUEST = 200;                // slots per bid request
var SLOT_BIDS_KEPT = 20;                       // top bids retained per slot
var SLOT_MAX_AHEAD_DAYS = 400;                 // ~13 months of bookable future
var SLOT_RATE_PER_DAY = 120;                   // bid requests/day/IP
var BIDDER_MAX = 120;                          // bidder contact string cap
var SLOT_ID_RE = /^(\d{4})-(\d{2})-(\d{2})#(\d{1,2})$/;
var MONTH_RE = /^(\d{4})-(\d{2})$/;

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

/* Coarse region for delivery reporting: an ISO-3166 alpha-2 country code, or
   'unknown'. The client reports it — we never geo-locate an IP, so this is
   device-asserted, not verified, and the advertiser report says so. */
function normalizeRegion(val) {
  var r = (typeof val === 'string') ? val.replace(/^\s+|\s+$/g, '').toUpperCase() : '';
  return /^[A-Z]{2}$/.test(r) ? r : 'unknown';
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
function applyReferralClaim(existing, code, now, refresh) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var c = normalizeRefCode(code);
  if (!c) return { record: existing || null, claimed: false, error: 'invalid referral code', note: null };
  if (existing && typeof existing === 'object' && existing.code) {
    if (Number.isFinite(existing.firstValidImpressionAt) || existing.gated || existing.minutes > 0 ||
        (existing.code === c && !refresh)) {
      return { record: existing, claimed: false, error: null, note: 'already bound to ' + existing.code };
    }
  }
  return {
    record: { code: c, version: 2, clickedAt: ts, firstValidImpressionAt: null,
      t0: ts, minutes: 0, windowMinutes: 0, pending: 0, paid: 0, refereePaid: 0, gated: false, void: false },
    claimed: true, error: null, note: null
  };
}

/* Referee accrual — called on every verified impression. Returns the updated
   binding plus the platform-side credits for it:
     • valid attribution within the 30-day term → 5% referrer + 5% referee of base
     • attribution expired or term ended → void, 0
   Pure: the input binding is never mutated. */
function applyReferralAccrual(binding, minutes, baseEarned, now) {
  var ts = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  if (!binding || typeof binding !== 'object' || !binding.code) {
    return { binding: binding || null, credit: 0, note: null };
  }
  var b = cloneLedger(binding);
  var m = Math.floor(Number(minutes));
  var base = Number(baseEarned);
  if (!b || !normalizeRefCode(b.code) || !isFinite(m) || m <= 0 || !isFinite(base) || base <= 0) {
    return { binding: b, credit: 0, refereeCredit: 0, note: null };
  }
  if (!Number.isFinite(b.firstValidImpressionAt)) {
    if (b.version !== 2 && (b.minutes > 0 || b.gated)) {
      b.firstValidImpressionAt = Number.isFinite(b.t0) ? b.t0 : 0;
    } else {
      var clickedAt = Number.isFinite(b.clickedAt) ? b.clickedAt : b.t0;
      if (!Number.isFinite(clickedAt) || ts < clickedAt || ts - clickedAt >= REFERRAL_CLICK_DAYS * 86400000) {
        b.void = true;
        return { binding: b, credit: 0, refereeCredit: 0, note: 'referral attribution expired' };
      }
      b.firstValidImpressionAt = ts;
    }
  }
  var age = ts - b.firstValidImpressionAt;
  if (b.void || age < 0 || age >= REFERRAL_TERM_DAYS * 86400000) {
    b.void = true;
    return { binding: b, credit: 0, refereeCredit: 0, note: 'referral term ended (30 days)' };
  }
  var share = round4(base * REFERRAL_SHARE);
  var refereeCredit = round4(base * REFEREE_SHARE);
  b.minutes = (Number(b.minutes) || 0) + m;
  b.windowMinutes = (Number(b.windowMinutes) || 0) + m;
  b.gated = true;
  b.paid = round4((Number(b.paid) || 0) + share);
  b.refereePaid = round4((Number(b.refereePaid) || 0) + refereeCredit);
  return { binding: b, credit: share, refereeCredit: refereeCredit, note: null };
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
  if (!l.monthly || l.monthly.month !== monthKey(ts)) l.monthly = { month: monthKey(ts), total: 0, impressions: 0, paidClicks: 0 };
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
  var started = Number.isFinite(b.firstValidImpressionAt) ? b.firstValidImpressionAt :
    (b.version !== 2 && (b.minutes > 0 || b.gated) ? b.t0 : null);
  var ageDays = Number.isFinite(started) ? (ts - started) / 86400000 : 0;
  var clickedAt = Number.isFinite(b.clickedAt) ? b.clickedAt : b.t0;
  var expired = b.void || ageDays >= REFERRAL_TERM_DAYS ||
    (!Number.isFinite(started) && (!Number.isFinite(clickedAt) || ts - clickedAt >= REFERRAL_CLICK_DAYS * 86400000));
  var gate = expired ? 'void' : (Number.isFinite(started) ? 'passed' : 'pending');
  return {
    refereeOf: normalizeRefCode(b.code),
    gate: gate,
    minutes: Math.round(Number(b.minutes) || 0),
    windowMinutes: Math.round(Number(b.windowMinutes) || 0),
    gateMinutes: REFERRAL_GATE_MINUTES,
    gateDaysLeft: gate === 'pending' ? Math.max(0, Math.ceil(REFERRAL_GATE_DAYS - ageDays)) : 0,
    termDaysLeft: expired ? 0 : Math.max(0, Math.ceil(REFERRAL_TERM_DAYS - ageDays)),
    firstValidImpressionAt: started,
    attributionDays: REFERRAL_CLICK_DAYS,
    referrerShare: REFERRAL_SHARE,
    refereeShare: REFEREE_SHARE
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
  if (method === 'POST' && pathname === '/submit') return { handled: true, route: 'submit' };
  if (method === 'POST' && pathname === '/pilot-interest') return { handled: true, route: 'pilotInterest' };
  if (method === 'GET' && pathname === '/admin/queue') return { handled: true, route: 'adminQueue' };
  if (method === 'POST' && pathname === '/admin/review') return { handled: true, route: 'adminReview' };
  if (method === 'GET' && pathname === '/admin/pilots') return { handled: true, route: 'adminPilots' };
  if (method === 'POST' && pathname === '/admin/pilots') return { handled: true, route: 'adminPilotCreate' };
  if (method === 'POST' && pathname === '/admin/pilots/transition') return { handled: true, route: 'adminPilotTransition' };
  if (method === 'POST' && pathname === '/admin/pilots/revenue') return { handled: true, route: 'adminPilotRevenue' };
  if (method === 'POST' && pathname === '/admin/pilots/promotional-pool') return { handled: true, route: 'adminPilotPromoPool' };
  if (method === 'GET' && pathname === '/admin/pilots/proof') return { handled: true, route: 'adminPilotProof' };
  if (method === 'POST' && pathname === '/admin/pilots/settlement') return { handled: true, route: 'adminPilotSettlement' };
  if (method === 'GET' && pathname === '/campaigns/eligible') return { handled: true, route: 'pilotEligibility' };
  if (method === 'GET' && pathname === '/health') return { handled: true, route: 'health' };
  if (method === 'POST' && pathname === '/track') return { handled: true, route: 'track' };
  if (method === 'POST' && pathname === '/admin/feed') return { handled: true, route: 'adminFeed' };
  if (method === 'POST' && pathname === '/referral') return { handled: true, route: 'referral' };
  /* Slot auction (public: anyone can bid on inventory). */
  if (method === 'GET' && pathname === '/slots') return { handled: true, route: 'slots' };
  if (method === 'GET' && pathname === '/slots/current') return { handled: true, route: 'slotCurrent' };
  if (method === 'POST' && pathname === '/slots/bid') return { handled: true, route: 'slotBid' };
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
    monthly: { month: monthKey(ts), total: 0, impressions: 0, paidClicks: 0 },
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
function applyEarnings(ledger, report, campaigns, now, referral, launchEnabled) {
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
  var region = normalizeRegion(report.region);

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
  if (!l.monthly || l.monthly.month !== month) l.monthly = { month: month, total: 0, impressions: 0, paidClicks: 0 };
  if (!l.referral || typeof l.referral !== 'object') l.referral = { total: 0 };
  if (!Array.isArray(l.rows)) l.rows = [];

  var attemptsToday = Number(l.counters.todayClicks.count) || 0;
  /* Persist the monthly PAID count independently of daily attempts. Legacy
     ledgers lack it and retained rows may be incomplete; lifetime reports
     are a conservative upper bound until the next monthly rollover. */
  if (!Number.isFinite(l.monthly.paidClicks) || l.monthly.paidClicks < 0) {
    l.monthly.paidClicks = Math.max(0, Number(l.counters.clicks) || 0);
  }
  var monthClicks = l.monthly.paidClicks;
  var monthImpressions = Number(l.monthly.impressions) || 0;
  var earned = 0;
  var baseEarned = 0, launchBonus = 0, refereeBonus = 0;
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

    if (!campaign || cpm < SERVING_MIN_CPM) {
      minutes = 0;
      note = campaign ? 'campaign below CPM floor' : 'unknown campaign — cpm 0';
    }
    baseEarned = round4(minutes * cpm / 1000 * USER_SHARE);
    earned = baseEarned;
    if (minutes > 0 && !Number.isFinite(l.firstValidImpressionAt)) l.firstValidImpressionAt = ts;
    launchBonus = launchEnabled === true ? round4(baseEarned * LAUNCH_SHARE) : 0;

    l.total = round4((Number(l.total) || 0) + earned);
    l.today.total = round4((Number(l.today.total) || 0) + earned);
    l.monthly.total = round4((Number(l.monthly.total) || 0) + earned);
    l.monthly.impressions = monthImpressions + minutes;
    // minutes rides along so delivery reporting can sum verified minutes
    // per campaign (rows written before v1.1.3 lack it and count as 1).
    // platform + region ride along too, so the advertiser report can break
    // delivery down by surface and region rather than guessing (rows written
    // before delivery reporting landed read as 'unknown' on both).
    l.rows.push({ t: ts, type: type, campaignId: campaignId, amount: earned,
      minutes: minutes, platform: platform, region: region });
    l.counters.impressions = (Number(l.counters.impressions) || 0) + minutes;
    bumpPlatform(l.counters, platform, minutes, 0);
  } else {
    /* Click: flat $0.05 when the campaign allows AND both caps allow.
       The daily cap counts ATTEMPTS (paid or not). */
    var clickAllowed = !!(campaign && cpm >= SERVING_MIN_CPM && campaign.allowClicks !== false);
    var capShare = CLICK_CAP_SHARE * monthImpressions;   // exact ≤25% rule

    if (attemptsToday + 1 > CLICK_MAX_PER_DAY) {
      note = 'daily click cap reached (' + CLICK_MAX_PER_DAY + '/day)';
    } else if (monthClicks + 1 > capShare) {
      note = 'monthly click-share cap reached (≤' + Math.round(CLICK_CAP_SHARE * 100) +
        '% of ' + monthImpressions + ' impressions this month)';
    } else if (!clickAllowed) {
      note = campaign ? 'campaign does not allow paid clicks' : 'unknown campaign — not payable';
    } else {
      earned = round4(CLICK_BONUS);
      l.monthly.paidClicks = monthClicks + 1;
    }

    l.total = round4((Number(l.total) || 0) + earned);
    l.today.total = round4((Number(l.today.total) || 0) + earned);
    l.monthly.total = round4((Number(l.monthly.total) || 0) + earned);
    l.rows.push({ t: ts, type: type, campaignId: campaignId, amount: earned,
      platform: platform, region: region });
    l.counters.clicks = (Number(l.counters.clicks) || 0) + 1;
    l.counters.todayClicks.count = attemptsToday + 1;
    bumpPlatform(l.counters, platform, 0, 1);
  }

  if (l.rows.length > ROWS_KEPT) l.rows = l.rows.slice(-ROWS_KEPT);

  /* Referral accrual (impressions only): 5% referrer + 5% referee derived from
     THIS referee's base award, within the 30-day term from the first valid
     impression. A malformed binding can only ever yield credit 0. */
  var referrerCredit = 0, referrerBinding = null, referralNote = null;
  if (type === 'impression' && referral) {
    var eligibleBinding = cloneLedger(referral);
    if (!Number.isFinite(eligibleBinding.firstValidImpressionAt) &&
        Number.isFinite(l.firstValidImpressionAt)) {
      if (l.firstValidImpressionAt < ts) eligibleBinding.void = true;
    }
    var acc = applyReferralAccrual(eligibleBinding, minutes, baseEarned, ts);
    referrerBinding = acc.binding || null;
    referrerCredit = Number(acc.credit) || 0;
    refereeBonus = Number(acc.refereeCredit) || 0;
    referralNote = acc.note || null;
  }
  if (!l.bonuses || typeof l.bonuses !== 'object') l.bonuses = { launch: 0, referee: 0 };
  for (var bonus of [{ type: 'launch', amount: launchBonus }, { type: 'referee', amount: refereeBonus }]) {
    if (bonus.amount <= 0) continue;
    l.total = round4((Number(l.total) || 0) + bonus.amount);
    l.today.total = round4((Number(l.today.total) || 0) + bonus.amount);
    l.monthly.total = round4((Number(l.monthly.total) || 0) + bonus.amount);
    l.bonuses[bonus.type] = round4((Number(l.bonuses[bonus.type]) || 0) + bonus.amount);
    l.rows.push({ t: ts, type: bonus.type, campaignId: '', amount: bonus.amount, minutes: 0 });
  }
  earned = round4(earned + launchBonus + refereeBonus);
  if (l.rows.length > ROWS_KEPT) l.rows = l.rows.slice(-ROWS_KEPT);

  return {
    ledger: l, earned: earned, baseEarned: baseEarned, launchBonus: launchBonus,
    refereeBonus: refereeBonus, note: note, error: null,
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
    bonuses: { launch: round2(Number(l.bonuses && l.bonuses.launch) || 0),
      referee: round2(Number(l.bonuses && l.bonuses.referee) || 0) },
    firstValidImpressionAt: Number.isFinite(l.firstValidImpressionAt) ? l.firstValidImpressionAt : null,
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
   across every stored ledger — verified minutes (and the same figure in
   hours), reported clicks, user-share spend, the number of DISTINCT DEVICES
   the campaign reached, and its delivery broken down by SURFACE (mac menu
   bar / web / pwa / agent) and REGION (device-reported ISO-3166 alpha-2).
   Plus network totals and the served feed size.

   Privacy: this endpoint emits COUNTS and percentages only. No device id,
   no ledger row, no per-device breakdown ever leaves it — a reach count is
   aggregate, and `regions` are self-reported by the device (we never
   geo-locate an IP), which the advertiser page states plainly.

   KV scanning is capped (STATS_MAX_KEYS) to bound the work on the free tier. */
var STATS_MAX_KEYS = 1000;

/* {key: minutes} → [{<name>, minutes, share%}] sorted desc, capped.
   Used for both the region mix and the surface mix. */
function shareList(map, name, total) {
  var out = [];
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    var mins = Number(map[k]) || 0;
    var row = { minutes: mins, share: total > 0 ? round2(mins / total * 100) : 0 };
    row[name] = k;
    out.push(row);
  }
  out.sort(function (a, b) {
    if (b.minutes !== a.minutes) return b.minutes - a.minutes;
    var ka = a[name], kb = b[name];
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  return out.slice(0, REGION_LIST_MAX);
}

/* Aggregate delivery across every device ledger.
   Each ledger is ONE device, so a per-campaign distinct-device count is just
   "how many ledgers carry a row for that campaign". handleStats stamps
   `deviceId` from the KV key; an unstamped ledger still counts as one device
   via its loop index, so the number is never inflated by a missing stamp.
   Counts only — no device id is ever emitted. */
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
  var reg = Object.create(null);   // global region mix, by verified minutes
  var devices = Object.create(null);  // distinct device ids seen, globally
  var referralSpend = 0;           // platform-side referral cost, never a campaign's
  var earners = 0;
  for (var d = 0; d < ledgers.length; d++) {
    var l = ledgers[d];
    // Count real ledger objects only — corrupt KV values (strings, arrays)
    // are skipped by the caller, but never let one mint an earner.
    if (!l || typeof l !== 'object' || Array.isArray(l) || !Array.isArray(l.rows)) continue;
    earners++;
    var dev = (typeof l.deviceId === 'string' && l.deviceId) ? l.deviceId : ('#' + d);
    devices[dev] = true;
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
      var e = per[id] || (per[id] = {
        id: id, sponsor: names[id] || '', impressions: 0, clicks: 0, spend: 0,
        devices: Object.create(null),
        regions: Object.create(null),
        surfaces: Object.create(null)
      });
      var amt = round4(Number(row.amount) || 0);
      var mins = 0;
      if (row.type === 'click') {
        e.clicks += 1;   // reported clicks (paid or not — caps burn quota)
      } else {
        // Explicit minutes:0 means 0 (matches ledger counters); only
        // missing/NaN (pre-v1.1.3 rows) falls back to 1.
        var mraw = row.minutes;
        var m = (mraw === undefined || mraw === null) ? NaN : Math.floor(Number(mraw));
        mins = isFinite(m) ? Math.max(0, m) : 1;
        e.impressions += mins;
      }
      e.spend = round4(e.spend + amt);
      // Delivery dimensions only mean something for time actually served.
      if (mins > 0) {
        e.devices[dev] = true;
        var rk = normalizeRegion(row.region);
        var sk = normalizePlatform(row.platform);
        e.regions[rk] = (e.regions[rk] || 0) + mins;
        e.surfaces[sk] = (e.surfaces[sk] || 0) + mins;
        reg[rk] = (reg[rk] || 0) + mins;
      }
    }
  }
  var campaigns = [];
  var tI = 0, tC = 0, tS4 = 0;
  for (var k in per) {
    var c = per[k];
    tS4 = round4(tS4 + c.spend);
    c.spend = round2(c.spend);
    var devCount = 0;
    for (var dk in c.devices) {
      if (Object.prototype.hasOwnProperty.call(c.devices, dk)) devCount++;
    }
    c.devices = devCount;                                   // distinct devices
    c.hours = round2(c.impressions / 60);                   // "how much time"
    c.regions = shareList(c.regions, 'region', c.impressions);
    c.surfaces = shareList(c.surfaces, 'surface', c.impressions);
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
  var devTotal = 0;
  for (var dk2 in devices) {
    if (Object.prototype.hasOwnProperty.call(devices, dk2)) devTotal++;
  }
  return {
    campaigns: campaigns,
    totals: {
      impressions: tI, clicks: tC, spend: round2(tS4), earners: earners,
      hours: round2(tI / 60), devices: devTotal
    },
    platforms: platforms,
    regions: shareList(reg, 'region', tI),
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
  /* `campaigns` is the SERVING list, not the raw feed: while a slot has a
     winner that winner is the only thing that serves (winner takes all), so
     every client — including the macOS app, which just picks the highest CPM
     — honours the auction with no client change. `openFeedCount` keeps the
     advertiser page's "live campaigns" number honest. */
  var served = await servingList(env, feed.campaigns);
  return json({
    campaigns: served.campaigns,
    openFeedCount: feed.campaigns.length,
    slot: served.slot
  }, 200, { 'cache-control': 'public, max-age=30' });
}

/* /stats — PUBLIC, aggregate-only. `totals` stays the delivery rollup (one
   key set advertisers already read), now with `hours` and `devices` added;
   each campaign carries its own reach + surface/region breakdown. The
   flywheel additions ride alongside: `platforms` (where the verified minutes
   happened), `regions` (network-wide region mix) and `referralSpend`
   (platform-side referral cost — never billed to a campaign). */
async function handleStats(env) {
  var feed = await getFeed(env);
  var zeros = {
    campaigns: [],
    totals: { impressions: 0, clicks: 0, spend: 0, earners: 0, hours: 0, devices: 0 },
    platforms: [],
    regions: [],
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
          if (raw) {
            try {
              var parsed = JSON.parse(raw);
              /* Stamp the owning device so per-campaign reach can be counted
                 as distinct devices. Counts only — ids are never emitted. */
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsed.deviceId = String(page.keys[i].name).slice('earn:'.length);
              }
              ledgers.push(parsed);
            } catch (e) { /* skip corrupt */ }
          }
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

/* Only a missing key starts a new ledger. Transport failures and corrupt
   existing balances must fail closed, never reset somebody's earnings. */
async function readStoredLedger(kv, key) {
  var raw = await kv.get(key);
  if (raw === null || raw === undefined) return null;
  var ledger = JSON.parse(raw);
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) ||
      !Number.isFinite(ledger.total) || ledger.total < 0) {
    throw new Error('invalid stored ledger');
  }
  return ledger;
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
  /* cpm is looked up in the SERVING list, so a slot's exclusive winner is the
     only campaign that can be paid while that slot is running. */
  var served = await servingList(env, feed.campaigns);

  /* Best-effort atomic-ish read-modify-write. KV is eventually consistent;
     free tier = last-write-wins (documented in the security model). */
  var key = 'earn:' + deviceId;
  var ledger = null;
  try {
    ledger = await readStoredLedger(env.SITE_KV, key);
  } catch (e3) {
    return json({ ok: false, error: 'ledger unavailable' }, 503);
  }

  /* Referee binding (KV `ref:{deviceId}`) — present only when this device
     arrived through someone's share link. A missing or corrupt binding means
     "no referral"; it can never block or inflate this device's own pay. */
  var binding = null;
  try {
    var braw = await env.SITE_KV.get('ref:' + deviceId);
    if (braw) { try { binding = JSON.parse(braw); } catch (e5) { binding = null; } }
  } catch (e6) { binding = null; }
  if (binding && !normalizeRefCode(binding.code)) binding = null;

  if (binding) {
    try {
      var referralOwner = JSON.parse(await env.SITE_KV.get('refcode:' + binding.code));
      if (!referralOwner || !DEVICE_ID_RE.test(String(referralOwner.deviceId || '')) || referralOwner.deviceId === deviceId) binding = null;
    } catch (e8) { return json({ ok: false, error: 'referral unavailable' }, 503); }
  }
  var result = applyEarnings(ledger, body, served.campaigns, Date.now(), binding, env.LAUNCH_BONUS_ENABLED === 'true');
  if (result.error) return json({ ok: false, error: result.error }, 400);

  try {
    await env.SITE_KV.put(key, JSON.stringify(result.ledger));
  } catch (e4) {
    return json({ ok: false, error: 'ledger unavailable' }, 503);
  }

  var resp = { ok: true, earned: round2(result.earned), total: round2(result.ledger.total),
    breakdown: { base: result.baseEarned, launch: result.launchBonus, referee: result.refereeBonus } };
  if (result.note) resp.note = result.note;
  resp.platform = result.platform;

   /* The loop closes HERE. The referrer's 5% is credited to the referrer's own
      ledger — platform-side money, separate from the referee's 70%. Both
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
    ledger = await readStoredLedger(env.SITE_KV, key);
  } catch (e3) {
    return { credited: false, note: 'referrer ledger unavailable' };
  }

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
    ledger = await readStoredLedger(env.SITE_KV, 'earn:' + deviceId);
  } catch (e2) {
    return json({ ok: false, error: 'ledger unavailable' }, 503);
  }

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

  try {
    var earningsRaw = await env.SITE_KV.get('earn:' + deviceId);
    var earnings = earningsRaw ? JSON.parse(earningsRaw) : null;
    if (earnings && (Number.isFinite(earnings.firstValidImpressionAt) ||
        Number(earnings.counters && earnings.counters.impressions) > 0)) {
      return json({ ok: true, action: 'claim', claimed: false, code: code, note: 'attribution locked after first impression' }, 200);
    }
  } catch (e10) { return json({ ok: false, error: 'ledger unavailable' }, 503); }
  var claim = applyReferralClaim(mine, code, now, body.action === 'click');
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

/* --------------------- open submission + review ---------------------
   Anyone can submit ONE campaign per request (no token). Submissions land
   in a human-review queue — nothing reaches the live feed without an
   explicit admin approval, which is what the advertisers page promises.
   Spam controls: minimum $2 CPM bid, https-only destination required
   (linkless ads are pointless), duplicate ids rejected across feed AND
   queue, 5 submissions/day per IP, queue capped at 50. Highest CPM still
   wins the minute (pickAd sorts desc); with no bids the clients show
   their fictional/demo fallback, as always. */
var SUBMIT_MIN_CPM = 2;
var SUBMIT_MAX_PER_DAY = 5;
var QUEUE_MAX = 50;

async function readQueue(kv) {
  try {
    var raw = await kv.get('queue:campaigns');
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

async function writeQueue(kv, arr) {
  await kv.put('queue:campaigns', JSON.stringify(arr));
}

function clientIP(req) {
  try {
    var ip = req.headers.get('cf-connecting-ip') || '';
    ip = ip.replace(/^\s+|\s+$/g, '').slice(0, 64);
    return ip || 'unknown';
  } catch (e) { return 'unknown'; }
}

async function handleSubmit(req, env) {
  if (!env || !env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  var body;
  try { body = await req.json(); }
  catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'submit one campaign object (not an array)' }, 400);
  }
  var valid = validateCampaigns([body]);
  if (!valid.length) {
    return json({ ok: false, error: 'campaign needs an id and a sponsor (max 40 chars each)' }, 400);
  }
  var camp = valid[0];
  if (!isValidHttpsUrl(capStr(body.clickUrl, URL_MAX))) {
    return json({ ok: false, error: 'clickUrl must be a valid https:// URL' }, 400);
  }
  if (!(camp.cpm >= SUBMIT_MIN_CPM)) {
    return json({ ok: false, error: 'minimum bid is $' + SUBMIT_MIN_CPM + ' CPM' }, 400);
  }
  var kv = env.SITE_KV;
  var feedRaw = null;
  try { feedRaw = await kv.get('feed:current'); } catch (e0) { feedRaw = null; }
  var feed = feedFromKVText(feedRaw);
  feed = feed || [];
  var queue = await readQueue(kv);
  for (var i = 0; i < feed.length; i++) {
    if (feed[i] && feed[i].id === camp.id) {
      return json({ ok: false, error: 'id already live in the feed' }, 409);
    }
  }
  for (var j = 0; j < queue.length; j++) {
    if (queue[j] && queue[j].id === camp.id) {
      return json({ ok: false, error: 'id already awaiting review' }, 409);
    }
  }
  if (queue.length >= QUEUE_MAX) {
    return json({ ok: false, error: 'review queue is full — try again later' }, 429);
  }
  var day = todayKey(Date.now());
  var rateKey = 'sub:' + clientIP(req) + ':' + day;
  var used = 0;
  try { used = Number(await kv.get(rateKey)) || 0; } catch (e) { used = 0; }
  if (used >= SUBMIT_MAX_PER_DAY) {
    return json({ ok: false, error: 'daily submission limit reached (5/day per network)' }, 429);
  }
  try {
    await kv.put(rateKey, String(used + 1), { expirationTtl: 86400 });
  } catch (e2) { /* rate-limit write failed — still accept, queue is the record */ }
  camp.submittedAt = Date.now();
  queue.push(camp);
  try {
    await writeQueue(kv, queue);
  } catch (e3) {
    return json({ ok: false, error: 'ledger unavailable' }, 503);
  }
  return json({ ok: true, status: 'pending-review', id: camp.id,
    note: 'A human reviews every submission before it can serve. Watch /feed.json.' }, 200);
}

/* Public sponsor-interest intake. Deliberately separate from campaigns,
   pilots, eligibility and feed state. This handler cannot approve, enable,
   schedule, fund, or serve a campaign. */
var PILOT_INTEREST_LIST_KEY = 'pilot-interest:index';
var PILOT_INTEREST_MAX = 200;
var PILOT_INTEREST_RATE_PER_DAY = 5;
function interestField(v, max) { return capStr(v, max); }
function interestEmail(v) {
  var x = interestField(v, 160).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) ? x : '';
}
async function handlePilotInterest(req, env) {
  if (!env || !env.SITE_KV) return json({ ok:false, error:'intake unavailable' }, 503);
  var body;
  try { body = await req.json(); } catch (e) { return json({ ok:false, error:'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok:false, error:'submit one interest record' }, 400);
  var company = interestField(body.company, 100);
  var name = interestField(body.name, 100);
  var email = interestEmail(body.email);
  var destination = interestField(body.destination, 500);
  var note = interestField(body.note, 1200);
  if (!company || !name || !email) return json({ ok:false, error:'company, name, and valid email are required' }, 400);
  if (destination && !isValidHttpsUrl(destination)) return json({ ok:false, error:'destination must begin with https://' }, 400);
  var kv = env.SITE_KV, now = Date.now(), day = todayKey(now), ip = clientIP(req);
  var rateKey = 'pilot-interest-rate:' + ip + ':' + day, used = 0;
  try { used = Number(await kv.get(rateKey)) || 0; } catch (e0) { used = 0; }
  if (used >= PILOT_INTEREST_RATE_PER_DAY) return json({ ok:false, error:'daily submission limit reached' }, 429);
  var ids = [];
  try { var raw = await kv.get(PILOT_INTEREST_LIST_KEY); ids = raw ? JSON.parse(raw) : []; } catch (e1) { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  if (ids.length >= PILOT_INTEREST_MAX) return json({ ok:false, error:'review queue is full' }, 429);
  var id = 'pi-' + now.toString(36) + '-' + Math.random().toString(36).slice(2,10);
  var record = { id:id, state:'submitted', submittedAt:now, company:company, name:name, email:email,
    destination:destination, note:note, source:'public-advertiser-form' };
  try {
    await kv.put('pilot-interest:' + id, JSON.stringify(record));
    ids.push(id);
    await kv.put(PILOT_INTEREST_LIST_KEY, JSON.stringify(ids));
    await kv.put(rateKey, String(used + 1), { expirationTtl:86400 });
  } catch (e2) { return json({ ok:false, error:'intake unavailable' }, 503); }
  return json({ ok:true, id:id, state:'submitted', note:'Received for human review. Nothing goes live automatically.' }, 201);
}

function requireAdmin(env, req) {
  var auth = '';
  try { auth = req.headers.get('authorization') || ''; } catch (e) { auth = ''; }
  var expected = 'Bearer ' + (env && env.ADMIN_TOKEN ? env.ADMIN_TOKEN : '');
  return !!(env && env.ADMIN_TOKEN && safeEqual(auth, expected));
}

async function handleAdminQueue(req, env) {
  if (!requireAdmin(env, req)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  return json({ campaigns: await readQueue(env.SITE_KV) }, 200);
}

async function handleAdminReview(req, env) {
  if (!requireAdmin(env, req)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  var body;
  try { body = await req.json(); }
  catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  var id = (body && typeof body.id === 'string') ? capStr(body.id, ID_MAX) : '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  var approved = !!(body && body.approve);
  var kv = env.SITE_KV;
  var queue = await readQueue(kv);
  var at = -1;
  for (var i = 0; i < queue.length; i++) {
    if (queue[i] && queue[i].id === id) { at = i; break; }
  }
  if (at === -1) return json({ ok: false, error: 'id not in the review queue' }, 404);
  var camp = queue[at];
  if (approved) {
    var feedRaw;
    try { feedRaw = await kv.get('feed:current'); }
    catch (e0) { return json({ ok: false, error: 'feed unavailable' }, 503); }
    var feed = feedFromKVText(feedRaw);
    if (feedRaw && !feed) return json({ ok: false, error: 'feed unavailable' }, 503);
    feed = feed || [];
    var alreadyLive = feed.some(function (entry) { return entry.id === id; });
    if (!alreadyLive && feed.length >= MAX_CAMPAIGNS) {
      return json({ ok: false, error: 'live feed is full (20) — remove one via POST /admin/feed first' }, 409);
    }
    var approvedCampaign = validateCampaigns([camp])[0];
    if (!approvedCampaign || approvedCampaign.cpm < SUBMIT_MIN_CPM) {
      return json({ ok: false, error: 'campaign below CPM floor or invalid' }, 400);
    }
    if (!alreadyLive) feed.push(approvedCampaign);
    try {
      await kv.put('feed:current', JSON.stringify(feed));
      queue.splice(at, 1);
      await writeQueue(kv, queue);
    } catch (e2) {
      return json({ ok: false, error: 'ledger unavailable' }, 503);
    }
    return json({ ok: true, status: 'live', id: id }, 200);
  }
  queue.splice(at, 1);
  try { await writeQueue(kv, queue); }
  catch (e3) { return json({ ok: false, error: 'queue unavailable' }, 503); }
  return json({ ok: true, status: 'rejected', id: id }, 200);
}



/* ------------------------ founding-pilot lane ------------------------- */
async function readPilotIds(kv) {
  try { var raw = await kv.get(PILOT_LIST_KEY); var ids = raw ? JSON.parse(raw) : []; return Array.isArray(ids) ? ids : []; }
  catch (e) { return []; }
}
async function readPilot(kv, id) {
  try { var raw = await kv.get(PILOT_KEY_PREFIX + id); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
async function writePilot(kv, record) {
  await kv.put(PILOT_KEY_PREFIX + record.id, JSON.stringify(record));
  var ids = await readPilotIds(kv);
  if (ids.indexOf(record.id) === -1) { ids.push(record.id); await kv.put(PILOT_LIST_KEY, JSON.stringify(ids.slice(-200))); }
}
async function allPilots(kv) {
  var ids = await readPilotIds(kv), out = [];
  for (var i = 0; i < ids.length; i++) { var rec = await readPilot(kv, ids[i]); if (rec) out.push(rec); }
  return out;
}
function pilotAdminGuard(req, env) {
  if (!requireAdmin(env, req)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.SITE_KV) return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  return null;
}
async function pilotBody(req) { try { return await req.json(); } catch (e) { return null; } }
async function handleAdminPilots(req, env) {
  var blocked = pilotAdminGuard(req, env); if (blocked) return blocked;
  return json({ campaigns: await allPilots(env.SITE_KV) }, 200);
}
async function handleAdminPilotCreate(req, env) {
  var blocked = pilotAdminGuard(req, env); if (blocked) return blocked;
  if (env.PILOT_ADMIN_INTAKE_ENABLED !== 'true') return json({ ok: false, error: 'pilot admin intake is disabled' }, 403);
  var body = await pilotBody(req); if (!body) return json({ ok: false, error: 'invalid JSON body' }, 400);
  var built = newPilot(body); if (built.error) return json({ ok: false, error: built.error }, 400);
  if (await readPilot(env.SITE_KV, built.record.id)) return json({ ok: false, error: 'pilot id already exists' }, 409);
  await writePilot(env.SITE_KV, built.record); return json({ ok: true, campaign: built.record }, 201);
}
async function mutatePilot(req, env, mutator) {
  var blocked = pilotAdminGuard(req, env); if (blocked) return blocked;
  var body = await pilotBody(req); if (!body || typeof body.id !== 'string') return json({ ok: false, error: 'id required' }, 400);
  var rec = await readPilot(env.SITE_KV, body.id); if (!rec) return json({ ok: false, error: 'pilot not found' }, 404);
  var result = mutator(rec, body, env); if (result.error) return json({ ok: false, error: result.error }, 409);
  await writePilot(env.SITE_KV, result.record); return json({ ok: true, campaign: result.record }, 200);
}
async function handleAdminPilotTransition(req, env) {
  return mutatePilot(req, env, function (rec, body, e) { return transitionPilot(rec, body.to, e, body); });
}
async function handleAdminPilotRevenue(req, env) {
  return mutatePilot(req, env, function (rec, body, e) { return confirmPilotRevenue(rec, body, e); });
}
async function handleAdminPilotPromoPool(req, env) {
  return mutatePilot(req, env, function (rec, body, e) { return fundPromotionalPool(rec, body, e); });
}
async function handlePilotEligibility(env) {
  if (!env || !env.SITE_KV) return json({ enabled: false, campaigns: [] }, 200);
  return json(eligiblePilotView(await allPilots(env.SITE_KV), env), 200,
    { 'cache-control': 'no-store' });
}
async function handleAdminPilotProof(req, env) {
  var blocked = pilotAdminGuard(req, env); if (blocked) return blocked;
  if (!proofGate(env)) return json({ ok: false, error: 'pilot proof is disabled' }, 403);
  return json({ ok: true, note: 'proof adapter not configured' }, 501);
}
async function handleAdminPilotSettlement(req, env) {
  var blocked = pilotAdminGuard(req, env); if (blocked) return blocked;
  if (!settlementGate(env)) return json({ ok: false, error: 'pilot settlement is disabled' }, 403);
  return json({ ok: true, note: 'settlement adapter not configured' }, 501);
}

/* ============================== slot auction ==============================
   Pure helpers first (exported for backend/test.mjs), then the KV handlers.
   Every slot helper is deterministic and takes an injected `now`, so the
   whole auction is unit-testable with no clock and no network.
   ========================================================================= */

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function slotDateKey(ts) {
  var d = new Date(ts);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/* The slot containing `ts`: "YYYY-MM-DD#<block>". */
function slotIdOf(ts) {
  var t = (typeof ts === 'number' && isFinite(ts)) ? ts : 0;
  var d = new Date(t);
  return slotDateKey(t) + '#' + Math.floor(d.getUTCHours() / SLOT_BLOCK_HOURS);
}

function slotMonthOf(ts) {
  var d = new Date(typeof ts === 'number' && isFinite(ts) ? ts : 0);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}

/* "YYYY-MM-DD#B" → {id, date, block, startsAt, endsAt, month} or null.
   Rejects rolled-over dates (2026-02-31) and out-of-range blocks. */
function parseSlotId(id) {
  if (typeof id !== 'string') return null;
  var m = SLOT_ID_RE.exec(id);
  if (!m) return null;
  var y = +m[1], mo = +m[2], da = +m[3], b = +m[4];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  if (!(b >= 0 && b < SLOT_BLOCKS_PER_DAY)) return null;
  var startsAt = Date.UTC(y, mo - 1, da, b * SLOT_BLOCK_HOURS, 0, 0);
  var d = new Date(startsAt);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return null;
  return {
    id: y + '-' + pad2(mo) + '-' + pad2(da) + '#' + b,
    date: slotDateKey(startsAt), block: b,
    startsAt: startsAt, endsAt: startsAt + SLOT_BLOCK_HOURS * 3600000,
    month: slotMonthOf(startsAt)
  };
}

/* A stored bid → the campaign shape /feed.json serves. */
function bidToCampaign(b) {
  if (!b || typeof b !== 'object') return null;
  return {
    id: b.campaignId, sponsor: b.sponsor, tagline: b.tagline,
    clickUrl: b.clickUrl, cpm: b.cpm, logoText: b.logoText,
    accent: b.accent, allowClicks: b.allowClicks !== false
  };
}

/* One bid → a stored bid, or null when unusable. Reuses the campaign
   validator so a slot bid obeys exactly the feed's field rules.

   Accepts BOTH shapes on purpose: a CLIENT bid carries `id` (the feed's field
   name), a STORED bid carries `campaignId` (the served/ledger field name).
   Reading KV back through here must not drop real bids, so resolve whichever
   is present before validating. */
function normalizeBid(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var rawId = (typeof raw.campaignId === 'string' && raw.campaignId) ? raw.campaignId : raw.id;
  var v = validateCampaigns([{
    id: capStr(rawId, ID_MAX),
    sponsor: raw.sponsor,
    tagline: raw.tagline,
    clickUrl: raw.clickUrl,
    cpm: raw.cpm,
    logoText: raw.logoText,
    accent: raw.accent,
    allowClicks: raw.allowClicks
  }])[0];
  if (!v) return null;
  var cpm = Number(v.cpm);
  if (!isFinite(cpm) || cpm < SLOT_MIN_CPM) return null;
  var ts = Number(raw.bidTs);
  if (!isFinite(ts) || ts <= 0) ts = (typeof now === 'number' && isFinite(now)) ? now : 0;
  return {
    campaignId: v.id, sponsor: v.sponsor, tagline: v.tagline,
    clickUrl: v.clickUrl, cpm: round2(cpm), logoText: v.logoText,
    accent: v.accent, allowClicks: v.allowClicks,
    bidder: capStr(raw.bidder, BIDDER_MAX), bidTs: ts
  };
}

/* Highest CPM wins; a tie goes to the earlier bid. */
function slotWinner(bids) {
  if (!Array.isArray(bids) || !bids.length) return null;
  var best = null;
  for (var i = 0; i < bids.length; i++) {
    var b = bids[i];
    if (!b || typeof b !== 'object') continue;
    if (!best) { best = b; continue; }
    if (b.cpm > best.cpm) best = b;
    else if (b.cpm === best.cpm && b.bidTs < best.bidTs) best = b;
  }
  return best;
}

function sortBids(bids) {
  return bids.slice().sort(function (a, b) {
    if (b.cpm !== a.cpm) return b.cpm - a.cpm;   // highest CPM first
    return a.bidTs - b.bidTs;                    // ties: earliest first
  });
}

/* Add a bid to a slot. A second bid from the SAME campaignId REPLACES that
   campaign's earlier bid on this slot (so raising a bid is one call), then
   the list is re-sorted and capped. */
function placeBid(bids, bid) {
  var list = Array.isArray(bids) ? bids : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].campaignId !== bid.campaignId) out.push(list[i]);
  }
  out.push(bid);
  return sortBids(out).slice(0, SLOT_BIDS_KEPT);
}

/* Defensive read of a month store: drop anything malformed rather than
   letting one bad write poison a whole month of auctions. */
function normalizeMonthStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  var out = {};
  for (var date in raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    var day = raw[date];
    if (!day || typeof day !== 'object' || Array.isArray(day)) continue;
    var blocks = {};
    for (var k in day) {
      var b = Number(k);
      if (!(b >= 0 && b < SLOT_BLOCKS_PER_DAY)) continue;
      if (!Array.isArray(day[k])) continue;
      var clean = [];
      for (var i = 0; i < day[k].length; i++) {
        var nb = normalizeBid(day[k][i], 0);
        if (nb) clean.push(nb);
      }
      if (clean.length) blocks[b] = sortBids(clean).slice(0, SLOT_BIDS_KEPT);
    }
    if (Object.keys(blocks).length) out[date] = blocks;
  }
  return out;
}

/* A whole month's grid for the picker: every slot, its state, and the
   current top bid (enough to render "beat $6.00" without exposing bidders). */
function slotGrid(store, month, now) {
  var m = MONTH_RE.exec(String(month || ''));
  if (!m) return null;
  var y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  var t = (typeof now === 'number' && isFinite(now)) ? now : 0;
  var daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  var slots = [];
  for (var da = 1; da <= daysInMonth; da++) {
    for (var b = 0; b < SLOT_BLOCKS_PER_DAY; b++) {
      var p = parseSlotId(y + '-' + pad2(mo) + '-' + pad2(da) + '#' + b);
      if (!p) continue;
      var bids = (store[p.date] && store[p.date][b]) || [];
      var w = slotWinner(bids);
      slots.push({
        id: p.id,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        state: t < p.startsAt ? 'open' : (t < p.endsAt ? 'active' : 'past'),
        bidCount: bids.length,
        topCpm: w ? w.cpm : null,
        topSponsor: w ? w.sponsor : null,
        topCampaignId: w ? w.campaignId : null
      });
    }
  }
  return {
    month: y + '-' + pad2(mo),
    blockHours: SLOT_BLOCK_HOURS,
    blocksPerDay: SLOT_BLOCKS_PER_DAY,
    timezone: 'UTC',
    slots: slots
  };
}

async function readMonthStore(kv, month) {
  try {
    var raw = await kv.get('slots:' + month);
    if (!raw) return {};
    return normalizeMonthStore(JSON.parse(raw));
  } catch (e) { return {}; }
}

/* The slot covering `now`, with its resolved winner. Null when no KV. */
async function currentSlot(env, now) {
  if (!env || !env.SITE_KV) return null;
  var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var p = parseSlotId(slotIdOf(t));
  if (!p) return null;
  var store = await readMonthStore(env.SITE_KV, p.month);
  var bids = (store[p.date] && store[p.date][p.block]) || [];
  var w = slotWinner(bids);
  return {
    id: p.id, startsAt: p.startsAt, endsAt: p.endsAt,
    topCpm: w ? w.cpm : null, bidCount: bids.length,
    winner: w ? bidToCampaign(w) : null
  };
}

/* What actually serves right now. A slot with a winner is EXCLUSIVE — the
   open feed is suppressed for the duration, which is what "winner takes all"
   means. With no slot winner the open CPM auction serves as it always has. */
async function servingList(env, feedCampaigns) {
  var slot = await currentSlot(env, Date.now());
  if (slot && slot.winner) return { campaigns: [slot.winner], slot: slot };
  return { campaigns: feedCampaigns.filter(function (campaign) { return campaign.cpm >= SERVING_MIN_CPM; }), slot: slot };
}

/* ------------------------------ slot handlers --------------------------- */
async function handleSlots(env, month) {
  if (!env || !env.SITE_KV) {
    return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  }
  var want = month || slotMonthOf(Date.now());
  if (!MONTH_RE.test(String(want))) return json({ ok: false, error: 'month must be YYYY-MM' }, 400);
  var store = await readMonthStore(env.SITE_KV, want);
  var grid = slotGrid(store, want, Date.now());
  if (!grid) return json({ ok: false, error: 'month must be YYYY-MM' }, 400);
  return json(grid, 200, { 'cache-control': 'public, max-age=30' });
}

async function handleSlotBid(req, env) {
  if (!env || !env.SITE_KV) {
    return json({ ok: false, error: 'KV not configured (SITE_KV binding missing)' }, 503);
  }
  var body;
  try { body = await req.json(); }
  catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'send one bid object: {campaign, slots[], bidder}' }, 400);
  }

  var now = Date.now();
  var bidder = capStr(body.bidder, BIDDER_MAX);
  if (!bidder) {
    return json({ ok: false, error: 'bidder is required — a contact email or handle' }, 400);
  }
  var raw = body.campaign;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return json({ ok: false, error: 'campaign object required' }, 400);
  }
  var camp = validateCampaigns([raw])[0];
  if (!camp) {
    return json({ ok: false, error: 'campaign needs an id and a sponsor (max 40 chars each)' }, 400);
  }
  if (!isValidHttpsUrl(capStr(raw.clickUrl, URL_MAX))) {
    return json({ ok: false, error: 'clickUrl must be a valid https:// URL' }, 400);
  }
  if (!(Number(camp.cpm) >= SLOT_MIN_CPM)) {
    return json({ ok: false, error: 'minimum bid is $' + SLOT_MIN_CPM + ' CPM' }, 400);
  }
  var slots = Array.isArray(body.slots) ? body.slots : [];
  if (!slots.length) return json({ ok: false, error: 'select at least one slot' }, 400);
  if (slots.length > SLOT_MAX_PER_REQUEST) {
    return json({ ok: false, error: 'at most ' + SLOT_MAX_PER_REQUEST + ' slots per request' }, 400);
  }

  /* Sort the request into bookable slots and honest rejections. */
  var byMonth = {}, rejected = [], seen = {}, count = 0;
  for (var i = 0; i < slots.length; i++) {
    var p = parseSlotId(slots[i]);
    if (!p) { rejected.push({ slot: String(slots[i]).slice(0, 40), reason: 'not a valid slot id' }); continue; }
    if (seen[p.id]) continue;
    seen[p.id] = true;
    if (p.startsAt <= now) { rejected.push({ slot: p.id, reason: 'slot already started' }); continue; }
    if (p.startsAt > now + SLOT_MAX_AHEAD_DAYS * 86400000) {
      rejected.push({ slot: p.id, reason: 'more than ' + SLOT_MAX_AHEAD_DAYS + ' days ahead' }); continue;
    }
    if (!byMonth[p.month]) byMonth[p.month] = [];
    byMonth[p.month].push(p);
    count++;
  }
  if (!count) {
    return json({ ok: false, error: 'no bookable slots in the request', rejected: rejected }, 400);
  }

  /* Same per-IP daily limit as /submit. */
  var rateKey = 'slotbid:' + clientIP(req) + ':' + todayKey(now);
  var used = 0;
  try { used = Number(await env.SITE_KV.get(rateKey)) || 0; } catch (e) { used = 0; }
  if (used >= SLOT_RATE_PER_DAY) {
    return json({ ok: false, error: 'daily bid limit reached (' + SLOT_RATE_PER_DAY + '/day per network)' }, 429);
  }

  var bid = normalizeBid({
    id: camp.id, sponsor: camp.sponsor, tagline: camp.tagline,
    clickUrl: raw.clickUrl, cpm: camp.cpm, logoText: camp.logoText,
    accent: camp.accent, allowClicks: camp.allowClicks,
    bidder: bidder, bidTs: now
  }, now);
  if (!bid) return json({ ok: false, error: 'bid could not be validated' }, 400);

  var placed = [], winning = 0;
  var months = Object.keys(byMonth);
  for (var mIdx = 0; mIdx < months.length; mIdx++) {
    var month = months[mIdx];
    var store = await readMonthStore(env.SITE_KV, month);
    var group = byMonth[month];
    for (var g = 0; g < group.length; g++) {
      var s = group[g];
      if (!store[s.date]) store[s.date] = {};
      var existing = store[s.date][s.block] || [];
      var next = placeBid(existing, bid);
      store[s.date][s.block] = next;
      var w = slotWinner(next);
      var isTop = !!(w && w.campaignId === bid.campaignId);
      if (isTop) winning++;
      placed.push({
        slot: s.id, top: isTop,
        topCpm: w ? w.cpm : null,
        topSponsor: w ? w.sponsor : null,
        outbid: !isTop && w ? w.cpm : null
      });
    }
    try {
      await env.SITE_KV.put('slots:' + month, JSON.stringify(store));
    } catch (e2) {
      return json({ ok: false, error: 'ledger unavailable', placed: placed }, 503);
    }
  }

  try {
    await env.SITE_KV.put(rateKey, String(used + 1), { expirationTtl: 86400 });
  } catch (e3) { /* rate-limit write failed — the bids are already the record */ }

  return json({
    ok: true,
    campaignId: bid.campaignId,
    cpm: bid.cpm,
    placed: placed.length,
    winning: winning,
    outbidOn: placed.length - winning,
    slots: placed,
    rejected: rejected,
    note: winning === placed.length
      ? 'You hold the top bid on every slot selected.'
      : 'You hold ' + winning + ' of ' + placed.length +
        ' — raise your CPM to take the rest. Highest bid per slot wins it outright.'
  }, 200);
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
      case 'submit':
        return await handleSubmit(request, env);
      case 'pilotInterest':
        return await handlePilotInterest(request, env);
      case 'adminQueue':
        return await handleAdminQueue(request, env);
      case 'adminReview':
        return await handleAdminReview(request, env);
      case 'adminPilots': return await handleAdminPilots(request, env);
      case 'adminPilotCreate': return await handleAdminPilotCreate(request, env);
      case 'adminPilotTransition': return await handleAdminPilotTransition(request, env);
      case 'adminPilotRevenue': return await handleAdminPilotRevenue(request, env);
      case 'adminPilotPromoPool': return await handleAdminPilotPromoPool(request, env);
      case 'pilotEligibility': return await handlePilotEligibility(env);
      case 'adminPilotProof': return await handleAdminPilotProof(request, env);
      case 'adminPilotSettlement': return await handleAdminPilotSettlement(request, env);
      case 'slots':
        return await handleSlots(env, url.searchParams.get('month'));
      case 'slotBid':
        return await handleSlotBid(request, env);
      case 'slotCurrent':
        return json({ ok: true, slot: await currentSlot(env, Date.now()) }, 200,
          { 'cache-control': 'public, max-age=15' });
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
  normalizeRegion,
  shareList,
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
  REFERRALS_MAX,
  /* slot auction */
  slotIdOf,
  slotMonthOf,
  parseSlotId,
  normalizeBid,
  slotWinner,
  sortBids,
  placeBid,
  bidToCampaign,
  normalizeMonthStore,
  slotGrid,
  SLOT_BLOCK_HOURS,
  SLOT_BLOCKS_PER_DAY,
  SLOT_MIN_CPM,
  SLOT_BIDS_KEPT,
  SLOT_MAX_PER_REQUEST
};
