'use strict';
// Dependency-free browser-state regressions: node tests/state-regressions.cjs
//
// This file used to live at assets/js/test-regressions.cjs, which is a
// PUBLISHED directory (sync-dist.sh copies assets/js wholesale), so it was one
// sync away from shipping a dev-only test harness to freecoffee.tech. Tests
// live under tests/ — see the published-surface guard in sync-dist.sh.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const D = require('../assets/js/demo.js');
const dashboardSource = fs.readFileSync(path.join(root, 'assets/js/dashboard.js'), 'utf8');
const demoSource = fs.readFileSync(path.join(root, 'assets/js/demo.js'), 'utf8');

function dashboard(initial, fetchLiveCampaigns) {
  const store = new Map([['freecoffee:v1', JSON.stringify(initial)]]);
  const nodes = new Map();
  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById(id) {
      if (['sponsorList', 'toastRegion'].includes(id)) return null;
      if (!nodes.has(id)) nodes.set(id, { style: {}, setAttribute() {} });
      return nodes.get(id);
    }
  };
  const window = {
    FreeCoffeeDemo: { ...D, initMenuBarDemo: () => null, fetchLiveCampaigns },
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key)
    }
  };
  // Expose the closure solely in the test VM; production keeps it private.
  const source = dashboardSource.replace('  function init() {',
    '  window.testAPI = { state: state, doPayout: doPayout, renderBalances: renderBalances, initLiveFeed: initLiveFeed, disconnectLiveFeed: disconnectLiveFeed };\n  function init() {');
  vm.runInNewContext(source, { window, document, Promise });
  return { ...window.testAPI, nodes, store };
}

async function main() {
  assert.equal(D.MODEL.BASE_SHARE, 0.70);
  assert.equal(D.MODEL.LAUNCH_BOOST, 0.10);
  assert.equal(100 * D.MODEL.REFERRAL_RATE, 5);
  assert.equal(100 * D.MODEL.REFERRED_RATE, 5);
  assert.equal(D.MODEL.REFERRAL_DAYS, 30);
  assert.equal(D.MODEL.REFERRAL_ATTRIBUTION_DAYS, 14);
  assert.equal(D.MODEL.PAYOUT_MINIMUM, 10);
  assert.equal(D.MODEL.PAYOUT_SETUP_GATE, 5);
  assert.equal(D.MODEL.PAYOUT_PENDING_DAYS, 5);
  const projection = D.projectMonthly({ minutes: 100, cpm: 6, launch: true, referred: true });
  assert.equal(projection.base, 12.60);
  assert.equal(projection.launchBonus, 1.80);
  assert.equal(projection.referredBonus, 0.63);
  assert.equal(projection.monthly, 15.03);
  assert.equal(projection.firstPayoutEtaDays, 25);
  const initial = { history: D.generateHistory(D.SEED), balanceOffset: 2, paidOut: [], profile: { payoutRail: 'stripe' } };
  const payout = dashboard(initial);
  payout.renderBalances();
  const lifetime = payout.nodes.get('statLifetime').textContent;
  payout.doPayout();
  assert.equal(payout.state.balanceOffset, 2, 'withdrawal must retain cumulative demo earnings');
  assert.equal(payout.nodes.get('statLifetime').textContent, lifetime, 'lifetime must not fall on payout');
  assert.equal(payout.nodes.get('statAvailable').textContent, '$0.00');
  payout.state.balanceOffset += 0.01;
  payout.renderBalances();
  assert.equal(payout.nodes.get('statAvailable').textContent, '$0.00', 'new earnings must stay pending');
  const restored = dashboard(JSON.parse(payout.store.get('freecoffee:v1')));
  restored.renderBalances();
  assert.equal(restored.nodes.get('statAvailable').textContent, '$0.00', 'persisted withdrawal stays settled');
  assert.equal(restored.nodes.get('statLifetime').textContent, lifetime);

  const history = D.generateHistory(D.SEED);
  assert.deepEqual(history, D.generateHistory(D.SEED));
  const rounded = n => Math.round(n * 100) / 100;
  const held = rounded(history.ledger.filter(row => row.ts > D.ANCHOR_TS - 5 * 86400000).reduce((sum, row) => sum + row.cut, 0));
  assert.equal(history.totals.pending, held);
  assert.equal(rounded(history.totals.available + held), history.totals.lifetime);
  for (const row of history.ledger) {
    if (row.type === 'impression') assert.equal(row.cut, rounded(row.count * row.bid * 0.70 / 1000));
    if (row.type === 'launch') assert.equal(row.cut, rounded(row.count * row.bid * 0.10 / 1000));
    if (row.type === 'referred' || row.type === 'referral') assert.equal(row.cut, rounded(row.bid * 0.05));
  }
  const partial = D.normalizeState({ profile: { payoutRail: 'whop' } });
  const before = D.demoBalances(partial);
  for (const amount of [0, -10, 9.99, NaN, Infinity, 10.001, before.available + 0.01]) {
    assert.ok(D.withdrawDemo(partial, amount).error);
  }
  assert.equal(partial.paidOut.length, 0);
  const result = D.withdrawDemo(partial, 10);
  assert.equal(result.payout.amount, 10);
  assert.equal(result.payout.rail, 'whop');
  assert.equal(D.demoBalances(partial).available, rounded(before.available - 10));
  assert.equal(D.demoBalances(partial).pending, before.pending);
  assert.ok(D.withdrawDemo(partial, 'max').error, 'remaining amount below minimum cannot be withdrawn');
  assert.ok(D.withdrawDemo(D.normalizeState({}), 'max').error, 'no rail blocks withdrawal');
  const boundary = D.normalizeState({ profile: { payoutRail: 'stripe' } });
  boundary.history.ledger = [
    { ts: D.ANCHOR_TS - 5 * 86400000, cut: 10 },
    { ts: D.ANCHOR_TS - 5 * 86400000 + 1, cut: 20 }
  ];
  assert.equal(D.demoBalances(boundary).available, 10);
  assert.equal(D.demoBalances(boundary).pending, 20);
  assert.equal(D.withdrawDemo(boundary, 'max').payout.amount, 10);
  boundary.history.ledger = [{ ts: D.ANCHOR_TS, cut: 4.99 }];
  assert.match(D.withdrawDemo(boundary, 'max').error, /\$5/);
  const migrated = D.normalizeState({ history: { model: { VERSION: 2 } }, paidOut: [{ amount: 10 }], profile: { displayName: 'Keep me' } });
  assert.equal(migrated.paidOut.length, 0);
  assert.equal(migrated.profile.displayName, 'Keep me');
  const now = new Date(2026, 8, 17, 10, 0).getTime();
  assert.equal(D.snoozeUntil('30m', now) - now, 1800000);
  assert.equal(D.snoozeUntil('2h', now) - now, 7200000);
  assert.equal(D.snoozeUntil('6h', now) - now, 21600000);
  assert.equal(D.snoozeUntil('restday', now), new Date(2026, 8, 18).getTime());
  assert.equal(D.snoozeUntil('bad', now), 0);

  const cached = { ...initial, profile: { adFeedUrl: 'https://example.org/feed.json' }, liveCampaigns: [{ id: 'old', sponsor: 'Old', cpm: 5 }] };
  const empty = dashboard(cached, () => Promise.resolve({ campaigns: [], error: null }));
  empty.initLiveFeed();
  await Promise.resolve();
  assert.equal(empty.state.liveCampaigns.length, 0, 'empty successful feed must clear cached campaigns');
  assert.equal(JSON.parse(empty.store.get('freecoffee:v1')).liveCampaigns.length, 0);

  let resolveFeed;
  const pending = dashboard(cached, () => new Promise(resolve => { resolveFeed = resolve; }));
  pending.initLiveFeed();
  pending.disconnectLiveFeed();
  resolveFeed({ campaigns: [{ id: 'late', sponsor: 'Late', cpm: 5 }], error: null });
  await Promise.resolve();
  assert.equal(pending.state.liveCampaigns.length, 0, 'late response must not restore disconnected feed');
  assert.equal(pending.state.profile.adFeedUrl, undefined);

  const blockedWindow = { location: { search: '?ref=friend' } };
  Object.defineProperty(blockedWindow, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const context = { window: blockedWindow, self: blockedWindow, URLSearchParams, URL };
  assert.doesNotThrow(() => vm.runInNewContext(demoSource, context), 'blocked storage must not abort engine boot');
  const blocked = blockedWindow.FreeCoffeeDemo;
  assert.equal(blocked.deviceId(), '');
  assert.equal(blocked.backendBase(), '');
  assert.equal(blocked.referralCode(), '');
  assert.equal(blocked.inboundRef(), null);
  assert.equal(blocked.captureInboundRef().code, 'friend');
  console.log('PASS JS regressions: payout accounting/persistence, empty/stale feed responses, blocked storage');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
