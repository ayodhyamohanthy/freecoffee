/* ==========================================================================
   FreeCoffee backend — unit tests for the PURE worker helpers.
   No network, no KV, no Workers runtime: imports only the exported pure
   functions from src/worker.js and runs them with injected clocks.

   Run:  node freecoffee/backend/test.mjs   → exit 0 + PASS lines
   ========================================================================== */
import assert from 'node:assert/strict';
import { PILOT_STATES, newPilot, transitionPilot, confirmPilotRevenue,
  fundPromotionalPool, eligiblePilotView, proofGate, settlementGate } from './src/pilots.js';
import {
  validateCampaigns,
  applyEarnings,
  aggregateStats,
  pickRoute,
  ledgerView,
  getFeed,
  workerFetch,
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
  SLOT_BIDS_KEPT
} from './src/worker.js';

/* Fixed device ids (hex-only per DEVICE_ID_RE) used by the flywheel groups. */
const OWNER_DEV = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const REF_DEV = '11223344-5566-7788-99aa-bbccddeeff00';
const THIRD_DEV = 'cccc3333-3333-4333-8333-333333333333';
const DAY_MS = 86400000;

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
   2b. validateCampaigns — prototype ids + padded/overlong click URLs
   ------------------------------------------------------------------------ */
{
  const v = validateCampaigns([
    { id: '__proto__', sponsor: 'Proto Co', clickUrl: 'https://x.example/', cpm: 1 },
    { id: 'constructor', sponsor: 'Ctor Co', clickUrl: 'https://x.example/', cpm: 1 },
    { id: 'pad', sponsor: 'Pad Co', clickUrl: '  https://x.example/padded  ', cpm: 1 },
    { id: 'long', sponsor: 'Long Co', clickUrl: 'https://x.example/' + 'y'.repeat(600), cpm: 1 }
  ]);
  assert.equal(v.length, 4, 'prototype-named ids are kept, not swallowed');
  assert.equal(v[0].id, '__proto__', 'proto id survives dedupe map');
  assert.equal(v[2].clickUrl, 'https://x.example/padded', 'padded clickUrl trimmed, not dropped');
  assert.equal(v[3].clickUrl.length, 500, 'clickUrl capped at 500 chars');
  pass('validateCampaigns handles __proto__ ids; trims + caps click URLs');
}

/* ------------------------------------------------------------------------
   3. applyEarnings — impression award = 0.65 × cpm × minutes ÷ 1000
   ------------------------------------------------------------------------ */
{
  const r1 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 1 }, FEED, T1);
  assert.equal(r1.earned, 0.0042, '1 min @ $6 CPM → 0.70×6×1/1000 = $0.0042');
  assert.equal(r1.ledger.total, 0.0042);
  assert.equal(r1.ledger.counters.impressions, 1);
  assert.equal(r1.ledger.monthly.impressions, 1);
  assert.equal(r1.ledger.rows.length, 1);
  assert.equal(r1.ledger.rows[0].amount, 0.0042);
  assert.equal(r1.ledger.rows[0].campaignId, 'camp_1');

  const r10 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 10 }, FEED, T1);
  assert.equal(r10.earned, 0.042, '10 min @ $6 CPM → $0.042');

  const r60 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 90 }, FEED, T1);
  assert.equal(r60.earned, 0.252, 'minutes clamped 90→60 → $0.252');
  assert.equal(r60.ledger.counters.impressions, 60, 'clamped minutes counted');

  const r0 = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 'garbage' }, FEED, T1);
  assert.equal(r0.earned, 0, 'garbage minutes → 0 earned');
  assert.equal(r0.ledger.counters.impressions, 0);

  const rd = applyEarnings(null, { type: 'impression', campaignId: 'camp_1' }, FEED, T1);
  assert.equal(rd.earned, 0.0042, 'absent minutes defaults to 1');

  const rg = applyEarnings(null, { type: 'impression', campaignId: 'ghost', minutes: 5 }, FEED, T1);
  assert.equal(rg.earned, 0, 'unknown campaign pays 0');
  assert.ok(/unknown/.test(rg.note), 'note explains the zero');
  assert.equal(rg.ledger.counters.impressions, 0, 'unknown campaigns are not valid impressions');
  pass('applyEarnings awards 0.65×cpm×minutes/1000, clamps 0–60, defaults 1');
}

/* ------------------------------------------------------------------------
    3b. launch bonus, CPM floor, referral attribution lock
    ------------------------------------------------------------------------ */
{
  const r = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 60 }, FEED, T1, null, true);
  assert.equal(r.earned, 0.2772, '70% base + 10% of base launch bonus');
  assert.equal(r.baseEarned, 0.252);
  assert.equal(r.launchBonus, 0.0252);
  assert.equal(r.refereeBonus, 0);
  assert.equal(r.ledger.bonuses.launch, 0.0252);
  assert.equal(r.ledger.rows[0].amount, 0.252, 'campaign row keeps the base only');
  assert.equal(r.ledger.rows[1].type, 'launch');
  assert.equal(r.ledger.rows[1].campaignId, '', 'launch bonus is platform-side');
  assert.equal(aggregateStats([r.ledger], FEED).totals.spend, 0.25, 'launch bonus is not campaign spend');
  assert.equal(ledgerView(r.ledger).bonuses.launch, 0.03);

  const below = applyEarnings(null, { type: 'impression', campaignId: 'camp_low', minutes: 60 },
    [{ id: 'camp_low', sponsor: 'Low', cpm: 1.99 }], T1);
  assert.equal(below.earned, 0, 'cpm below the $2 floor pays nothing');
  assert.match(below.note, /floor/);
  const atFloor = applyEarnings(null, { type: 'impression', campaignId: 'camp_low', minutes: 1 },
    [{ id: 'camp_low', sponsor: 'Low', cpm: 2 }], T1);
  assert.ok(atFloor.earned > 0, 'cpm at the floor pays');

  const CODE = 'astra-1';
  const claimed = applyReferralClaim(null, CODE, T1);
  const after = applyReferralAccrual(claimed.record, 30, 0.126, T1 + 3600000);
  assert.equal(applyReferralClaim(after.binding, 'other-code', T1 + 7200000).claimed, false,
    'a binding with a first valid impression never re-binds');
  assert.equal(after.binding.firstValidImpressionAt, T1 + 3600000);
  const unlocked = applyReferralClaim(null, CODE, T1);
  assert.equal(applyReferralClaim(unlocked.record, CODE, T1 + 1000, true).record.clickedAt, T1 + 1000,
    'a click refreshes last-valid-click before any impression');

  pass('launch bonus, CPM floor, referral attribution lock');
}

/* ------------------------------------------------------------------------
   4. applyEarnings — click: $0.05, 5/day cap, ≤25% of monthly impressions
   ------------------------------------------------------------------------ */
{
  /* 40 impressions leave monthly allowance for testing the daily reset. */
  let st = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 40 }, FEED, T1).ledger;
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

  /* Next day: daily counter resets; unused monthly allowance permits a click. */
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

/* Monthly paid-click allowance must survive midnight and retained-row loss. */
{
  const click = { type: 'click', campaignId: 'camp_1' };
  const impression = { type: 'impression', campaignId: 'camp_1', minutes: 4 };
  let st = applyEarnings(null, impression, FEED, T1).ledger;
  st = applyEarnings(st, click, FEED, T1).ledger;
  assert.equal(st.monthly.paidClicks, 1);
  st.rows = []; // historical rows are bounded; the counter must remain authoritative
  const nextDay = applyEarnings(st, click, FEED, T2);
  assert.equal(nextDay.earned, 0, 'midnight cannot renew the monthly allowance');
  assert.match(nextDay.note, /monthly/);
  assert.equal(nextDay.ledger.monthly.paidClicks, 1, 'unpaid attempts do not consume paid allowance');
  const more = applyEarnings(nextDay.ledger, impression, FEED, T2).ledger;
  const paid = applyEarnings(more, click, FEED, T2);
  assert.equal(paid.earned, 0.05, 'additional impressions unlock another monthly click');
  assert.equal(paid.ledger.monthly.paidClicks, 2);

  const nextMonth = Date.UTC(2026, 9, 1, 12);
  const rolled = applyEarnings(paid.ledger, impression, FEED, nextMonth).ledger;
  assert.equal(rolled.monthly.paidClicks, 0);
  assert.equal(applyEarnings(rolled, click, FEED, nextMonth).earned, 0.05);
  const referralRolled = applyReferralCredit(paid.ledger, 0.01, nextMonth);
  assert.equal(referralRolled.monthly.paidClicks, 0, 'referral-led rollover also resets the count');

  const legacy = JSON.parse(JSON.stringify(st));
  delete legacy.monthly.paidClicks;
  const migrated = applyEarnings(legacy, click, FEED, T2);
  assert.equal(migrated.earned, 0, 'legacy lifetime reports conservatively preserve used allowance');
  assert.equal(migrated.ledger.monthly.paidClicks, 1);
  assert.equal(legacy.monthly.paidClicks, undefined, 'migration remains pure');
  pass('monthly paid clicks survive day rollover, reset monthly, and migrate legacy ledgers');
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
  assert.equal(pickRoute('GET', '/stats').route, 'stats');
  assert.equal(pickRoute('POST', '/track').route, 'track');
  assert.equal(pickRoute('POST', '/admin/feed').route, 'adminFeed');
  const e = pickRoute('GET', '/earnings/abcd1234-abcd-abcd-abcd-abcd1234abcd');
  assert.equal(e.route, 'earnings');
  assert.equal(e.deviceId, 'abcd1234-abcd-abcd-abcd-abcd1234abcd');
  assert.equal(pickRoute('POST', '/referral').route, 'referral');
  const r = pickRoute('GET', '/referrals/astra-1');
  assert.equal(r.route, 'referrals');
  assert.equal(r.code, 'astra-1');
  assert.equal(pickRoute('GET', '/referrals/').handled, false, 'empty code not routed');
  assert.equal(pickRoute('POST', '/referrals/astra-1').handled, false, 'wrong method not routed');
  assert.equal(pickRoute('OPTIONS', '/track').route, 'preflight');
  assert.equal(pickRoute('OPTIONS', '/admin/feed').route, 'preflight');
  assert.equal(pickRoute('GET', '/earnings/').handled, false, 'empty deviceId not routed');
  assert.equal(pickRoute('PUT', '/track').handled, false, 'wrong method not routed');
  assert.equal(pickRoute('GET', '/nope').handled, false);
  pass('pickRoute maps all seven routes + preflight, rejects the rest');
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

/* ------------------------------------------------------------------------
   8. getFeed — an admin-cleared feed ([] in KV) is honored, not overridden
      by the adapter. The adapter only writes KV when it has ≥1 valid
      campaign, so [] in KV can only come from POST /admin/feed with [].
   ------------------------------------------------------------------------ */
{
  const kv = (value) => ({ get: async () => value, put: async () => {} });

  const cleared = await getFeed({ SITE_KV: kv('[]') });
  assert.equal(cleared.source, 'kv', 'admin-cleared feed stays kv-sourced');
  assert.deepEqual(cleared.campaigns, [], 'no campaigns served');

  const full = await getFeed({ SITE_KV: kv(JSON.stringify(FEED)) });
  assert.equal(full.source, 'kv', 'populated KV feed served');
  assert.equal(full.campaigns.length, 2, 'both campaigns validated through');

  const garbage = await getFeed({ SITE_KV: kv('not json at all') });
  assert.equal(garbage.source, 'empty', 'unparseable KV falls through to empty');
  assert.deepEqual(garbage.campaigns, []);

  const absent = await getFeed({ SITE_KV: { get: async () => null, put: async () => {} } });
  assert.equal(absent.source, 'empty', 'missing KV value falls through to empty');

  pass('getFeed honors an admin-cleared feed; unparseable/absent KV → empty');
}

/* ------------------------------------------------------------------------
   9. GET /stats — public aggregate delivery report: per-campaign minutes,
      reported clicks, user-share spend; no device data; honest zeros.
   ------------------------------------------------------------------------ */
{
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = String(v); },
    list: async ({ prefix, limit, cursor }) => {
      const names = Object.keys(store).filter((k) => k.indexOf(prefix) === 0);
      const start = cursor ? Number(cursor) || 0 : 0;
      const slice = names.slice(start, start + (limit || 100));
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: start + slice.length >= names.length,
        cursor: String(start + slice.length)
      };
    }
  };
  const env = { SITE_KV: kv };
  const feed = [{ id: 'c1', sponsor: 'S1', clickUrl: 'https://x.example/', cpm: 10 }];

  let l1 = applyEarnings(null, { type: 'impression', campaignId: 'c1', minutes: 60 }, feed, T1).ledger;
  l1 = applyEarnings(l1, { type: 'click', campaignId: 'c1' }, feed, T1).ledger;
  const l2 = applyEarnings(null, { type: 'impression', campaignId: 'c1', minutes: 30 }, feed, T1).ledger;
  await kv.put('earn:dev1', JSON.stringify(l1));
  await kv.put('earn:dev2', JSON.stringify(l2));
  await kv.put('feed:current', JSON.stringify(feed));

  const res = await workerFetch(new Request('https://x.test/stats'), env, {});
  assert.equal(res.status, 200, 'GET /stats is public (no auth)');
  const body = await res.json();
  assert.equal(body.served, 1, 'served feed size reported');
  assert.equal(body.totals.impressions, 90, '60 + 30 verified minutes');
  assert.equal(body.totals.clicks, 1, 'one reported click');
  assert.equal(body.totals.spend, 0.68, 'spend = 0.42 + 0.05 + 0.21');
  assert.equal(body.totals.earners, 2, 'two devices earned');
  assert.equal(body.campaigns.length, 1, 'one campaign row');
  assert.equal(body.campaigns[0].sponsor, 'S1', 'sponsor joined from the served feed');
  assert.ok(JSON.stringify(body).indexOf('dev1') === -1, 'no device ids leak');

  // Proto-named campaign ids aggregate without polluting the rollup.
  const proto = aggregateStats(
    [{ rows: [{ t: T1, type: 'impression', campaignId: '__proto__', amount: 0.01, minutes: 5 }] }],
    []);
  assert.equal(proto.campaigns.length, 1, '__proto__ aggregates as data');
  assert.equal(proto.campaigns[0].impressions, 5);
  assert.equal({}.polluted, undefined, 'Object.prototype untouched');

  // No KV at all → honest zeros, still 200.
  const bare = await workerFetch(new Request('https://x.test/stats'), {}, {});
  assert.equal(bare.status, 200);
  assert.deepEqual((await bare.json()).totals,
    { impressions: 0, clicks: 0, spend: 0, earners: 0, hours: 0, devices: 0 });

  // Wrong method → 404 like every other unknown route.
  const bad = await workerFetch(new Request('https://x.test/stats', { method: 'POST' }), env, {});
  assert.equal(bad.status, 404);

  pass('GET /stats aggregates delivery publicly; zeros when empty; POST → 404');
}

/* ------------------------------------------------------------------------
   10. referral lifecycle — the gate HOLDS 10%, releases it retroactively the
       moment 60 verified minutes land inside the first 30 days, and voids a
       late or term-expired referral. Pure: bindings are never mutated.
   ------------------------------------------------------------------------ */
{
  const CODE = 'astra-1';
  const BASE30 = 0.126;

  assert.equal(normalizeRefCode(' Astra-1 '), 'astra-1', 'codes normalize + lowercase');
  assert.equal(normalizeRefCode('!!'), '', 'garbage code rejected');
  assert.equal(normalizeRefCode('ab'), '', 'too-short code rejected');

  const reg = applyReferralRegister(null, OWNER_DEV, CODE, T1);
  assert.equal(reg.created, true, 'owner registers their share code');
  assert.deepEqual(reg.record, { code: CODE, deviceId: OWNER_DEV, t: T1 });

  const taken = applyReferralRegister(reg.record, THIRD_DEV, CODE, T1 + 1000);
  assert.equal(taken.created, false, 'a registered code is never re-pointable');
  assert.match(String(taken.note), /already registered to another device/);
  assert.ok(applyReferralRegister(null, 'not-a-device', CODE, T1).error, 'bad deviceId rejected');
  assert.ok(applyReferralClaim(null, 'UPPER!!', T1).error, 'invalid code rejected on claim');

  const claim = applyReferralClaim(null, CODE, T1);
  assert.equal(claim.claimed, true, 'referee binds to the code');
  assert.equal(claim.record.gated, false);
  const rebound = applyReferralClaim(claim.record, 'someone-else', T1 + 9);
  assert.equal(rebound.claimed, true);
  assert.equal(rebound.record.code, 'someone-else');
  assert.equal(rebound.record.clickedAt, T1 + 9);
  assert.equal(applyReferralClaim(claim.record, CODE, T1 + 9).claimed, false);
  assert.equal(applyReferralClaim(claim.record, CODE, T1 + 9, true).record.clickedAt, T1 + 9);

  const h1 = applyReferralAccrual(claim.record, 30, BASE30, T1 + 3600000);
  assert.equal(h1.credit, 0.0063);
  assert.equal(h1.refereeCredit, 0.0063);
  assert.equal(h1.binding.pending, 0);
  assert.equal(h1.binding.firstValidImpressionAt, T1 + 3600000);
  assert.equal(applyReferralClaim(h1.binding, 'someone-else', T1 + 7200000).claimed, false);

  const h2 = applyReferralAccrual(h1.binding, 30, BASE30, T1 + 7200000);
  assert.equal(h2.binding.gated, true);
  assert.equal(h2.credit, 0.0063);
  assert.equal(h2.binding.paid, 0.0126);
  assert.equal(h2.binding.refereePaid, 0.0126);

  const end = h1.binding.firstValidImpressionAt + 30 * DAY_MS;
  assert.equal(applyReferralAccrual(h2.binding, 30, BASE30, end - 1).credit, 0.0063);
  const dead = applyReferralAccrual(h2.binding, 30, BASE30, end);
  assert.equal(dead.credit, 0);
  assert.equal(dead.refereeCredit, 0);
  assert.equal(dead.binding.void, true);

  const late = applyReferralAccrual(claim.record, 30, BASE30, T1 + 14 * DAY_MS);
  assert.equal(late.credit, 0);
  assert.equal(late.binding.void, true);
  assert.match(late.note, /attribution expired/);
  assert.equal(applyReferralAccrual(claim.record, 30, BASE30, T1 + 14 * DAY_MS - 1).credit, 0.0063);
  assert.equal(applyReferralAccrual(claim.record, 0, 0, T1).binding.firstValidImpressionAt, null);
  assert.equal(applyReferralAccrual(claim.record, 1, 0, T1).credit, 0);

  const snapshot = JSON.stringify(claim.record);
  applyReferralAccrual(claim.record, 60, BASE30, T1);
  assert.equal(JSON.stringify(claim.record), snapshot, 'input binding never mutated');

  assert.equal(refereeView(null), null, 'no binding → no referee block');
  const rv = refereeView(h2.binding, T1 + 3600000);
  assert.equal(rv.refereeOf, 'astra-1');
  assert.equal(rv.gate, 'passed');
  assert.equal(rv.gateMinutes, 0);
  assert.equal(refereeView(claim.record, T1 + 3600000).gate, 'pending');

  pass('referral: gate holds 10%, releases retroactively, voids late/expired');
}

/* ------------------------------------------------------------------------
   11. the referrer's credit lands in the referrer's OWN ledger — and never
       inside a campaign's delivery numbers.
   ------------------------------------------------------------------------ */
{
  const credit = applyReferralCredit(null, 0.0234, T1);
  assert.ok(Math.abs(credit.total - 0.0234) < 1e-9, 'credit joins the referrer total');
  assert.ok(Math.abs(credit.referral.total - 0.0234) < 1e-9, 'and the referral accumulator');
  assert.equal(credit.rows.length, 1);
  assert.equal(credit.rows[0].type, 'referral');
  assert.equal(credit.rows[0].campaignId, '', 'no campaign id — platform-side money');
  assert.equal(credit.rows[0].minutes, 0, 'a referral is not delivery');

  const zero = applyReferralCredit(credit, 0, T1);
  assert.equal(zero.rows.length, 1, 'a zero credit adds no row');
  assert.ok(Math.abs(zero.total - 0.0234) < 1e-9);

  const agg = aggregateStats([credit], [{ id: 'camp_1', sponsor: 'S', cpm: 6 }]);
  assert.equal(agg.totals.spend, 0, 'referral cost is not campaign spend');
  assert.equal(agg.campaigns.length, 0, 'no campaign row invented for a referral');
  assert.equal(agg.referralSpend, 0.02, 'published separately as platform-side cost');
  assert.equal(agg.totals.earners, 1, 'a referrer still counts as an earner');
  assert.equal(ledgerView(credit).referral.total, 0.02, 'ledgerView exposes the referral total');

  const view = referralView('astra-1', [
    { code: 'astra-1', t0: T1, minutes: 74, windowMinutes: 74, pending: 0, paid: 0.0224, gated: true },
    { code: 'astra-1', t0: T1, minutes: 41, windowMinutes: 41, pending: 0.0058, paid: 0, gated: false },
    { code: 'astra-1', t0: T1, minutes: 12, windowMinutes: 12, pending: 0, paid: 0, gated: false, void: true }
  ], credit);
  assert.equal(view.totals.referees, 3);
  assert.equal(view.totals.gated, 1);
  assert.equal(view.totals.minutes, 127);
  assert.equal(view.totals.accrued, 0.02, 'released only');
  assert.equal(view.totals.held, 0.01, 'gated credit is reported as held, never paid');
  assert.deepEqual(view.referees.map((r) => r.label), ['referee 1', 'referee 2', 'referee 3']);
  assert.deepEqual(view.referees.map((r) => r.gate), ['passed', 'pending', 'void']);
  assert.equal(view.ledgerTotal, 0.02);

  const snapshot = JSON.stringify(credit);
  applyReferralCredit(credit, 1, T1);
  assert.equal(JSON.stringify(credit), snapshot, 'input ledger never mutated');

  pass('referral credit is platform-side: separate accumulator, never campaign spend');
}

/* ------------------------------------------------------------------------
   12. platform attribution — where the verified minutes actually happened.
   ------------------------------------------------------------------------ */
{
  assert.equal(normalizePlatform('MAC'), 'mac', 'case-normalized');
  assert.equal(normalizePlatform('  pwa '), 'pwa', 'trimmed');
  assert.equal(normalizePlatform('x'.repeat(40)), 'unknown', 'over-long → unknown, never dropped');
  assert.equal(normalizePlatform(''), 'unknown');
  assert.equal(normalizePlatform(undefined), 'unknown');
  assert.equal(normalizePlatform('../etc/passwd'), 'unknown', 'no path junk becomes a key');
  assert.equal(normalizePlatform('agent'), 'agent');

  const unknown = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 1 }, FEED, T1);
  assert.equal(unknown.platform, 'unknown', 'a report without a platform is counted as unknown');

  let l = applyEarnings(null, { type: 'impression', campaignId: 'camp_1', minutes: 5, platform: 'mac' }, FEED, T1).ledger;
  l = applyEarnings(l, { type: 'impression', campaignId: 'camp_1', minutes: 5, platform: 'pwa' }, FEED, T1).ledger;
  l = applyEarnings(l, { type: 'click', campaignId: 'camp_1', platform: 'mac' }, FEED, T1).ledger;
  const ps = platformsOf(l.counters);
  assert.deepEqual(ps.map((p) => p.platform), ['mac', 'pwa'], 'sorted by minutes, then name');
  assert.equal(ps[0].minutes, 5);
  assert.equal(ps[0].clicks, 1, 'clicks are attributed to their platform too');
  assert.equal(ps[1].minutes, 5);
  assert.deepEqual(ledgerView(l).platforms, ps, 'ledgerView serves the same mix');

  // Keys are bounded: beyond PLATFORM_MAX distinct keys everything folds into
  // 'other', so a hostile client cannot grow a ledger key-by-key.
  const counters = { platforms: {} };
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
    bumpPlatform(counters, key, 1, 0);
  }
  assert.equal(Object.keys(counters.platforms).length, 12, 'twelve distinct keys tracked');
  assert.equal(bumpPlatform(counters, 'zzz', 1, 0), 'other', 'the 13th folds into other');
  assert.equal(bumpPlatform(counters, 'a', 1, 0), 'a', 'existing keys keep counting');

  pass('platform attribution: normalized, sorted, bounded, never affects money');
}

/* ------------------------------------------------------------------------
   13. the loop end-to-end over HTTP: register → claim → 60 verified minutes
       (attributed to a platform) → the referrer is paid → the public views
       show the mix without leaking a single device id.
   ------------------------------------------------------------------------ */
{
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = String(v); },
    list: async ({ prefix, limit, cursor }) => {
      const names = Object.keys(store).filter((k) => k.indexOf(prefix) === 0);
      const start = cursor ? Number(cursor) || 0 : 0;
      const slice = names.slice(start, start + (limit || 100));
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: start + slice.length >= names.length,
        cursor: String(start + slice.length)
      };
    }
  };
  const env = { SITE_KV: kv };
  await kv.put('feed:current', JSON.stringify([{ id: 'camp_1', sponsor: 'S1', clickUrl: 'https://x.example/', cpm: 6 }]));

  const post = (path, body) => workerFetch(new Request('https://x.test' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), env, {});
  const get = (path) => workerFetch(new Request('https://x.test' + path), env, {});

  let j = await (await post('/referral', { deviceId: OWNER_DEV, code: 'astra-1', action: 'register' })).json();
  assert.equal(j.created, true, 'owner registers the share code');
  j = await (await post('/referral', { deviceId: THIRD_DEV, code: 'astra-1', action: 'register' })).json();
  assert.equal(j.created, false, 'a second registration never re-points the code');

  j = await (await post('/referral', { deviceId: REF_DEV, code: 'astra-1' })).json();
  assert.equal(j.claimed, true, 'referee claims the code');
  j = await (await post('/referral', { deviceId: REF_DEV, code: 'astra-1' })).json();
  assert.equal(j.claimed, false, 'a second claim is refused');
  j = await (await post('/referral', { deviceId: OWNER_DEV, code: 'astra-1' })).json();
  assert.equal(j.claimed, false, 'self-referral refused');
  assert.match(String(j.note), /self-referral/);
  j = await (await post('/referral', { deviceId: THIRD_DEV, code: 'nobody-here' })).json();
  assert.equal(j.claimed, false, 'unknown code');
  assert.match(String(j.note), /unknown referral code/);
  assert.equal((await post('/referral', { deviceId: 'x', code: 'astra-1' })).status, 400, 'bad deviceId → 400');
  assert.equal((await post('/referral', { deviceId: OWNER_DEV, code: '!!' })).status, 400, 'bad code → 400');

  // One 60-minute placement batch: the referee earns the full 65%, the gate
  // passes, and the referrer's held 10% is released in the same call.
  const tr = await post('/track', {
    deviceId: REF_DEV, type: 'impression', campaignId: 'camp_1', minutes: 60, platform: 'mac'
  });
  assert.equal(tr.status, 200);
  const trBody = await tr.json();
  assert.equal(trBody.platform, 'mac', 'the report says which platform it came from');
  assert.equal(trBody.earned, 0.26, '70% base plus 5% of base referee bonus');
  assert.deepEqual(trBody.breakdown, { base: 0.252, launch: 0, referee: 0.0126 });
  assert.equal(trBody.referral.referrer, 'astra-1');
  assert.equal(trBody.referral.credited, true);
  assert.equal(trBody.referral.released, 0.01);

  const own = await (await get('/earnings/' + OWNER_DEV)).json();
  assert.equal(own.total, 0.01, 'referral credit lands in the referrer ledger');
  assert.equal(own.referral.total, 0.01);
  assert.equal(own.rows[0].type, 'referral');
  assert.deepEqual(own.platforms, [], 'a referrer without placements has no platform mix');

  const mine = await (await get('/earnings/' + REF_DEV)).json();
  assert.equal(mine.referee.refereeOf, 'astra-1', 'referee sees its own gate status');
  assert.equal(mine.referee.gate, 'passed');
  assert.equal(mine.referee.minutes, 60);
  assert.equal(mine.platforms.length, 1);
  assert.equal(mine.platforms[0].platform, 'mac');
  assert.equal(mine.platforms[0].minutes, 60);

  const view = await (await get('/referrals/astra-1')).json();
  assert.equal(view.registered, true);
  assert.equal(view.totals.referees, 1);
  assert.equal(view.totals.gated, 1);
  assert.equal(view.totals.accrued, 0.01);
  assert.equal(view.referees[0].label, 'referee 1');
  const viewText = JSON.stringify(view);
  assert.ok(viewText.indexOf(REF_DEV) === -1, 'no referee device id leaks');
  assert.ok(viewText.indexOf(OWNER_DEV) === -1, 'no owner device id leaks');
  assert.equal((await get('/referrals/nope%21%21')).status, 400, 'junk code → 400');

  // /stats publishes the flywheel mix — and keeps referral cost out of spend.
  const stats = await (await get('/stats')).json();
  assert.equal(stats.totals.impressions, 60, 'referee delivery only — a referral is not delivery');
  assert.equal(stats.totals.spend, 0.25, 'campaign spend excludes platform-funded bonuses');
  assert.equal(stats.totals.earners, 2, 'referee + referrer both have ledgers');
  assert.equal(stats.referralSpend, 0.01, 'referrer cost published separately');
  assert.deepEqual(stats.platforms, [{ platform: 'mac', minutes: 60, clicks: 0 }]);

  pass('loop end-to-end: claim → gate → referrer paid → public mix, no ids leaked');
}

/* ------------------------------------------------------------------------
   18. Open submission: anyone posts ONE campaign → pending-review queue →
       admin approve/reject. Spam controls: id+sponsor required, https
       destination required, $1 CPM floor, no duplicate ids, 5/day per IP,
       queue capped at 50, feed capped at 20.
   ------------------------------------------------------------------------ */
{
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = String(v); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' })
  };
  const env = { SITE_KV: kv, ADMIN_TOKEN: 'test-token' };
  const post = (path, body, headers) => workerFetch(new Request('https://x.test' + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body)
  }), env, {});
  const authed = { Authorization: 'Bearer test-token' };
  const good = (id, cpm) => ({
    id, sponsor: 'Sponsor ' + id, tagline: 'Real test ad',
    clickUrl: 'https://ads.example/' + id, cpm: cpm === undefined ? 6 : cpm
  });

  let r = await post('/submit', good('sub1'));
  assert.equal(r.status, 200, 'valid submit accepted');
  assert.deepEqual(await r.json().then((b) => [b.status, b.id]), ['pending-review', 'sub1']);

  assert.equal((await post('/submit', { id: 'x' })).status, 400, 'missing sponsor rejected');
  assert.equal((await post('/submit', { id: 'x', sponsor: 'S', clickUrl: 'http://nope.example/' })).status, 400, 'http destination rejected');
  assert.equal((await post('/submit', good('cheap', 0.5))).status, 400, 'sub-$1 bid rejected');
  assert.equal((await post('/submit', [good('arr')])).status, 400, 'array body rejected');
  assert.equal((await post('/submit', good('sub1'))).status, 409, 'duplicate id rejected');

  // Rate limit: 5/day per IP, 6th refused (distinct IP per submitter).
  for (let i = 2; i <= 6; i++) {
    const rr = await post('/submit', good('rl' + i), { 'cf-connecting-ip': '9.9.9.9' });
    assert.equal(rr.status, 200, 'submit ' + i + '/5 for one IP accepted');
  }
  assert.equal((await post('/submit', good('rl7'), { 'cf-connecting-ip': '9.9.9.9' })).status, 429, '6th submit in a day refused');

  // Admin gates.
  const noAuth = await workerFetch(new Request('https://x.test/admin/queue'), env, {});
  assert.equal(noAuth.status, 401, 'queue needs the token');
  const q = await (await workerFetch(new Request('https://x.test/admin/queue', { headers: authed }), env, {})).json();
  assert.ok(q.campaigns.some((c) => c.id === 'sub1'), 'sub1 waits in the queue');
  const badReview = await post('/admin/review', { id: 'sub1', approve: true });
  assert.equal(badReview.status, 401, 'review needs the token');

  // Approve → live in /feed.json; reject → gone.
  assert.equal((await post('/admin/review', { id: 'sub1', approve: true }, authed)).status, 200, 'approve ok');
  const feed = await (await workerFetch(new Request('https://x.test/feed.json'), env, {})).json();
  assert.ok(feed.campaigns.some((c) => c.id === 'sub1'), 'approved campaign serves');
  assert.equal((await post('/admin/review', { id: 'nope', approve: true }, authed)).status, 404, 'unknown id → 404');
  await post('/submit', good('subrej'), authed);
  assert.equal((await post('/admin/review', { id: 'subrej', approve: false }, authed)).status, 200, 'reject ok');
  const q2 = await (await workerFetch(new Request('https://x.test/admin/queue', { headers: authed }), env, {})).json();
  assert.ok(!q2.campaigns.some((c) => c.id === 'subrej'), 'rejected campaign leaves the queue');

  // Feed full (20) → approve refuses with 409, queue keeps the entry.
  const full = [];
  for (let i = 0; i < 20; i++) full.push(good('fill' + i));
  assert.equal((await post('/admin/feed', full, authed)).status, 200, 'feed filled to 20');
  await post('/submit', good('toofull'), authed);
  assert.equal((await post('/admin/review', { id: 'toofull', approve: true }, authed)).status, 409, 'approve into a full feed refused');
  const afterFull = await (await workerFetch(new Request('https://x.test/admin/queue', { headers: authed }), env, {})).json();
  assert.ok(afterFull.campaigns.some((c) => c.id === 'toofull'), 'queue entry survives a full-feed refusal');

  // Queue full (50) → submit refused with 429.
  const fifty = [];
  for (let i = 0; i < 50; i++) fifty.push(good('qfill' + i));
  await kv.put('queue:campaigns', JSON.stringify(fifty));
  const subFull = await post('/submit', good('one-more'), authed);
  assert.equal(subFull.status, 429, 'submit into a full queue refused');

  pass('open submission: validate → queue → approve/reject, floors, caps, auth');
}

/* ------------------------------------------------------------------------
   19. Slot ids — 4-hour blocks, UTC boundaries, invalid shapes rejected
   ------------------------------------------------------------------------ */
{
  assert.equal(SLOT_BLOCK_HOURS, 4);
  assert.equal(SLOT_BLOCKS_PER_DAY, 6);

  const t = Date.UTC(2026, 8, 16, 9, 30, 0);      // 09:30 UTC → block 2 (08–12)
  assert.equal(slotIdOf(t), '2026-09-16#2');
  assert.equal(slotMonthOf(t), '2026-09');

  const p = parseSlotId('2026-09-16#2');
  assert.equal(p.startsAt, Date.UTC(2026, 8, 16, 8, 0, 0));
  assert.equal(p.endsAt, Date.UTC(2026, 8, 16, 12, 0, 0));
  assert.equal(p.month, '2026-09');
  assert.equal(p.date, '2026-09-16');
  assert.equal(p.block, 2);

  // Boundaries: 00:00 → block 0, 23:59 → block 5.
  assert.equal(slotIdOf(Date.UTC(2026, 8, 16, 0, 0, 0)), '2026-09-16#0');
  assert.equal(slotIdOf(Date.UTC(2026, 8, 16, 23, 59, 59)), '2026-09-16#5');
  assert.equal(slotIdOf(Date.UTC(2026, 8, 16, 4, 0, 0)), '2026-09-16#1');

  // Garbage is rejected, never silently coerced into a real slot.
  ['', 'nope', '2026-09-16', '2026-09-16#6', '2026-09-16#-1', '2026-09-16#2#3',
   '2026-13-01#0', '2026-02-31#0', '2026-00-10#0', null, 42, {}].forEach((bad) => {
    assert.equal(parseSlotId(bad), null, 'rejects ' + JSON.stringify(bad));
  });
  // The 31st of a 30-day month rolls over and must not become Oct 1.
  assert.equal(parseSlotId('2026-09-31#0'), null, 'rolled-over date rejected');
  assert.equal(parseSlotId('2026-02-29#0'), null, 'non-leap Feb 29 rejected');
  assert.ok(parseSlotId('2028-02-29#0'), 'leap-year Feb 29 accepted');

  pass('slot ids: 4h UTC blocks, boundaries exact, invalid shapes rejected');
}

/* ------------------------------------------------------------------------
   20. Auction — highest CPM wins, ties to the earlier bid, re-bid replaces
   ------------------------------------------------------------------------ */
{
  const bid = (id, cpm, ts) => ({ campaignId: id, sponsor: 'S ' + id, cpm, bidTs: ts });

  assert.equal(slotWinner([bid('a', 2, 1), bid('b', 6, 9), bid('c', 4, 5)]).campaignId, 'b');
  assert.equal(slotWinner([bid('late', 6, 500), bid('early', 6, 100)]).campaignId, 'early',
    'equal CPM → earliest bid takes it');
  assert.equal(slotWinner([]), null);
  assert.equal(slotWinner(null), null);
  assert.equal(slotWinner([null, undefined]), null, 'junk bids never throw');

  assert.deepEqual(
    sortBids([bid('x', 3, 5), bid('y', 9, 9), bid('z', 3, 1)]).map((b) => b.campaignId),
    ['y', 'z', 'x'], 'CPM desc, then earliest first');

  // Re-bidding REPLACES that campaign's bid on the slot rather than stacking.
  let list = placeBid([], bid('a', 2, 1));
  list = placeBid(list, bid('b', 5, 2));
  list = placeBid(list, bid('a', 7, 3));
  assert.equal(list.length, 2, 'a raise replaced the old bid, not appended');
  assert.equal(slotWinner(list).campaignId, 'a');
  assert.equal(slotWinner(list).cpm, 7);

  // Capped, and the cap keeps the BEST bids.
  let many = [];
  for (let i = 0; i < SLOT_BIDS_KEPT + 10; i++) many = placeBid(many, bid('c' + i, i + 1, i));
  assert.equal(many.length, SLOT_BIDS_KEPT);
  assert.equal(many[0].cpm, SLOT_BIDS_KEPT + 10, 'highest bid survives the cap');

  // normalizeBid: floor, required fields, clamps, default clock.
  assert.equal(normalizeBid({ id: 'a', sponsor: 'S', cpm: 0.5 }, 7), null, 'below $1 floor rejected');
  assert.equal(normalizeBid({ sponsor: 'S', cpm: 5 }, 7), null, 'no id rejected');
  assert.equal(normalizeBid(null, 7), null);
  assert.equal(normalizeBid({ id: 'a', sponsor: 'S', cpm: 150 }, 7).cpm, 100, 'cpm clamped to 100');
  assert.equal(normalizeBid({ id: 'a', sponsor: 'S', cpm: 5 }, 1234).bidTs, 1234,
    'missing bidTs defaults to the injected clock');

  pass('auction: highest CPM wins, ties earliest, re-bid replaces, capped at ' + SLOT_BIDS_KEPT);
}

/* ------------------------------------------------------------------------
   21. Month store + grid — dirty KV is contained, grid is complete
   ------------------------------------------------------------------------ */
{
  assert.deepEqual(normalizeMonthStore(null), {});
  assert.deepEqual(normalizeMonthStore('x'), {});
  assert.deepEqual(normalizeMonthStore([]), {});

  const dirty = normalizeMonthStore({
    '2026-09-16': {
      '2': [{ campaignId: 'a', sponsor: 'S', cpm: 6, bidTs: 1 }],
      '9': [{ campaignId: 'b', sponsor: 'S', cpm: 9, bidTs: 1 }]   // block out of range
    },
    'not-a-date': { '0': [{ campaignId: 'c', sponsor: 'S', cpm: 9, bidTs: 1 }] },
    '2026-09-17': 'garbage'
  });
  assert.deepEqual(Object.keys(dirty), ['2026-09-16'], 'bad dates and non-objects dropped');
  assert.deepEqual(Object.keys(dirty['2026-09-16']), ['2'], 'out-of-range block dropped');

  const store = { '2026-09-16': { 2: [{ campaignId: 'a', sponsor: 'Acme', cpm: 6, bidTs: 1 }] } };
  const g = slotGrid(store, '2026-09', Date.UTC(2026, 8, 16, 9, 0, 0));
  assert.equal(g.month, '2026-09');
  assert.equal(g.blockHours, 4);
  assert.equal(g.blocksPerDay, 6);
  assert.equal(g.timezone, 'UTC');
  assert.equal(g.slots.length, 30 * 6, 'every day × every block is offered');

  const byId = {};
  g.slots.forEach((s) => { byId[s.id] = s; });
  assert.equal(byId['2026-09-16#2'].state, 'active', 'the slot containing now is active');
  assert.equal(byId['2026-09-16#2'].topCpm, 6);
  assert.equal(byId['2026-09-16#2'].topSponsor, 'Acme');
  assert.equal(byId['2026-09-16#2'].bidCount, 1);
  assert.equal(byId['2026-09-16#0'].state, 'past');
  assert.equal(byId['2026-09-16#3'].state, 'open');
  assert.equal(byId['2026-09-17#0'].topCpm, null, 'untouched slot has no top bid');
  assert.equal(byId['2026-09-17#0'].bidCount, 0);

  assert.equal(slotGrid({}, '2026-13', 0), null, 'month 13 → null');
  assert.equal(slotGrid({}, 'nope', 0), null);
  assert.equal(slotGrid({}, '2026-02', 0).slots.length, 28 * 6, 'February is 28 days');
  assert.equal(slotGrid({}, '2028-02', 0).slots.length, 29 * 6, 'leap-year February is 29');

  pass('month store + grid: dirty KV contained, every day/block offered, month lengths exact');
}

/* ------------------------------------------------------------------------
   22. Slot auction over HTTP — bid, outbid, per-slot rejections, guards
   ------------------------------------------------------------------------ */
{
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = String(v); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' })
  };
  const env = { SITE_KV: kv };
  const post = (path, body) => workerFetch(new Request('https://x.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env, {});
  const camp = (id, cpm) => ({
    id, sponsor: 'Sponsor ' + id, tagline: 't',
    clickUrl: 'https://ads.example/' + id, cpm
  });

  const slot = slotIdOf(Date.now() + 3 * 86400000);   // comfortably bookable
  const month = slot.split('#')[0].slice(0, 7);

  let r = await post('/slots/bid', { campaign: camp('slotA', 6), slots: [slot], bidder: 'a@example.com' });
  assert.equal(r.status, 200, 'bid accepted');
  let b = await r.json();
  assert.equal(b.placed, 1);
  assert.equal(b.winning, 1, 'first bid holds the slot');
  assert.equal(b.slots[0].top, true);

  // A higher CPM takes the slot outright.
  b = await (await post('/slots/bid', { campaign: camp('slotB', 9), slots: [slot], bidder: 'b@example.com' })).json();
  assert.equal(b.winning, 1, 'the higher bid takes the slot');
  assert.equal(b.outbidOn, 0);

  const g = await (await workerFetch(new Request('https://x.test/slots?month=' + month), env, {})).json();
  const cell = g.slots.find((s) => s.id === slot);
  assert.equal(cell.topCampaignId, 'slotB');
  assert.equal(cell.topCpm, 9);
  assert.equal(cell.bidCount, 2, 'both bids are retained behind the winner');

  // Losing bidders are told they were outbid, and by how much.
  b = await (await post('/slots/bid', { campaign: camp('slotC', 4), slots: [slot], bidder: 'c@example.com' })).json();
  assert.equal(b.winning, 0);
  assert.equal(b.outbidOn, 1);
  assert.equal(b.slots[0].outbid, 9, 'reports the number to beat');

  // Multiple slots in one request — the whole point of the picker.
  const many = [slotIdOf(Date.now() + 4 * 86400000), slotIdOf(Date.now() + 5 * 86400000)];
  b = await (await post('/slots/bid', { campaign: camp('slotD', 7), slots: many, bidder: 'd@example.com' })).json();
  assert.equal(b.placed, 2, 'one request books several slots');
  assert.equal(b.winning, 2);

  // Rejections are reported per slot rather than swallowed.
  b = await (await post('/slots/bid', { campaign: camp('slotE', 5), slots: ['nonsense', slot], bidder: 'e@example.com' })).json();
  assert.equal(b.placed, 1, 'the valid slot still lands');
  assert.ok(b.rejected.some((x) => x.slot === 'nonsense'), 'the invalid slot is reported');

  // A slot that already started cannot be bought.
  const past = slotIdOf(Date.now() - 3 * 86400000);
  b = await (await post('/slots/bid', { campaign: camp('old', 5), slots: [past], bidder: 'o@example.com' })).json();
  assert.ok(b.rejected.some((x) => /already started/.test(x.reason)), 'past slot refused');

  // Guards.
  assert.equal((await post('/slots/bid', { campaign: camp('z', 5), slots: [], bidder: 'z@x.com' })).status, 400, 'no slots → 400');
  assert.equal((await post('/slots/bid', { campaign: camp('z', 5), slots: [slot] })).status, 400, 'no bidder → 400');
  assert.equal((await post('/slots/bid', { campaign: camp('z', 0.5), slots: [slot], bidder: 'z@x.com' })).status, 400, 'sub-$1 → 400');
  assert.equal((await post('/slots/bid', {
    campaign: { id: 'z', sponsor: 'S', clickUrl: 'http://nope.example/', cpm: 5 },
    slots: [slot], bidder: 'z@x.com'
  })).status, 400, 'http destination → 400');
  assert.equal((await post('/slots/bid', { campaign: camp('z', 5), slots: [slot], bidder: '' })).status, 400, 'blank bidder → 400');

  // Route surface.
  assert.equal((await workerFetch(new Request('https://x.test/slots?month=2026-13'), env, {})).status, 400, 'bad month → 400');
  assert.equal((await workerFetch(new Request('https://x.test/slots/current'), env, {})).status, 200);
  assert.equal((await workerFetch(new Request('https://x.test/slots/bid'), env, {})).status, 404, 'GET on bid → 404');

  pass('slot auction over HTTP: bid, outbid, multi-slot, per-slot rejections, guards');
}

/* ------------------------------------------------------------------------
   23. Winner takes all — an active slot suppresses the open feed, and the
       money follows the SERVING list, not the raw feed
   ------------------------------------------------------------------------ */
{
  const store = {};
  const kv = {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = String(v); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' })
  };
  const env = { SITE_KV: kv };
  const now = Date.now();
  const cur = slotIdOf(now);
  const p = parseSlotId(cur);

  const mkBid = (id, cpm, ts) => ({
    campaignId: id, sponsor: 'Sponsor ' + id, tagline: 't',
    clickUrl: 'https://ads.example/' + id, cpm, logoText: 'XX',
    accent: '#C98F4E', allowClicks: true, bidder: id + '@x.com', bidTs: ts
  });
  // Written directly: a bid can only be placed before its slot starts.
  const day = {};
  day[p.block] = [mkBid('win1', 8, 1), mkBid('lose1', 3, 2)];
  store['slots:' + p.month] = JSON.stringify({ [p.date]: day });
  // An open feed whose CPM is far higher — it must still be suppressed.
  store['feed:current'] = JSON.stringify([
    { id: 'open1', sponsor: 'Open Co', tagline: 'o', clickUrl: 'https://ads.example/o', cpm: 20 }
  ]);

  const feed = await (await workerFetch(new Request('https://x.test/feed.json'), env, {})).json();
  assert.equal(feed.campaigns.length, 1, 'winner takes the whole slot');
  assert.equal(feed.campaigns[0].id, 'win1');
  assert.equal(feed.slot.id, cur, 'the feed reports which slot is running');
  assert.equal(feed.slot.winner.id, 'win1');
  assert.equal(feed.slot.topCpm, 8);
  assert.equal(feed.openFeedCount, 1, 'the suppressed open feed is still counted honestly');

  const track = (campaignId, minutes) => workerFetch(new Request('https://x.test/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: OWNER_DEV, type: 'impression', campaignId, minutes,
      platform: 'mac', region: 'US'
    })
  }), env, {});

  // 60 min at $8 CPM × 65% = $0.342 → served at 2 decimals.
  const win = await (await track('win1', 60)).json();
  assert.equal(win.earned, 0.34, 'the slot winner is paid at its own CPM');

  // The suppressed campaign earns NOTHING while the slot runs.
  const sup = await (await track('open1', 60)).json();
  assert.equal(sup.earned, 0, 'a suppressed open-feed campaign cannot be paid during a slot');

  // With no slot winner the open auction serves as before.
  delete store['slots:' + p.month];
  const feed2 = await (await workerFetch(new Request('https://x.test/feed.json'), env, {})).json();
  assert.equal(feed2.campaigns.length, 1);
  assert.equal(feed2.campaigns[0].id, 'open1', 'open feed resumes once the slot is clear');
  assert.equal(feed2.slot.winner, null);

  pass('winner takes all: active slot suppresses the open feed, and pay follows the serving list');
}

/* ------------------------------------------------------------------------
   24. Delivery report — time, distinct devices, surfaces, regions
   ------------------------------------------------------------------------ */
{
  const mk = (devId, rows) => ({ deviceId: devId, rows });

  const agg = aggregateStats([
    mk('dev-a', [
      { t: 1, type: 'impression', campaignId: 'c1', amount: 0.1, minutes: 30, platform: 'mac', region: 'US' },
      { t: 2, type: 'impression', campaignId: 'c1', amount: 0.1, minutes: 30, platform: 'mac', region: 'US' },
      { t: 3, type: 'click', campaignId: 'c1', amount: 0.05, platform: 'mac', region: 'US' }
    ]),
    mk('dev-b', [
      { t: 4, type: 'impression', campaignId: 'c1', amount: 0.1, minutes: 60, platform: 'web', region: 'IN' },
      { t: 5, type: 'impression', campaignId: 'c2', amount: 0.2, minutes: 60, platform: 'pwa', region: 'DE' }
    ])
  ], [{ id: 'c1', sponsor: 'One' }, { id: 'c2', sponsor: 'Two' }]);

  const c1 = agg.campaigns.find((c) => c.id === 'c1');
  assert.equal(c1.impressions, 120, 'verified minutes summed');
  assert.equal(c1.hours, 2, 'and the same figure in hours');
  assert.equal(c1.devices, 2, 'two distinct devices reached');
  assert.equal(c1.clicks, 1);
  assert.equal(c1.sponsor, 'One', 'sponsor joined from the served feed');

  assert.deepEqual(c1.surfaces.map((s) => [s.surface, s.minutes]), [['mac', 60], ['web', 60]]);
  // Equal minutes → deterministic alphabetical tiebreak, so the order is stable.
  assert.deepEqual(c1.regions.map((r) => [r.region, r.minutes]), [['IN', 60], ['US', 60]]);
  assert.equal(c1.surfaces[0].share, 50, 'shares are a percentage of served time');
  assert.equal(c1.regions[0].share, 50);

  assert.equal(agg.campaigns.find((c) => c.id === 'c2').devices, 1);
  assert.equal(agg.totals.devices, 2, 'network reach counts each device once');
  assert.equal(agg.totals.hours, 3);
  assert.equal(agg.regions.length, 3, 'network-wide region mix');

  // A click with no served time must not inflate reach.
  const clickOnly = aggregateStats([mk('dev-c', [
    { t: 9, type: 'click', campaignId: 'c1', amount: 0.05, platform: 'mac', region: 'US' }
  ])], []);
  assert.equal(clickOnly.campaigns[0].impressions, 0);
  assert.equal(clickOnly.campaigns[0].devices, 0, 'a click alone is not a reached device');

  // Rows written before delivery reporting read as unknown, never crash.
  const legacy = aggregateStats([{ deviceId: 'dev-d', rows: [
    { t: 1, type: 'impression', campaignId: 'c1', amount: 0.1 }
  ] }], []);
  assert.equal(legacy.campaigns[0].regions[0].region, 'unknown');
  assert.equal(legacy.campaigns[0].surfaces[0].surface, 'unknown');

  // An unstamped ledger still counts as exactly one device, never zero or two.
  const unstamped = aggregateStats([{ rows: [
    { t: 1, type: 'impression', campaignId: 'c1', amount: 0.1, minutes: 5 }
  ] }], []);
  assert.equal(unstamped.campaigns[0].devices, 1);

  // Region is a 2-letter code or unknown — nothing else is ever stored.
  assert.equal(normalizeRegion('us'), 'US');
  assert.equal(normalizeRegion(' US '), 'US');
  assert.equal(normalizeRegion('USA'), 'unknown');
  assert.equal(normalizeRegion('<script>'), 'unknown');
  assert.equal(normalizeRegion(null), 'unknown');

  pass('delivery report: time, distinct devices, surfaces, regions — counts only, no ids');
}



/* ------------------------------------------------------------------------
   25. Founding-pilot lane: exact states and fail-closed progression
   ------------------------------------------------------------------------ */
{
  assert.deepEqual(PILOT_STATES, ['draft','submitted','in_review','changes_requested','rejected',
    'approved_not_funded','pilot_enabled','scheduled','eligible','delivering','paused','completed','stopped']);
  let made = newPilot({ id: 'pilot_one', sponsor: 'Sample sponsor', commercialMode: 'free' }, 1);
  assert.equal(made.record.state, 'draft');
  assert.equal(made.record.commercialMode, 'free');
  assert.equal(made.record.grossMediaRevenueCents, 0);
  assert.equal(made.record.viewerPoolAllocationCents, 0);
  assert.deepEqual(made.record.allocationEvents, []);
  let r = transitionPilot(made.record, 'submitted', {}, {}, 2); assert.equal(r.record.state, 'submitted');
  r = transitionPilot(r.record, 'in_review', {}, {}, 3); assert.equal(r.record.state, 'in_review');
  r = transitionPilot(r.record, 'approved_not_funded', {}, {}, 4); assert.equal(r.record.state, 'approved_not_funded');
  assert.equal(transitionPilot(r.record, 'pilot_enabled', {}, {}, 5).error, 'pilot enablement is disabled');
  assert.equal(transitionPilot(r.record, 'pilot_enabled', { PILOT_ENABLEMENT_ENABLED:'true' }, {}, 5).record.state,
    'pilot_enabled');
  pass('founding-pilot state machine stops at approved_not_funded while billing is disabled');
}

/* ------------------------------------------------------------------------
   26. Free/manual metadata never fakes funding or an allocation event
   ------------------------------------------------------------------------ */
{
  const free = newPilot({ id:'free_one', sponsor:'Fictional', commercialMode:'free' }, 1).record;
  assert.equal(confirmPilotRevenue({ ...free, state:'approved_not_funded' }, { grossMediaRevenueCents:1000 }, {}).error,
    'billing is disabled');
  assert.equal(free.grossMediaRevenueCents, 0);
  assert.equal(free.viewerPoolAllocationCents, 0);
  assert.deepEqual(free.allocationEvents, []);
  assert.equal(fundPromotionalPool(free, { promotionalPoolCents:500 }, {}).error, 'promotional pool funding is disabled');
  pass('commercial mode is metadata; free pilots create no revenue or viewer-pool allocation');
}

/* ------------------------------------------------------------------------
   27. Explicit funding flags preserve revenue and promotional-pool boundaries
   ------------------------------------------------------------------------ */
{
  const base = { ...newPilot({ id:'paid_one', sponsor:'Reviewed' }, 1).record, state:'approved_not_funded' };
  const paid = confirmPilotRevenue(base, { grossMediaRevenueCents:1001 }, { BILLING_ENABLED:'true' }, 2).record;
  assert.equal(paid.viewerPoolAllocationCents, 700);
  assert.equal(paid.allocationEvents.length, 1);
  const promo = fundPromotionalPool(base, { promotionalPoolCents:777 }, { PROMOTIONAL_POOL_ENABLED:'true' }, 2).record;
  assert.equal(promo.promotionalPoolCents, 777);
  assert.equal(promo.grossMediaRevenueCents, 0);
  assert.equal(promo.viewerPoolAllocationCents, 0);
  assert.deepEqual(promo.allocationEvents, []);
  pass('confirmed gross revenue and separately funded promotional pools remain distinct');
}

/* ------------------------------------------------------------------------
   28. Eligibility, proof, settlement, and intake routes fail closed
   ------------------------------------------------------------------------ */
{
  const eligible = { ...newPilot({ id:'eligible_one', sponsor:'Reviewed', creativeKind:'reviewed_real' }, 1).record,
    state:'eligible' };
  assert.deepEqual(eligiblePilotView([eligible], {}).campaigns, []);
  assert.equal(eligiblePilotView([eligible], {}).enabled, false);
  assert.equal(eligiblePilotView([eligible], { PILOT_DELIVERY_ENABLED:'true' }).campaigns.length, 1);
  assert.equal(proofGate({}), false); assert.equal(settlementGate({}), false);
  assert.deepEqual(pickRoute('POST','/admin/pilots').route, 'adminPilotCreate');
  assert.deepEqual(pickRoute('GET','/campaigns/eligible').route, 'pilotEligibility');
  pass('pilot intake is admin-only and eligibility/proof/settlement flags default off');
}

/* ------------------------------------------------------------------------
   29. Worker integration: admin auth, intake flag, and eligibility boundary
   ------------------------------------------------------------------------ */
{
  const store = {};
  const kv = { async get(k){ return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; },
    async put(k,v){ store[k]=String(v); }, async list(){ return { keys:[], list_complete:true }; } };
  const env = { SITE_KV:kv, ADMIN_TOKEN:'secret', PILOT_ADMIN_INTAKE_ENABLED:'true' };
  let res = await workerFetch(new Request('https://x.test/admin/pilots', { method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({ id:'lane_one', sponsor:'Sample', commercialMode:'free' }) }), env, {});
  assert.equal(res.status, 401);
  res = await workerFetch(new Request('https://x.test/admin/pilots', { method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer secret'}, body:JSON.stringify({ id:'lane_one', sponsor:'Sample', commercialMode:'free' }) }), env, {});
  assert.equal(res.status, 201); assert.equal((await res.json()).campaign.state, 'draft');
  res = await workerFetch(new Request('https://x.test/campaigns/eligible'), env, {});
  const view = await res.json(); assert.equal(view.enabled,false); assert.deepEqual(view.campaigns,[]);
  pass('worker founding-pilot intake is admin-authenticated and cannot leak into Mac eligibility');
}

console.log('ALL TESTS PASSED (' + n + ' groups)');

