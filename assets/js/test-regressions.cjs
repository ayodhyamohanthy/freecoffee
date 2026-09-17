'use strict';
// Dependency-free browser-state regressions: node assets/js/test-regressions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('./demo.js');
const dashboardSource = fs.readFileSync(path.join(__dirname, 'dashboard.js'), 'utf8');
const demoSource = fs.readFileSync(path.join(__dirname, 'demo.js'), 'utf8');

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
  const initial = { history: D.generateHistory(D.SEED), balanceOffset: 2, paidOut: [], profile: {} };
  const payout = dashboard(initial);
  payout.renderBalances();
  const lifetime = payout.nodes.get('statLifetime').textContent;
  payout.doPayout();
  assert.equal(payout.state.balanceOffset, 2, 'withdrawal must retain cumulative demo earnings');
  assert.equal(payout.nodes.get('statLifetime').textContent, lifetime, 'lifetime must not fall on payout');
  assert.equal(payout.nodes.get('statAvailable').textContent, '$0.00');
  payout.state.balanceOffset += 0.01;
  payout.renderBalances();
  assert.equal(payout.nodes.get('statAvailable').textContent, '$0.01', 'new earnings must become immediately available');
  const restored = dashboard(JSON.parse(payout.store.get('freecoffee:v1')));
  restored.renderBalances();
  assert.equal(restored.nodes.get('statAvailable').textContent, '$0.00', 'persisted withdrawal stays settled');
  assert.equal(restored.nodes.get('statLifetime').textContent, lifetime);

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
