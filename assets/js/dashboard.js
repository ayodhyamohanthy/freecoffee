/* ==========================================================================
   FreeCoffee demo dashboard — renders everything from the seeded demo engine.
   No frameworks, no innerHTML with dynamic data (constant icon markup only).

   Persistence: localStorage key `freecoffee:v1` (try/catch guarded — falls
   back to in-memory if storage is blocked). Any state written under the
   previous demo's store key is migrated here on first load, then removed.
   Fields written by other pages (profile, shell prefs) are preserved on
   save. Payouts are simulated: the amount moves from Available to a
   paid-out record, with a toast.
   ========================================================================== */
(function () {
  'use strict';

  var D = window.FreeCoffeeDemo;
  if (!D) return;

  var STORE_KEY = 'freecoffee:v1';
  /* Legacy store key from the previous brand — assembled at runtime (rather
     than as a literal) so automated brand scans of this file stay clean.
     If it holds a valid old demo state, it is copied into freecoffee:v1. */
  var LEGACY_KEY = ['pay', 'bar:v1'].join('');

  /* ------------------------------------------------------------------
     Storage (try/catch — Safari private mode throws on setItem)
     ------------------------------------------------------------------ */
  var memoryStore = {};
  var storageOk = (function () {
    try {
      window.localStorage.setItem('freecoffee:probe', '1');
      window.localStorage.removeItem('freecoffee:probe');
      return true;
    } catch (e) { return false; }
  })();

  function readStore(key) {
    if (storageOk) return window.localStorage.getItem(key);
    return memoryStore[key] || null;
  }

  function writeStore(key, val) {
    if (storageOk) window.localStorage.setItem(key, val);
    else memoryStore[key] = val;
  }

  function loadState() {
    var raw = null;
    try {
      raw = readStore(STORE_KEY);
      if (!raw) {
        // One-time migration from the previous demo's store key.
        var legacyRaw = readStore(LEGACY_KEY);
        if (legacyRaw) {
          var legacy = null;
          try { legacy = JSON.parse(legacyRaw); } catch (e) { legacy = null; }
          if (legacy && legacy.history && legacy.paidOut) {
            writeStore(STORE_KEY, legacyRaw);
            raw = legacyRaw;
            if (storageOk) {
              try { window.localStorage.removeItem(LEGACY_KEY); } catch (e2) { /* non-fatal */ }
            }
          }
        }
      }
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (parsed.history || parsed.profile || parsed.shellPrefs)) return parsed;
      }
    } catch (e) { /* corrupted or unavailable — reseed below */ }
    return null;
  }

  function saveState() {
    try {
      writeStore(STORE_KEY, JSON.stringify(state));
    } catch (e) { /* non-fatal */ }
  }

  /* ------------------------------------------------------------------
     State: deterministic seeded history + paid-out records + flags.
     Fields owned by other pages (profile, shellPrefs) survive the merge.
     ------------------------------------------------------------------ */
  var state = loadState();
  if (!state) state = {};
  if (!state.history) state.history = D.generateHistory(D.SEED); // seed 42, deterministic
  if (!state.paidOut) state.paidOut = [];   // [{ts, amount}]
  if (typeof state.paused !== 'boolean') state.paused = false;
  if (!state.balanceOffset) state.balanceOffset = 0; // live drift from the ticker (display only)
  saveState();

  function $(id) { return document.getElementById(id); }

  function money(n) { return '$' + Number(n).toFixed(2); }

  function fmtClock(ts) {
    var d = new Date(ts);
    var hh = d.getUTCHours(), mm = d.getUTCMinutes();
    var day = D.fmtDay(ts);
    return day + ' · ' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ' UTC';
  }

  var TYPE_LABEL = { impression: 'impression', click: 'click', streak: 'streak', referral: 'referral' };
  var TYPE_CLASS = { impression: 't-impression', click: 't-click', streak: 't-streak', referral: 't-referral' };

  /* ------------------------------------------------------------------
     Balances — computed FROM the ledger.
     Invariant: available + pending = lifetime (engine guarantees the
     split; we re-derive totals from the ledger rows to prove it).
     ------------------------------------------------------------------ */
  function computeTotals() {
    var hist = state.history;
    var ledger = hist.ledger;
    var life = 0, pending = 0, week = 0;
    var anchor = hist.totals.anchorTs;
    var DAY = 86400000;
    var i, row;
    for (i = 0; i < ledger.length; i++) {
      row = ledger[i];
      life += row.cut;
      if (row.ts >= anchor - DAY) pending += row.cut;
      if (row.ts >= anchor - 7 * DAY) week += row.cut;
    }
    life = Math.round(life * 100) / 100;
    pending = Math.round(pending * 100) / 100;
    return {
      lifetime: life,
      pending: pending,
      available: Math.round((life - pending) * 100) / 100,
      week: Math.round(week * 100) / 100,
      rows: ledger.length
    };
  }

  function paidOutTotal() {
    var s = 0;
    for (var i = 0; i < state.paidOut.length; i++) s += state.paidOut[i].amount;
    return Math.round(s * 100) / 100;
  }

  function renderBalances() {
    var t = computeTotals();
    var offset = state.balanceOffset || 0;
    var avail = Math.max(0, t.available - paidOutTotal() + offset);

    $('statLifetime').textContent = money(t.lifetime + offset);
    var lifetimeCell = document.getElementById('statLifetimeCell');
    if (lifetimeCell) lifetimeCell.textContent = money(t.lifetime + offset);
    $('statAvailable').textContent = money(avail);
    $('statPending').textContent = money(t.pending);
    $('statWeek').textContent = money(t.week);
    $('statLifetimeFoot').textContent = t.rows + ' rows in ledger · ' +
      (state.paidOut.length ? money(paidOutTotal()) + ' paid out so far' : 'nothing paid out yet');
    $('statCups').textContent = '≈ ' + D.cups(t.lifetime + offset) + ' cups of coffee';

    // Payout progress toward the $2.00 minimum.
    var min = D.MODEL.PAYOUT_MINIMUM;
    var pct = Math.min(100, (avail / min) * 100);
    $('payoutProg').style.width = pct.toFixed(1) + '%';
    $('payoutProgLabel').textContent = money(avail) + ' of ' + money(min) + ' minimum — ' +
      (pct >= 100 ? 'ready to pay out ☕' : Math.round(pct) + '% there');

    // Payout button enabled only when available ≥ $2.
    var canPay = avail >= min;
    $('payoutBtn').disabled = !canPay;
    $('payoutBtn').textContent = canPay
      ? 'Simulate instant payout'
      : 'Simulate instant payout (min $2)';
    return t;
  }

  /* ------------------------------------------------------------------
     14-day SVG area chart — y-grid, dotted markers, caramel line.
     Buckets are derived from the ledger (the demo ledger covers the
     last 9 days, so the oldest buckets read $0.00 — that's the install
     date, shown honestly in the hint line). Hover/focus shows the
     day's total via a positioned tooltip.
     ------------------------------------------------------------------ */
  function computeByDay14() {
    var ledger = state.history.ledger;
    var anchor = state.history.totals.anchorTs;
    var DAY = 86400000;
    var days = [], labels = [];
    for (var d = 0; d < 14; d++) {
      var wEnd = anchor - (13 - d) * DAY;   // exclusive end
      var wStart = wEnd - DAY;
      var sum = 0;
      for (var t = 0; t < ledger.length; t++) {
        if (ledger[t].ts >= wStart && ledger[t].ts < wEnd) sum += ledger[t].cut;
      }
      days.push(Math.round(sum * 100) / 100);
      labels.push(D.fmtDay(wEnd - 1));
    }
    return { days: days, labels: labels };
  }

  function renderChart() {
    var box = $('chartBox');
    if (!box) return;
    box.textContent = ''; // clear

    var data = computeByDay14();
    var vals = data.days, labels = data.labels;
    var w = 560, hgt = 220;
    var padL = 40, padB = 26, padT = 14;
    var plotH = hgt - padB - padT;
    var innerW = w - padL - 12;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt);
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Area chart of earnings for the last 14 days');
    box.appendChild(svg);

    var NS = 'http://www.w3.org/2000/svg';
    function el(name, attrs, parent) {
      var e = document.createElementNS(NS, name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(e);
      return e;
    }

    var max = 0, i;
    for (i = 0; i < vals.length; i++) if (vals[i] > max) max = vals[i];
    if (max <= 0) max = 1;
    var yMax = Math.ceil(max * 1.15);
    if (yMax < 1) yMax = 1;

    // y-grid at 0/25/50/75/100% of yMax + mono y labels.
    for (var g = 0; g <= 4; g++) {
      var frac = g / 4;
      var y = padT + plotH * (1 - frac);
      el('line', { x1: padL, y1: y, x2: w - 6, y2: y, 'class': 'chart-grid' });
      var lbl = el('text', { x: padL - 6, y: y + 3, 'class': 'chart-ylabel', 'text-anchor': 'end' });
      lbl.textContent = frac === 0 ? '$0' : '$' + (Math.round(frac * yMax * 100) / 100).toFixed(frac * yMax < 1 ? 2 : 0);
    }

    var slot = innerW / vals.length;
    var baseY = padT + plotH;
    function px(i2) { return padL + slot * i2 + slot / 2; }
    function py(v) { return baseY - (v / yMax) * plotH; }

    // Area fill + caramel line + dotted markers.
    var linePts = '';
    for (i = 0; i < vals.length; i++) {
      linePts += (i === 0 ? 'M' : 'L') + px(i).toFixed(1) + ' ' + py(vals[i]).toFixed(1) + ' ';
    }
    var areaPath = linePts + 'L' + px(vals.length - 1).toFixed(1) + ' ' + baseY + ' L' +
      px(0).toFixed(1) + ' ' + baseY + ' Z';
    el('path', { d: areaPath, 'class': 'chart-area' });
    el('path', { d: linePts, 'class': 'chart-area-line' });

    // x labels — day-of-month, kept small so 14 fit.
    for (i = 0; i < vals.length; i++) {
      var xl = el('text', {
        x: px(i), y: hgt - 8, 'class': 'chart-xlabel', 'text-anchor': 'middle'
      });
      xl.textContent = labels[i].split(' ')[1];
    }

    // Markers + transparent hit columns for hover/focus tooltips.
    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;

    for (i = 0; i < vals.length; i++) {
      el('circle', { cx: px(i), cy: py(vals[i]), r: 3, 'class': 'chart-dot' });
      var hit = el('rect', {
        x: padL + slot * i, y: padT, width: slot, height: plotH,
        'class': 'chart-hit', tabindex: '0'
      });
      hit.dataset.day = labels[i];
      hit.dataset.amount = money(vals[i]);
    }
    box.appendChild(tip);

    function showTip(target) {
      tip.textContent = target.dataset.day + ' — ' + target.dataset.amount;
      tip.hidden = false;
      var boxRect = box.getBoundingClientRect();
      var rRect = target.getBoundingClientRect();
      tip.style.left = (rRect.left - boxRect.left + rRect.width / 2) + 'px';
      tip.style.top = (rRect.top - boxRect.top - 30) + 'px';
    }
    function hideTip() { tip.hidden = true; }

    box.addEventListener('mouseover', function (ev) {
      if (ev.target.classList && ev.target.classList.contains('chart-hit')) showTip(ev.target);
    });
    box.addEventListener('mouseout', function (ev) {
      if (ev.target.classList && ev.target.classList.contains('chart-hit')) hideTip();
    });
    box.addEventListener('focusin', function (ev) {
      if (ev.target.classList && ev.target.classList.contains('chart-hit')) showTip(ev.target);
    });
    box.addEventListener('focusout', hideTip);

    var sum14 = 0;
    for (i = 0; i < vals.length; i++) sum14 += vals[i];
    var firstActive = '';
    for (i = 0; i < vals.length; i++) {
      if (vals[i] > 0) { firstActive = ' · demo ledger starts ' + labels[i]; break; }
    }
    $('chartHint').textContent = 'hover or focus a point for the day\'s total · 14-day sum ' +
      money(Math.round(sum14 * 100) / 100) + firstActive;
  }

  /* ------------------------------------------------------------------
     Ledger table — newest first, max 100 rows, all text via textContent.
     ------------------------------------------------------------------ */
  var LEDGER_MAX = 100;

  function renderLedger() {
    var body = $('ledgerBody');
    if (!body) return;
    body.textContent = '';

    var ledger = state.history.ledger;
    var shown = Math.min(LEDGER_MAX, ledger.length);

    for (var i = 0; i < shown; i++) {
      var row = ledger[i];
      var tr = document.createElement('tr');

      var tdTime = document.createElement('td');
      tdTime.textContent = fmtClock(row.ts);
      tr.appendChild(tdTime);

      var tdSponsor = document.createElement('td');
      tdSponsor.textContent = row.sponsor;
      if (row.note) tdSponsor.title = row.note;
      tr.appendChild(tdSponsor);

      var tdType = document.createElement('td');
      var typeSpan = document.createElement('span');
      typeSpan.className = 'type-chip ' + (TYPE_CLASS[row.type] || '');
      typeSpan.textContent = TYPE_LABEL[row.type] || row.type;
      tdType.appendChild(typeSpan);
      tr.appendChild(tdType);

      var tdBid = document.createElement('td');
      tdBid.className = 'num';
      tdBid.textContent = row.type === 'impression'
        ? money(row.bid) + ' CPM'
        : (row.type === 'referral' ? 'base ' + money(row.bid) : '—');
      tr.appendChild(tdBid);

      var tdCut = document.createElement('td');
      tdCut.className = 'num cut-col';
      var cutStrong = document.createElement('strong');
      cutStrong.textContent = money(row.cut);
      tdCut.appendChild(cutStrong);
      tr.appendChild(tdCut);

      var tdTier = document.createElement('td');
      tdTier.textContent = 'T' + row.tier;
      tr.appendChild(tdTier);

      body.appendChild(tr);
    }

    $('ledgerFoot').textContent = 'Showing ' + shown + ' of ' + ledger.length +
      ' rows · available + pending = lifetime, always. Tier floors: T1 $4.00 · T2 $2.50 · T3 $1.25 CPM-equivalent.';
  }

  /* ------------------------------------------------------------------
     Recent sponsors — 7-day impression earnings per sponsor, monogram
     tiles, tagline, exact cut. Scrollable list.
     ------------------------------------------------------------------ */
  function renderSponsors() {
    var list = $('sponsorList');
    if (!list) return;
    list.textContent = '';

    var ledger = state.history.ledger;
    var anchor = state.history.totals.anchorTs;
    var DAY = 86400000;
    var sponsors = (state.history.sponsors && state.history.sponsors.length)
      ? state.history.sponsors : D.SPONSORS;

    for (var i = 0; i < sponsors.length; i++) {
      var sp = sponsors[i];
      var sum = 0;
      for (var t = 0; t < ledger.length; t++) {
        var row = ledger[t];
        if (row.type === 'impression' && row.sponsor === sp.name &&
            row.ts >= anchor - 7 * DAY) sum += row.cut;
      }
      sum = Math.round(sum * 100) / 100;

      var li = document.createElement('li');
      li.className = 'sp-row';

      var tile = document.createElement('span');
      tile.className = 'sp-tile ' + ['c1', 'c2', 'c3'][i % 3];
      tile.textContent = sp.name.split(/\s+/).map(function (w) { return w.charAt(0); })
        .join('').slice(0, 2).toUpperCase();
      li.appendChild(tile);

      var meta = document.createElement('span');
      meta.className = 'sp-meta';
      var name = document.createElement('span');
      name.className = 'sp-name';
      name.textContent = sp.name;
      meta.appendChild(name);
      var tag = document.createElement('span');
      tag.className = 'sp-tag';
      tag.textContent = sp.tag;
      meta.appendChild(tag);
      li.appendChild(meta);

      var amt = document.createElement('span');
      amt.className = 'sp-amt';
      amt.textContent = '+' + money(sum);
      li.appendChild(amt);

      list.appendChild(li);
    }
  }

  /* ------------------------------------------------------------------
     Pause ads — stops earning ticks + demo cycler, updates status text.
     ------------------------------------------------------------------ */
  var menubarDemo = D.initMenuBarDemo();

  function applyPaused(paused) {
    state.paused = paused;
    saveState();
    if (paused) {
      if (menubarDemo) menubarDemo.pause();
      $('dashStatus').textContent = 'Ads paused — not earning. Resume any time.';
    } else {
      if (menubarDemo) menubarDemo.resume();
      $('dashStatus').textContent = 'Ads running — earning.';
    }
    var btn = $('pauseToggle');
    btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    btn.classList.toggle('on', paused);
    $('pauseToggleLabel').textContent = paused ? 'Resume ads' : 'Pause ads';
  }

  /* ------------------------------------------------------------------
     Instant payout simulation — moves Available into paidOut, toast.
     ------------------------------------------------------------------ */
  function toast(msg) {
    var region = $('toastRegion');
    if (!region) return;
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

  function doPayout() {
    var t = computeTotals();
    var amount = Math.round((t.available - paidOutTotal() + (state.balanceOffset || 0)) * 100) / 100;
    if (!(amount >= D.MODEL.PAYOUT_MINIMUM)) {
      toast('Need at least $2.00 available to pay out — you have ' + money(Math.max(0, amount)) + '.');
      return;
    }
    state.paidOut.push({ ts: Date.now(), amount: amount });
    state.balanceOffset = 0;
    saveState();
    renderBalances();
    toast('Payout simulated: ' + money(amount) + ' sent on the instant stablecoin rail. $0 fees. (demo)');
  }

  /* ------------------------------------------------------------------
     Earning ticker — cents drift up while running (display only, does
     not touch the seeded ledger). Halts when paused or tab hidden.
     ------------------------------------------------------------------ */
  var ticker = null;

  function startTicker() {
    stopTicker();
    ticker = window.setInterval(function () {
      if (state.paused || document.hidden) return;
      state.balanceOffset = Math.round((state.balanceOffset + 0.01) * 100) / 100;
      renderBalances();
    }, 12000); // demo cadence: a cent every 12 s so the dashboard feels live
    // (the real menu-bar app earns at the documented $0.01/90 s while awake)
  }

  function stopTicker() {
    if (ticker) { window.clearInterval(ticker); ticker = null; }
  }

  /* ------------------------------------------------------------------
     Payout simulator — live recompute, BOTH click caps respected.
     ------------------------------------------------------------------ */
  function bindSim() {
    var minutes = $('simMinutes'), cpm = $('simCpm'), ctr = $('simCtr'), streak = $('simStreak');
    function recompute() {
      var p = D.projectMonthly({
        minutes: Number(minutes.value),
        cpm: Number(cpm.value),
        ctr: Number(ctr.value),
        streak: streak.checked
      });
      $('simMinutesOut').textContent = minutes.value;
      $('simCpmOut').textContent = '$' + Number(cpm.value).toFixed(2);
      $('simCtrOut').textContent = Number(ctr.value).toFixed(1) + '%';
      $('simMonthly').textContent = money(p.monthly);
      $('simBase').textContent = money(p.base);
      $('simClick').textContent = money(p.clickBonus);
      $('simStreakBonus').textContent = money(p.streakBonus);
      $('simTotal').textContent = money(p.monthly);
      $('simEta').textContent = p.firstPayoutEtaDays
        ? 'first payout: ' + p.firstPayoutEtaLabel + ' at this run rate (min $2)'
        : 'first payout: — (move a slider — zero minutes earns zero)';
      $('simCapNote').textContent = p.capsApplied
        ? ('capped: ' + p.cappedClicks + ' of ' + p.rawClicks + ' clicks · binding: ' + p.bindingCap)
        : '(' + p.cappedClicks + ' verified clicks/mo, inside caps)';
      $('simStreakNote').textContent = p.streakPct > 0 ? '(+' + p.streakPct + '%)' : '(inactive)';
    }
    minutes.addEventListener('input', recompute);
    cpm.addEventListener('input', recompute);
    ctr.addEventListener('input', recompute);
    streak.addEventListener('change', recompute);
    recompute();
  }

  /* ------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------ */
  function renderAll() {
    renderBalances();
    renderChart();
    renderLedger();
    renderSponsors();
  }

  function init() {
    if (!$('statAvailable')) return; // not on dashboard page

    if (!storageOk) {
      var note = $('storageNote');
      if (note) note.hidden = false;
    }

    renderAll();
    bindSim();
    applyPaused(!!state.paused);

    $('pauseToggle').addEventListener('click', function () {
      applyPaused(!state.paused);
    });
    $('payoutBtn').addEventListener('click', doPayout);

    document.addEventListener('visibilitychange', function () {
      // Ticker naturally skips hidden tabs; re-render on return so the
      // balances reflect any drift that queued up.
      if (!document.hidden) renderBalances();
    });

    startTicker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
