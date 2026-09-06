/* ==========================================================================
   FreeCoffee demo engine — seeded, deterministic, zero dependencies.
   All data on this site is simulated. Nothing here talks to a network.

   Exposed two ways:
     window.FreeCoffeeDemo        (browser)
     module.exports = FreeCoffeeDemo  (CommonJS, so `node` can require it)

   Deterministic guarantee: every PRNG draw flows through ONE mulberry32
   stream seeded from `SEED`. Timestamps are anchored to a FIXED demo
   epoch (ANCHOR_TS = 2026-09-06T00:00:00Z), never to Date.now() — so
   generateHistory(42) returns byte-identical JSON on every call.

   Ledger unit: one row = one verified *flight* of minute-long menu-bar
   placements for a sponsor (10–25 impressions), settled at the winning
   CPM bid. cut = count × bid × 65% ÷ 1000. This keeps every number on
   the CPM scale used by the payout model ($6 CPM ⇒ $3.90 base per
   1,000 impressions).

   Coffee conversion: balances also display as "≈ N cups" — 1 cup = $5,
   floor(balance / 5).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.FreeCoffeeDemo = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SEED = 42;
  var CUP_PRICE = 5; // $5 buys a coffee — cups hint = floor(balance / 5)

  /* ------------------------------------------------------------------
     Seeded PRNG (mulberry32).
     ------------------------------------------------------------------ */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------
     Model constants — mirror the copy on payouts.html exactly.
     ------------------------------------------------------------------ */
  var MODEL = {
    BASE_SHARE: 0.65,             // transparent 65% of auction revenue, always-on
    BASE_SHARE_COMMITTED: 0.70,   // publicly committed at $50k/mo platform revenue
    COMMIT_THRESHOLD_MONTHLY: 50000,
    CLICK_BONUS: 0.05,            // $ per verified click
    CLICK_MAX_PER_DAY: 5,
    CLICK_CAP_SHARE: 0.25,        // ≤25% of verified monthly impressions
    CLICK_MIN_DELAY_S: 10,        // verification: ≥10s after impression
    CLICK_MIN_DWELL_S: 2,         // verification: ≥2s dwell
    TIERS: {
      1: { name: 'Tier 1', regions: 'US, CA, UK, CH, EEA', floorCPM: 4.0 },
      2: { name: 'Tier 2', regions: 'AU, NZ, JP, KR, SG, AE', floorCPM: 2.5 },
      3: { name: 'Tier 3', regions: 'Rest of world', floorCPM: 1.25 }
    },
    REFERRAL_RATE: 0.10,          // 10% of referee base earnings
    REFERRAL_MONTHS: 12,
    REFERRAL_GATE_MIN: 60,        // verified minutes in first 30 days
    STREAK_STEP_DAYS: 5,          // +1% per 5 consecutive active days
    STREAK_BONUS_PER_STEP: 0.01,
    STREAK_CAP: 0.10,             // max +10%
    STREAK_MIN_MINUTES: 30,       // verified min/day to count as active
    PAYOUT_MINIMUM: 2.0,          // $2 minimum
    PAYOUT_RAIL_HOURS: 24,        // standard rail
    CLAWBACK_DAYS: 90,            // fraud clawback window
    CUP_PRICE: CUP_PRICE,         // $5 per cup for the "≈ N cups" hint
    // Worked example, displayed as-is on payouts.html.
    WORKED_EXAMPLE: {
      impressions: 1000, cpm: 6.0,
      revenue: 6.0, userBase: 3.90, bonusCeiling: 0.55, platformKeeps: 1.55
    },
    SUSTAINABILITY: {
      marginAt6CPM: 27,           // ≈27% platform margin at $6 CPM
      marginAt2CPM: 20,           // ≈20% platform margin at $2 CPM
      breakevenCPM: 0.70          // break-even ≈ $0.70 CPM
    },
    // The ONLY SponsorBar numbers allowed in copy (observed on sponsorbar.io, Sep 2026).
    SPONSORBAR_OBSERVED: {
      launchCPM: 6,
      launchBoostPct: 10,
      referralRate: 0.05,
      referralAttributionDays: 14,
      payoutThreshold: 5,
      payoutCadence: 'weekly',
      countries: 'US/CA/UK/CH/EEA',
      advertiserMinimum: 15
    }
  };

  /* ------------------------------------------------------------------ */
  var SPONSORS = [
    { name: 'Northline',       tag: 'Shipping software, on schedule', bid: 6.0 },
    { name: 'Ledgerly',        tag: 'Invoicing that reconciles itself', bid: 5.25 },
    { name: 'Fernhill Coffee', tag: 'Single-origin, roasted Thursdays', bid: 4.5 },
    { name: 'Breeze VPN',      tag: 'Private tunnels, zero logs', bid: 5.5 },
    { name: 'Kite Studio',     tag: 'A type foundry for busy apps', bid: 4.0 }
  ];

  var DAY_MS = 86400000;
  var ANCHOR_TS = 1788652800000; // FIXED demo clock: 2026-09-06T00:00:00Z

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ts) {
    var d = new Date(ts);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDay(ts) {
    var d = new Date(ts);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /* "≈ N cups" — 1 cup costs $5. */
  function cups(balance) {
    return Math.max(0, Math.floor((Number(balance) || 0) / CUP_PRICE));
  }

  /* ------------------------------------------------------------------
     generateHistory(seed) → deterministic demo ledger + totals.

     ~9 days ending just before the fixed anchor. Each day produces
     40–50 sponsored flights (10–25 minute-long impressions each — a
     fully-filled waking day), plus verified clicks, one completed
     5-day streak block, and daily referral accrual rows. ~460 rows.
     ------------------------------------------------------------------ */
  function generateHistory(seed) {
    var rand = mulberry32(typeof seed === 'number' ? seed : SEED);

    var DAYS = 9;                  // day 0 oldest … day 8 = day before anchor
    var ledger = [];
    var lifetime = 0;
    var clicks = 0;
    var impressions = 0;

    // Weighted tier mix for the (simulated) audience region of each flight:
    // Tier1 ~55%, Tier2 ~25%, Tier3 ~20%.
    function drawTier() {
      var r = rand();
      if (r < 0.55) return 1;
      if (r < 0.80) return 2;
      return 3;
    }

    function drawSponsor() {
      return SPONSORS[Math.floor(rand() * SPONSORS.length)];
    }

    var d, i;

    for (d = 0; d < DAYS; d++) {
      var dayStart = ANCHOR_TS - (DAYS - d) * DAY_MS;

      // Fill ~15 waking hours (07:00–22:59) with back-to-back flights.
      var targetMinutes = 850 + Math.floor(rand() * 60); // 850–909
      var filled = 0;
      var cursorHour = 7;
      var cursorMin = 0;

      while (filled < targetMinutes && cursorHour < 23) {
        var sp = drawSponsor();
        var count = 10 + Math.floor(rand() * 16);         // 10–25 min flight
        if (filled + count > targetMinutes) count = targetMinutes - filled;
        if (count < 5) break;

        // Winning CPM bid wobbles around the sponsor's base bid.
        var bid = round2(sp.bid * (0.88 + rand() * 0.24));
        if (bid < 0.75) bid = 0.75;

        var tier = drawTier();
        var ts = dayStart + cursorHour * 3600000 + cursorMin * 60000;

        // Exact cut for this flight: count × bid × 65% ÷ 1000.
        var cut = round2(count * bid * MODEL.BASE_SHARE / 1000);

        ledger.push({
          ts: ts, timeLabel: fmtTime(ts),
          sponsor: sp.name, type: 'impression',
          bid: bid, cut: cut, tier: tier, count: count,
          note: 'flight of ' + count + ' verified minute-long placements · 65% base share'
        });
        lifetime += cut;
        impressions += count;
        filled += count;

        // Advance the clock by the flight length + a small gap.
        cursorMin += count + 1 + Math.floor(rand() * 3);
        while (cursorMin >= 60) { cursorMin -= 60; cursorHour++; }
      }

      // Verified clicks: 1–2 on ~70% of days (far inside both caps).
      if (d > 0 && rand() < 0.7) {
        var clicksToday = 1 + Math.floor(rand() * 2);
        for (i = 0; i < clicksToday; i++) {
          var ctier = drawTier();
          var csp = drawSponsor();
          var cbid = round2(csp.bid * (0.95 + rand() * 0.1));
          var cts = dayStart + (11 + Math.floor(rand() * 10)) * 3600000 +
                    Math.floor(rand() * 60) * 60000;
          ledger.push({
            ts: cts, timeLabel: fmtTime(cts),
            sponsor: csp.name, type: 'click',
            bid: cbid, cut: MODEL.CLICK_BONUS, tier: ctier, count: 1,
            note: 'verified click · ≥10s after impression, ≥2s dwell · $0.05'
          });
          lifetime += MODEL.CLICK_BONUS;
          clicks++;
        }
      }
    }

    // Streak: the first 5 days form one completed active block (+1% of
    // that block's base earnings); days 5–8 are the in-progress block.
    var streakBlocks = 1;
    var streakBonusTotal = 0;
    var blockBase = 0;
    var t;
    for (t = 0; t < ledger.length; t++) {
      var r0 = ledger[t];
      if (r0.type === 'impression' && r0.ts < ANCHOR_TS - (DAYS - 5) * DAY_MS) blockBase += r0.cut;
    }
    blockBase = round2(blockBase);
    if (blockBase > 0) {
      var sTs = ANCHOR_TS - (DAYS - 5) * DAY_MS + 23 * 3600000 + 30 * 60000;
      var sCut = round2(blockBase * MODEL.STREAK_BONUS_PER_STEP);
      ledger.push({
        ts: sTs, timeLabel: fmtTime(sTs),
        sponsor: '—', type: 'streak',
        bid: 0, cut: sCut, tier: 1, count: 1,
        note: 'streak block complete · 5 consecutive active days (≥30 verified min) → +1% of block base'
      });
      lifetime += sCut;
      streakBonusTotal += sCut;
    }

    // Referral rows: 10% of each referee's daily base earnings.
    // Referee A passed the 60-minute gate; Referee B is inside the 30-day gate.
    var referrals = [
      { name: 'astra.dev', verified: true,  dailyBase: 2.55,
        status: 'Verified · 74 verified minutes in first 30 days' },
      { name: 'quill@mac', verified: false, dailyBase: 1.90,
        status: 'In 30-day gate · 41 of 60 verified minutes' }
    ];
    var rr;
    for (rr = 0; rr < referrals.length; rr++) {
      var refName = referrals[rr].name;
      var refDays = referrals[rr].verified ? DAYS : 3; // B joined 3 days ago
      for (i = 0; i < refDays; i++) {
        var rDay = ANCHOR_TS - (DAYS - i) * DAY_MS;
        var wob = 0.85 + rand() * 0.3;
        var rBase = round2(referrals[rr].dailyBase * wob);
        var rTs = rDay + 21 * 3600000 + Math.floor(rand() * 60) * 60000;
        var rCut = round2(rBase * MODEL.REFERRAL_RATE);
        ledger.push({
          ts: rTs, timeLabel: fmtTime(rTs),
          sponsor: refName + ' (referral)', type: 'referral',
          bid: rBase, cut: rCut, tier: 1, count: 1,
          note: 'referral · 10% of referee base earnings · 12-month term · ' +
                (referrals[rr].verified ? 'gate passed' : 'gate pending (≥60 verified min in 30 days)')
        });
        lifetime += rCut;
      }
    }

    ledger.sort(function (a, b) { return b.ts - a.ts; }); // newest first

    // ---- Totals, computed FROM the ledger so invariants hold by construction.
    // Pending = the newest 24 h of rows; Available = everything older.
    var CUTOFF = ANCHOR_TS;
    var pendingSum = 0;
    for (t = 0; t < ledger.length; t++) {
      if (ledger[t].ts >= CUTOFF - DAY_MS) pendingSum += ledger[t].cut;
    }
    var lifetimeRounded = round2(lifetime);
    var pendingRounded = round2(pendingSum);
    var available = round2(lifetimeRounded - pendingRounded);

    // 7-day buckets (byDay[0] = 7 days back … byDay[6] = day before anchor).
    var byDay = [0, 0, 0, 0, 0, 0, 0];
    var byTier = { 1: 0, 2: 0, 3: 0 };
    var dayLabels = [];
    for (d = 0; d < 7; d++) {
      var wEnd = ANCHOR_TS - (6 - d) * DAY_MS;   // exclusive end
      var wStart = wEnd - DAY_MS;
      var sum = 0;
      for (t = 0; t < ledger.length; t++) {
        var row = ledger[t];
        if (row.ts >= wStart && row.ts < wEnd) {
          sum += row.cut;
          byTier[row.tier] += row.cut;
        }
      }
      byDay[d] = round2(sum);
      dayLabels.push(fmtDay(wEnd - 1));
    }
    for (var tk in byTier) byTier[tk] = round2(byTier[tk]);

    // Referral accrued sums, straight from the ledger.
    for (rr = 0; rr < referrals.length; rr++) {
      var acc = 0;
      for (t = 0; t < ledger.length; t++) {
        if (ledger[t].type === 'referral' &&
            ledger[t].sponsor.indexOf(referrals[rr].name) === 0) acc += ledger[t].cut;
      }
      referrals[rr].accrued = round2(acc);
    }

    var totals = {
      available: available,
      pending: pendingRounded,
      lifetime: lifetimeRounded,
      byDay: byDay,
      dayLabels: dayLabels,
      byTier: byTier,
      clicks: clicks,
      impressions: impressions,
      rows: ledger.length,
      streakBlocks: streakBlocks,
      streakBonusTotal: round2(streakBonusTotal),
      streakProgressDays: DAYS - 1 - MODEL.STREAK_STEP_DAYS * streakBlocks, // in-progress days
      referrals: referrals,
      anchorTs: ANCHOR_TS,
      cutoffTs: CUTOFF,
      seed: (typeof seed === 'number' ? seed : SEED),
      daysGenerated: DAYS
    };

    return {
      ledger: ledger,
      totals: totals,
      model: MODEL,
      sponsors: SPONSORS,
      fmtTime: fmtTime,
      fmtDay: fmtDay
    };
  }

  /* ------------------------------------------------------------------
     Payout-simulator projection (shared math, documented on payouts.html).

     impressions: one minute-long placement per active minute →
       monthly impressions = active minutes/day × 30.
     base: 65% of auction revenue (worked example: $6 CPM ⇒ $3.90 per
       1,000 impressions). Tier floors top up blended monthly earnings
       when auctions run low — a platform-funded guarantee, not modeled
       line-by-line here.
     click bonus: impressions × CTR, then BOTH caps bind:
       5/day × 30 days AND ≤25% of monthly impressions. $0.05 each.
     streak: +1% per 5 active days, cap +10%, applied to base, only when
       the day clears 30 verified active minutes.
     ------------------------------------------------------------------ */
  function projectMonthly(opts) {
    var minutes = Math.max(0, Math.min(600, Number(opts.minutes) || 0));
    var cpm = Math.max(1, Math.min(8, Number(opts.cpm) || 1));
    var ctrPct = Math.max(0, Math.min(3, Number(opts.ctr) || 0));
    var streakOn = !!opts.streak;

    var DAYS = 30;
    var dailyImpressions = Math.round(minutes);        // 1 impression per active minute
    var impressions = dailyImpressions * DAYS;         // monthly
    var gross = impressions * cpm / 1000;
    var base = gross * MODEL.BASE_SHARE;

    var rawClicks = impressions * (ctrPct / 100);
    var capPerMonth = MODEL.CLICK_MAX_PER_DAY * DAYS;   // 5/day cap → 150/mo
    var capShare = MODEL.CLICK_CAP_SHARE * impressions; // ≤25% of impressions
    var cappedClicks = Math.min(rawClicks, capPerMonth, capShare);
    var clickBonus = cappedClicks * MODEL.CLICK_BONUS;

    var streakPct = 0;
    if (streakOn && minutes >= MODEL.STREAK_MIN_MINUTES) {
      streakPct = Math.min(
        Math.floor(DAYS / MODEL.STREAK_STEP_DAYS) * MODEL.STREAK_BONUS_PER_STEP,
        MODEL.STREAK_CAP
      );
    }
    var streakBonus = base * streakPct;

    var monthly = round2(base + clickBonus + streakBonus);
    var daily = monthly / DAYS;
    var etaDays = daily > 0 ? Math.max(1, Math.ceil(MODEL.PAYOUT_MINIMUM / daily)) : null;

    return {
      monthly: monthly,
      daily: round2(daily),
      gross: round2(gross),
      base: round2(base),
      clickBonus: round2(clickBonus),
      streakBonus: round2(streakBonus),
      streakPct: Math.round(streakPct * 100),
      impressions: impressions,
      dailyImpressions: dailyImpressions,
      rawClicks: Math.round(rawClicks),
      cappedClicks: Math.round(cappedClicks),
      capsApplied: rawClicks > Math.min(capPerMonth, capShare) + 1e-9,
      bindingCap: (rawClicks <= Math.min(capPerMonth, capShare) + 1e-9) ? null
        : (capShare < capPerMonth ? '25% of verified monthly impressions' : '5 clicks/day'),
      firstPayoutEtaDays: etaDays,
      firstPayoutEtaLabel: etaDays === null ? '—'
        : (etaDays === 1 ? '~1 day' : '~' + etaDays + ' days')
    };
  }

  /* ------------------------------------------------------------------
     Browser-only: menu-bar cycler + live clock + balance ticker for the
     landing hero, plus the popover web mock (totals + 7-day bars).
     Respects prefers-reduced-motion; pauses when document.hidden;
     freezes when the demo is paused.
     ------------------------------------------------------------------ */
  function initMenuBarDemo() {
    if (typeof document === 'undefined') return null;

    var chip = document.getElementById('demoSponsorChip');
    var tag = document.getElementById('demoSponsorTag');
    var clock = document.getElementById('demoClock');
    var balance = document.getElementById('demoBalance');
    var cupsEl = document.getElementById('demoCups');
    var chartEl = document.getElementById('demoChart');
    var weekSum = document.getElementById('demoWeekSum');
    var bar = document.getElementById('demoMenuBar');
    if (!chip && !clock && !balance && !chartEl) return null;

    var reduced = false;
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { reduced = false; }

    // Balance starts at the seeded ledger's lifetime so the landing demo
    // and the dashboard tell the same story.
    var balanceCents = 226;
    var history = null;
    try {
      history = generateHistory(SEED);
      balanceCents = Math.round((history.totals.available + history.totals.pending) * 100);
    } catch (e) { /* keep fallback */ }

    // Popover web mock: 7 inset bars (weekday letter + value label) from
    // the seeded history's 7-day buckets. Static — built once.
    if (chartEl && history) {
      var byDay = history.totals.byDay;
      var letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      var max = 0, i;
      for (i = 0; i < byDay.length; i++) if (byDay[i] > max) max = byDay[i];
      if (max <= 0) max = 1;
      // Weekday letters for the 7 bucket days, ending the day before the anchor.
      var anchor = history.totals.anchorTs;
      for (i = 0; i < byDay.length; i++) {
        var col = document.createElement('span');
        col.className = 'pop-barcol';
        var val = document.createElement('span');
        val.className = 'pop-barval';
        val.textContent = '$' + byDay[i].toFixed(2);
        var b = document.createElement('span');
        b.className = 'pop-bar';
        b.style.height = Math.max(4, Math.round((byDay[i] / max) * 100)) + '%';
        var wd = new Date(anchor - (7 - i) * DAY_MS).getUTCDay();
        var letter = document.createElement('span');
        letter.className = 'pop-letter';
        letter.textContent = letters[wd];
        col.appendChild(val); col.appendChild(b); col.appendChild(letter);
        chartEl.appendChild(col);
      }
      if (weekSum) {
        var wk = 0;
        for (i = 0; i < byDay.length; i++) wk += byDay[i];
        weekSum.textContent = '$' + round2(wk).toFixed(2) + ' this week';
      }
    }

    // Display cycle order is shuffled per visit (display only — history
    // stays seed-42 canonical).
    var order = SPONSORS.slice();
    var crand = mulberry32(((Date.now() & 0xffff) | 1) >>> 0);
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(crand() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }

    var idx = 0;
    var paused = false;
    var chipTimer = null;
    var balTimer = null;

    function renderChip() {
      var sp = order[idx % order.length];
      if (chip) chip.textContent = sp.name;
      if (tag) tag.textContent = sp.tag;
    }

    function renderClock() {
      if (!clock) return;
      var now = new Date();
      var h12 = now.getHours() % 12; if (h12 === 0) h12 = 12;
      clock.textContent = h12 + ':' + pad2(now.getMinutes()) + ' ' +
        (now.getHours() < 12 ? 'AM' : 'PM');
    }

    function renderBalance() {
      var dollars = balanceCents / 100;
      if (balance) balance.textContent = '$' + dollars.toFixed(2);
      if (cupsEl) cupsEl.textContent = '≈ ' + cups(dollars) + ' cups of coffee';
    }

    function tickBalance() {
      if (paused || document.hidden || reduced) return;
      if (crand() < 0.5) {
        balanceCents += 1 + Math.floor(crand() * 3); // a cent or three
        renderBalance();
      }
    }

    function advanceChip() {
      if (paused || document.hidden || reduced) return;
      idx++;
      renderChip();
    }

    function startTimers() {
      if (reduced) return; // static frame under reduced motion
      clearInterval(chipTimer); clearInterval(balTimer);
      chipTimer = setInterval(advanceChip, 6000);
      balTimer = setInterval(tickBalance, 4500);
    }

    function stopTimers() {
      clearInterval(chipTimer); clearInterval(balTimer);
    }

    function markLive() {
      if (bar) {
        bar.setAttribute('data-live',
          (!paused && !document.hidden && !reduced) ? 'true' : 'false');
      }
    }

    renderChip(); renderClock(); renderBalance(); markLive();

    // Clock ticks every second (a text update — not motion). Under
    // reduced motion we still show the real time, once per minute.
    setInterval(function () {
      if (document.hidden) return;
      renderClock();
    }, reduced ? 60000 : 1000);

    startTimers();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopTimers(); else startTimers();
      renderClock(); markLive();
    });

    return {
      pause: function () { paused = true; stopTimers(); markLive(); },
      resume: function () { paused = false; startTimers(); markLive(); },
      isPaused: function () { return paused; }
    };
  }

  /* ------------------------------------------------------------------
     PWA install UX (index.html hero + dashboard header). The #installBtn
     markup is hidden by default; it appears when beforeinstallprompt
     fires (captured + preventDefault'd), prompt() runs on click, and
     appinstalled hides it with a toast. iOS Safari never fires the
     prompt event, so when running in-browser on an iPhone/iPad we show
     the manual "Share → Add to Home Screen" hint line instead.
     ------------------------------------------------------------------ */
  function initInstallUX() {
    if (typeof document === 'undefined') return null;
    var btn = document.getElementById('installBtn');
    var hint = document.getElementById('installHint');
    if (!btn) return null;

    var deferredPrompt = null;

    var isStandalone = false;
    try {
      isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    } catch (e) { isStandalone = false; }
    if (!isStandalone && window.navigator && window.navigator.standalone === true) {
      isStandalone = true; // iOS Safari standalone flag
    }

    // Same toast visuals as the dashboard (.toast-region/.toast CSS exists);
    // creates the region on demand for pages that don't ship one (index).
    function toast(msg) {
      var region = document.getElementById('toastRegion');
      if (!region) {
        region = document.createElement('div');
        region.className = 'toast-region';
        region.setAttribute('aria-live', 'polite');
        document.body.appendChild(region);
      }
      var t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      region.appendChild(t);
      window.setTimeout(function () { t.classList.add('show'); }, 10);
      window.setTimeout(function () {
        t.classList.remove('show');
        window.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
      }, 3800);
    }

    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();               // take over the install flow
      deferredPrompt = ev;
      if (hint) hint.hidden = true;
      if (!isStandalone) btn.hidden = false;
    });

    btn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          btn.hidden = true;
          toast('FreeCoffee installed — find it in your apps. (demo)');
        }
        deferredPrompt = null;
      }).catch(function () { deferredPrompt = null; });
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      btn.hidden = true;
      if (hint) hint.hidden = true;
      toast('FreeCoffee app installed. Demo data stays in this browser.');
    });

    // No prompt support + iOS Safari in-browser → manual-install hint.
    if (!isStandalone && hint &&
        /iphone|ipad/i.test(window.navigator.userAgent || '')) {
      hint.hidden = false;
    }

    return null;
  }

  /* ------------------------------------------------------------------ */
  return {
    SEED: SEED,
    MODEL: MODEL,
    SPONSORS: SPONSORS,
    ANCHOR_TS: ANCHOR_TS,
    CUP_PRICE: CUP_PRICE,
    mulberry32: mulberry32,
    generateHistory: generateHistory,
    projectMonthly: projectMonthly,
    cups: cups,
    initMenuBarDemo: initMenuBarDemo,
    initInstallUX: initInstallUX,
    fmtTime: fmtTime,
    fmtDay: fmtDay,
    version: '2.0.0-demo'
  };
});
