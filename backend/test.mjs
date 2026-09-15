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
  aggregateStats,
  pickRoute,
  ledgerView,
  getFeed,
  workerFetch,
  normalizeRefCode,
  normalizePlatform,
  bumpPlatform,
  platformsOf,
  applyReferralRegister,
  applyReferralClaim,
  applyReferralAccrual,
  applyReferralCredit,
  refereeView,
  referralView
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
  assert.ok(Math.abs(body.totals.spend - 0.635) < 0.011, 'spend ≈ 0.39 + 0.05 + 0.195');
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
  assert.deepEqual((await bare.json()).totals, { impressions: 0, clicks: 0, spend: 0, earners: 0 });

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
  const BASE30 = 0.117;            // 30 min @ $6 CPM × 65% = 0.117

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
  assert.equal(rebound.claimed, false, 'first claim wins — never re-bound');
  assert.match(String(rebound.note), /already bound to astra-1/);

  const h1 = applyReferralAccrual(claim.record, 30, BASE30, T1 + 3600000);
  assert.equal(h1.credit, 0, 'nothing is paid before the gate');
  assert.ok(Math.abs(h1.binding.pending - 0.0117) < 1e-9, '10% of base is held');
  assert.equal(h1.binding.gated, false);
  assert.match(String(h1.note), /gate pending/);

  const h2 = applyReferralAccrual(h1.binding, 30, BASE30, T1 + 7200000);
  assert.equal(h2.binding.gated, true, '60 verified minutes passes the gate');
  assert.ok(Math.abs(h2.credit - 0.0234) < 1e-9, 'held 0.0117 + new 0.0117 released at once');
  assert.equal(h2.binding.pending, 0, 'nothing left held');
  assert.equal(h2.note, 'gate passed — held credit released');

  const h3 = applyReferralAccrual(h2.binding, 10, 0.078, T1 + DAY_MS);
  assert.ok(Math.abs(h3.credit - 0.0078) < 1e-9, 'in-term credit is immediate');

  const dead = applyReferralAccrual(h3.binding, 60, BASE30, T1 + 366 * DAY_MS);
  assert.equal(dead.credit, 0, 'no credit past the 12-month term');
  assert.equal(dead.binding.void, true);
  assert.match(String(dead.note), /term ended/);

  const late = applyReferralAccrual(applyReferralClaim(null, CODE, T1).record, 40, BASE30, T1 + 31 * DAY_MS);
  assert.equal(late.credit, 0, 'late activation pays nothing');
  assert.equal(late.binding.void, true);
  assert.equal(late.binding.pending, 0, 'held credit is burned, never released');
  assert.match(String(late.note), /gate missed/);

  const snapshot = JSON.stringify(claim.record);
  applyReferralAccrual(claim.record, 60, BASE30, T1);
  assert.equal(JSON.stringify(claim.record), snapshot, 'input binding never mutated');

  assert.equal(refereeView(null), null, 'no binding → no referee block');
  const rv = refereeView(h2.binding, T1 + 3600000);
  assert.equal(rv.refereeOf, 'astra-1');
  assert.equal(rv.gate, 'passed');
  assert.equal(rv.gateMinutes, 60);
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
  assert.equal(trBody.earned, 0.23, 'referee keeps the full 65% share');
  assert.equal(trBody.referral.referrer, 'astra-1');
  assert.equal(trBody.referral.credited, true, 'referrer paid at the gate');
  assert.equal(trBody.referral.released, 0.02, '0.0234 served at 2 decimals');

  const own = await (await get('/earnings/' + OWNER_DEV)).json();
  assert.equal(own.total, 0.02, 'referral credit lands in the referrer ledger');
  assert.equal(own.referral.total, 0.02);
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
  assert.equal(view.totals.accrued, 0.02);
  assert.equal(view.referees[0].label, 'referee 1');
  const viewText = JSON.stringify(view);
  assert.ok(viewText.indexOf(REF_DEV) === -1, 'no referee device id leaks');
  assert.ok(viewText.indexOf(OWNER_DEV) === -1, 'no owner device id leaks');
  assert.equal((await get('/referrals/nope%21%21')).status, 400, 'junk code → 400');

  // /stats publishes the flywheel mix — and keeps referral cost out of spend.
  const stats = await (await get('/stats')).json();
  assert.equal(stats.totals.impressions, 60, 'referee delivery only — a referral is not delivery');
  assert.equal(stats.totals.spend, 0.23, 'campaign spend is the referee share alone');
  assert.equal(stats.totals.earners, 2, 'referee + referrer both have ledgers');
  assert.equal(stats.referralSpend, 0.02, 'referral cost published separately');
  assert.deepEqual(stats.platforms, [{ platform: 'mac', minutes: 60, clicks: 0 }]);

  pass('loop end-to-end: claim → gate → referrer paid → public mix, no ids leaked');
}

console.log('ALL TESTS PASSED (' + n + ' groups)');
