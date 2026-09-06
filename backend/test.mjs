/* ==========================================================================
   FreeCoffee backend — unit tests for the PURE worker helpers.
   No network, no KV, no Workers runtime: imports only the exported pure
   functions from src/worker.js and runs them with injected clocks.

   Run:  node freecoffee/backend/test.mjs   → exit 0 + PASS lines
   ========================================================================== */
import assert from 'node:assert/strict';
import {
  validateCampaigns,
  applyEarnings,
  pickRoute,
  ledgerView
} from './src/worker.js';

/* Fixed clocks: 2026-09-06 12:00 UTC and the next day. */
const T1 = Date.UTC(2026, 8, 6, 12, 0, 0);
const T2 = Date.UTC(2026, 8, 7, 12, 0, 0);

const FEED = [
  { id: 'camp_1', sponsor: 'Test Sponsor', clickUrl: 'https://ads.example/offer', cpm: 6 },
  { id: 'no_clicks', sponsor: 'No Clicks Inc', clickUrl: 'https://ads.example/nc', cpm: 8, allowClicks: false }
];

let n = 0;
function pass(name) { n++; console.log('PASS ' + name); }

/* ------------------------------------------------------------------------
   1. validateCampaigns — URL scheme rules
   ------------------------------------------------------------------------ */
{
  const v = validateCampaigns([
    { id: 'a', sponsor: 'HTTP Co', clickUrl: 'http://insecure.example/x', cpm: 5 },
    { id: 'b', sponsor: 'Data Co', clickUrl: 'data:text/html,<b>hi</b>', cpm: 5 },
    { id: 'c', sponsor: 'OK Co', clickUrl: 'https://ok.example/x?utm=fc', cpm: 6 },
    { id: 'd', sponsor: 'NoUrl Co', cpm: 2 }
  ]);
  assert.equal(v.length, 4, 'valid entries kept');
  assert.equal(v[0].clickUrl, '', 'http:// clickUrl dropped');
  assert.equal(v[1].clickUrl, '', 'data: clickUrl dropped');
  assert.equal(v[2].clickUrl, 'https://ok.example/x?utm=fc', 'https clickUrl kept');
  assert.equal(v[3].clickUrl, '', 'missing clickUrl → linkless');
  pass('validateCampaigns rejects http:/data: URLs (strips them, keeps campaigns)');
}

/* ------------------------------------------------------------------------
   2. validateCampaigns — string caps, cpm clamp, dedupe, cap 20
   ------------------------------------------------------------------------ */
{
  const long = 'X'.repeat(60);
  const longTag = 'T'.repeat(120);
  const v = validateCampaigns([
    { id: long, sponsor: long, tagline: longTag, clickUrl: 'https://x.example/', cpm: 150, logoText: 'ABC' },
    { id: 'neg', sponsor: 'Neg CPM', clickUrl: 'https://x.example/', cpm: -3 },
    { id: 'junk', sponsor: 'Junk CPM', clickUrl: 'https://x.example/', cpm: 'garbage' },
    { id: 'dup', sponsor: 'First', clickUrl: 'https://x.example/', cpm: 1 },
    { id: 'dup', sponsor: 'Second', clickUrl: 'https://x.example/', cpm: 2 },
    { sponsor: 'NoId', clickUrl: 'https://x.example/', cpm: 1 },
    { id: 'nosponsor', clickUrl: 'https://x.example/', cpm: 1 }
  ]);
  assert.equal(v.length, 4, 'dup + id-less + sponsor-less entries dropped');
  assert.equal(v[0].id.length, 40, 'id capped at 40');
  assert.equal(v[0].sponsor.length, 40, 'sponsor capped at 40');
  assert.equal(v[0].tagline.length, 90, 'tagline capped at 90');
  assert.equal(v[0].logoText.length, 2, 'logoText capped at 2');
  assert.equal(v[0].cpm, 100, 'cpm clamped to ≤100');
  assert.equal(v[1].cpm, 0, 'negative cpm clamped to 0');
  assert.equal(v[2].cpm, 0, 'garbage cpm coerced to 0');

  const many = [];
  for (let i = 0; i < 25; i++) many.push({ id: 'c' + i, sponsor: 'S' + i, clickUrl: 'https://x.example/', cpm: 1 });
  assert.equal(validateCampaigns(many).length, 20, 'campaign list capped at 20');
  assert.deepEqual(validateCampaigns('nope'), [], 'non-array input → []');
  pass('validateCampaigns caps strings, clamps cpm 0–100, dedupes, caps at 20');
}

/* ------------------------------------------------------------------------
   3. applyEarnings — impression award = 0.65 × cpm × minutes ÷ 1000
   ------------------------------------------------------------------------ */
{
  const r1 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 1 }, FEED, T1);
  assert.equal(r1.earned, 0.0039, '1 min @ $6 CPM → 0.65×6×1/1000 = $0.0039');
  assert.equal(r1.ledger.total, 0.0039);
  assert.equal(r1.ledger.counters.impressions, 1);
  assert.equal(r1.ledger.monthly.impressions, 1);
  assert.equal(r1.ledger.rows.length, 1);
  assert.equal(r1.ledger.rows[0].amount, 0.0039);
  assert.equal(r1.ledger.rows[0].campaignId, 'camp_1');

  const r10 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 10 }, FEED, T1);
  assert.equal(r10.earned, 0.039, '10 min @ $6 CPM → $0.039');

  const r60 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 90 }, FEED, T1);
  assert.equal(r60.earned, 0.234, 'minutes clamped 90→60 → $0.234');
  assert.equal(r60.ledger.counters.impressions, 60, 'clamped minutes counted');

  const r0 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 'garbage' }, FEED, T1);
  assert.equal(r0.earned, 0, 'garbage minutes → 0 earned');
  assert.equal(r0.ledger.counters.impressions, 0);

  const rd = applyEarnings(null, { type: 'impression', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(rd.earned, 0.0039, 'absent minutes defaults to 1');

  const rg = applyEarnings(null, { type: 'impression', campaignId: 'ghost', minutes: 5 }, FEED, T1);
  assert.equal(rg.earned, 0, 'unknown campaign pays 0');
  assert.ok(/unknown/.test(rg.note), 'note explains the zero');
  assert.equal(rg.ledger.counters.impressions, 5, 'impressions still counted honestly');
  pass('applyEarnings awards 0.65×cpm×minutes/1000, clamps 0–60, defaults 1');
}

/* ------------------------------------------------------------------------
   4. applyEarnings — click: $0.05, 5/day cap, ≤25% of monthly impressions
   ------------------------------------------------------------------------ */
{
  /* 20 impressions this month → share cap = exactly 5 clicks. */
  let st = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 20 }, FEED, T1).ledger;
  for (let i = 0; i < 5; i++) {
    const r = applyEarnings(st, { type: 'click', campaignId: 'camp_1' }, FEED, T1);
    assert.equal(r.earned, 0.05, 'click ' + (i + 1) + ' pays $0.05');
    st = r.ledger;
  }
  assert.equal(st.counters.todayClicks.count, 5);
  assert.equal(st.counters.clicks, 5);
  const r6 = applyEarnings(st, { type: 'click', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(r6.earned, 0, '6th click of the day pays 0');
  assert.ok(/daily/.test(r6.note), 'note names the daily cap');
  assert.equal(r6.ledger.total, st.total, 'capped click adds nothing');

  /* Next day: daily counter resets; share cap (20 impressions → 5) still allows click #1. */
  const d2 = applyEarnings(r6.ledger, { type: 'click', campaignId: 'camp_1' }, FEED, T2);
  assert.equal(d2.earned, 0.05, 'daily cap resets across dates');
  assert.equal(d2.ledger.counters.todayClicks.date, '2026-09-07');
  assert.equal(d2.ledger.today.date, '2026-09-07');
  assert.equal(d2.ledger.today.total, 0.05, 'today bucket rolled');
  pass('applyEarnings enforces the 5 clicks/day cap (resets daily)');
}

{
  /* 4 impressions → share cap = 25% × 4 = exactly 1 click. */
  let st = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 4 }, FEED, T1).ledger;
  const c1 = applyEarnings(st, { type: 'click', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(c1.earned, 0.05, '1 click on 4 impressions = exactly 25% → allowed');
  const c2 = applyEarnings(c1.ledger, { type: 'click', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(c2.earned, 0, '2nd click on 4 impressions breaches the 25% share');
  assert.ok(/monthly/.test(c2.note), 'note names the monthly share cap');

  /* Zero impressions this month → no clicks at all. */
  const c0 = applyEarnings(null, { type: 'click', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(c0.earned, 0, 'clicks need impressions (25% of 0 = 0)');
  pass('applyEarnings enforces clicks ≤25% of monthly impressions');
}

{
  /* allowClicks: false → click recorded but never paid. */
  let st = applyEarnings(null, { type: 'impression', campaignId: 'no_clicks', minutes: 30 }, FEED, T1).ledger;
  const c = applyEarnings(st, { type: 'click', campaignId: 'no_clicks' }, FEED, T1);
  assert.equal(c.earned, 0, 'campaign with allowClicks:false pays 0');
  assert.ok(/allow/.test(c.note), 'note says the campaign disallows clicks');
  pass('applyEarnings honors campaign allowClicks=false');
}

/* ------------------------------------------------------------------------
   5. applyEarnings — purity, totals, structural errors
   ------------------------------------------------------------------------ */
{
  const input = {
    total: 1, today: { date: '2026-09-06', total: 0.5 },
    monthly: { month: '2026-09', total: 0.5, impressions: 4 },
    rows: [], counters: { impressions: 4, clicks: 0, todayClicks: { date: '2026-09-06', count: 0 } }
  };
  const snapshot = JSON.stringify(input);
  applyEarnings(input, { type: 'click', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(JSON.stringify(input), snapshot, 'input ledger never mutated');
  pass('applyEarnings is pure (input ledger untouched)');
}

{
  assert.throws(() => { throw new Error('unused'); }, Error); // sanity: assert works
  const badType = applyEarnings(null, { type: 'hover', campaignId: 'camp_1' }, FEED, T1);
  assert.ok(badType.error, 'non-whitelisted type rejected');
  const noCamp = applyEarnings(null, { type: 'click' }, FEED, T1);
  assert.ok(noCamp.error, 'missing campaignId rejected');
  pass('applyEarnings rejects bad type / missing campaignId');
}

/* ------------------------------------------------------------------------
   6. pickRoute
   ------------------------------------------------------------------------ */
{
  assert.equal(pickRoute('GET', '/health').route, 'health');
  assert.equal(pickRoute('GET', '/feed.json').route, 'feed');
  assert.equal(pickRoute('POST', '/track').route, 'track');
  assert.equal(pickRoute('POST', '/admin/feed').route, 'adminFeed');
  const e = pickRoute('GET', '/earnings/abcd1234-abcd-abcd-abcd-abcd1234abcd');
  assert.equal(e.route, 'earnings');
  assert.equal(e.deviceId, 'abcd1234-abcd-abcd-abcd-abcd1234abcd');
  assert.equal(pickRoute('OPTIONS', '/track').route, 'preflight');
  assert.equal(pickRoute('OPTIONS', '/admin/feed').route, 'preflight');
  assert.equal(pickRoute('GET', '/earnings/').handled, false, 'empty deviceId not routed');
  assert.equal(pickRoute('PUT', '/track').handled, false, 'wrong method not routed');
  assert.equal(pickRoute('GET', '/nope').handled, false);
  pass('pickRoute maps all five routes + preflight, rejects the rest');
}

/* ------------------------------------------------------------------------
   7. ledgerView — serve shape (2-decimal money, last 50 rows)
   ------------------------------------------------------------------------ */
{
  let st = null;
  for (let i = 0; i < 60; i++) {
    st = applyEarnings(st, { type: 'impression', campaignId: 'camp_1', minutes: 1 }, FEED, T1).ledger;
  }
  const view = ledgerView(st);
  assert.equal(typeof view.total, 'number');
  assert.equal(view.total, Math.round(view.total * 100) / 100, 'total served at 2 decimals');
  assert.equal(view.rows.length, 50, 'rows sliced to the last 50');
  assert.ok(view.counters.impressions === 60);
  assert.ok(view.today.date === '2026-09-06');
  pass('ledgerView serves 2-decimal totals + last 50 rows');
}

console.log('ALL TESTS PASSED (' + n + ' groups)');
