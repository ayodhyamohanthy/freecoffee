import assert from 'node:assert/strict';
import { LedgerAuthority, workerFetch, freshLedger } from './src/worker.js';

// Transactional, serialized test double with rollback/fault injection. Runtime
// storage semantics are also exercised by the separate Wrangler smoke test.
export function harness(initial = {}) {
  let data = new Map(Object.entries(structuredClone(initial))), tail = Promise.resolve();
  const storage = {
    failKey: null,
    async get(key) { return structuredClone(data.get(key)); },
    transaction(callback) {
      const work = tail.then(async () => {
        const staged = new Map(structuredClone([...data]));
        const result = await callback({
          get: async key => structuredClone(staged.get(key)),
          put: async (key, value) => { if (key === storage.failKey) throw Error('injected write failure'); staged.set(key, structuredClone(value)); },
          list: async ({prefix, limit}) => new Map([...staged].filter(([key]) => key.startsWith(prefix)).sort().slice(0, limit))
        });
        data = staged;
        return result;
      });
      tail = work.catch(() => {});
      return work;
    }
  };
  const legacy = new Map();
  const env = { ADMIN_TOKEN: 'test-admin-secret', LEGACY_LEDGER_FROZEN: 'true', SITE_KV: {
    get: async key => legacy.get(key) ?? null,
    list: async ({ prefix }) => ({ keys: [...legacy.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true })
  }};
  const instance = new LedgerAuthority({ storage }, env);
  env.LEDGER = { idFromName: name => name, get: () => ({ fetch: req => instance.fetch(req) }) };
  const request = (path, body, token) => workerFetch(new Request('https://test.invalid' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env, {});
  return { storage, legacy, env, request, admin: (path, body) => request('/admin/ledger/' + path, body, env.ADMIN_TOKEN) };
}
const H = harness();
const { request, admin, legacy, storage, env } = H;
const oldId = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const saved = freshLedger(Date.now()); saved.total = 123.4567;
legacy.set('earn:' + oldId, JSON.stringify(saved));
legacy.set('feed:current', JSON.stringify([{ id: 'camp_1', sponsor: 'Sponsor', cpm: 6 }]));
assert.equal((await request('/track', {})).status, 503);
assert.equal((await admin('enroll', { deviceId: oldId, confirmOwnership: true })).status, 503);
assert.equal((await request('/admin/ledger/migrate', {})).status, 401);
assert.equal((await admin('migrate', {})).status, 503);
legacy.set('earn:bbbbbbbb', '{bad');
const snapshot = JSON.stringify([['earn:' + oldId, saved]]);
const snapshotSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot))), b => b.toString(16).padStart(2, '0')).join('');
const migrateBody = { confirm: 'legacy writers stopped; snapshot reviewed', recordCount: 1, snapshotSha256 };
assert.equal((await admin('migrate', migrateBody)).status, 503);
assert.equal(await storage.get('migration:v1'), undefined);
legacy.delete('earn:bbbbbbbb');
assert.equal((await admin('migrate', migrateBody)).status, 200);
assert.deepEqual(await storage.get('earn:' + oldId), saved, 'exact legacy balance preserved');
assert.equal((await admin('migrate', migrateBody)).status, 409);
assert.equal((await admin('enroll', { deviceId: oldId })).status, 400);
assert.equal((await admin('enroll', { deviceId: 'bbbbbbbb', confirmOwnership: true })).status, 503, 'cannot claim arbitrary existing device');
const owner = await (await admin('enroll', { deviceId: oldId, confirmOwnership: true })).json();
const referee = await (await admin('enroll', { confirmOwnership: true })).json();
assert.ok(owner.token && referee.token);
assert.equal((await admin('enroll', { deviceId: oldId, confirmOwnership: true })).status, 409);
assert.equal((await request('/earnings/' + oldId)).status, 401);
assert.equal((await request('/earnings/' + oldId, undefined, referee.token)).status, 401);
assert.equal((await request('/earnings/' + oldId, undefined, owner.token)).status, 200);
assert.equal((await request('/referral', { deviceId: oldId, code: 'test-code', action: 'register' })).status, 401);
assert.equal((await request('/referral', { deviceId: oldId, code: 'test-code', action: 'register' }, owner.token)).status, 200);
assert.equal((await request('/referral', { deviceId: referee.deviceId, code: 'test-code', action: 'claim' }, referee.token)).status, 200);
const report = { deviceId: referee.deviceId, type: 'impression', campaignId: 'camp_1', minutes: 60, platform: 'web', region: 'IN' };
assert.equal((await request('/track', report, referee.token)).status, 403);
assert.equal((await admin('receipt', { ...report, minutes: 61, eventId: 'upstream_event_0001' })).status, 400);
const issue = async (eventId = 'upstream_event_0001', r = report) => admin('receipt', { ...r, eventId });
assert.equal((await request('/admin/ledger/receipt', { ...report, eventId: 'upstream_event_0001' }, referee.token)).status, 401);
const receipt = await (await issue()).json();
assert.ok(receipt.receiptId);
assert.equal((await (await issue()).json()).receiptId, receipt.receiptId, 'duplicate upstream event cannot mint another receipt');
assert.equal((await issue('upstream_event_0001', { ...report, minutes: 59 })).status, 409);
const body = { ...report, receiptId: receipt.receiptId };
assert.equal((await request('/track', { ...body, minutes: 59 }, referee.token)).status, 409);
assert.equal((await request('/track', { ...body, amount: 999 }, referee.token)).status, 400);
const before = await storage.get('earn:' + referee.deviceId);
storage.failKey = 'earn:' + oldId;
assert.equal((await request('/track', body, referee.token)).status, 503);
assert.deepEqual(await storage.get('earn:' + referee.deviceId), before, 'referee write rolled back when referrer write fails');
assert.equal((await storage.get('receipt:' + receipt.receiptId)).result, undefined, 'failed transaction does not consume receipt');
storage.failKey = 'receipt:' + receipt.receiptId;
assert.equal((await request('/track', body, referee.token)).status, 503);
assert.deepEqual(await storage.get('earn:' + referee.deviceId), before, 'receipt failure rolls back both balances');
storage.failKey = null;
await storage.transaction(async tx => { const r = await tx.get('receipt:' + receipt.receiptId); r.expiresAt = 0; await tx.put('receipt:' + receipt.receiptId, r); });
assert.equal((await request('/track', body, referee.token)).status, 403, 'unused expired receipt cannot earn');
await storage.transaction(async tx => { const r = await tx.get('receipt:' + receipt.receiptId); r.expiresAt = Date.now() + 300000; await tx.put('receipt:' + receipt.receiptId, r); });
const concurrent = await Promise.all(Array.from({length: 15}, () => request('/track', body, referee.token)));
const results = await Promise.all(concurrent.map(res => res.json()));
results.forEach(result => assert.deepEqual(result, results[0]));
assert.equal(results[0].earned, 0.26);
assert.equal((await storage.get('earn:' + referee.deviceId)).counters.impressions, 60, 'concurrent duplicate receipt earns once');
assert.equal((await storage.get('earn:' + oldId)).total, 123.4693, 'legacy balance plus exact referral credit');
assert.equal((await request('/referrals/test-code')).status, 401);
assert.equal((await request('/referrals/test-code', undefined, referee.token)).status, 401);
const privateView = await (await request('/referrals/test-code', undefined, owner.token)).json();
assert.equal(privateView.totals.referees, 1);
assert.ok(!JSON.stringify(privateView).includes(referee.deviceId));
const stats = await (await request('/stats')).json();
assert.equal(stats.totals.impressions, 60);
assert.match(stats.verification, /not independent/);
await storage.transaction(async tx => { const r = await tx.get('receipt:' + receipt.receiptId); r.expiresAt = 0; await tx.put('receipt:' + receipt.receiptId, r); });
assert.deepEqual(await (await request('/track', body, referee.token)).json(), results[0], 'committed receipt retry survives expiry');
assert.equal((await request('/track', {...body, receiptId: '00000000-0000-0000-0000-000000000000'}, referee.token)).status, 403);
assert.equal((await request('/track', {...body, deviceId: oldId}, referee.token)).status, 401);
assert.equal((await request('/track', {...body, extra: 'x'.repeat(17000)}, referee.token)).status, 413);
// Distinct events must not lose updates; each is explicitly authorized by admin.
const more = await Promise.all(Array.from({length: 10}, (_, i) => issue('upstream_next_000' + i, { ...report, minutes: 1 })));
const ids = await Promise.all(more.map(res => res.json()));
assert.ok(ids.every(value => value.receiptId));
await Promise.all(ids.map(value => request('/track', { ...report, minutes: 1, receiptId: value.receiptId }, referee.token)));
assert.equal((await storage.get('earn:' + referee.deviceId)).counters.impressions, 70);
const clicks = await Promise.all(Array.from({length: 10}, (_, i) => issue('upstream_click_000' + i, { ...report, type: 'click', minutes: 0 })));
const clickIds = await Promise.all(clicks.map(res => res.json()));
const clickResults = await Promise.all(clickIds.map(value => request('/track', { ...report, type: 'click', minutes: 0, receiptId: value.receiptId }, referee.token)));
const clickBodies = await Promise.all(clickResults.map(res => res.json()));
assert.equal(clickBodies.filter(value => value.earned > 0).length, 5, 'atomic daily cap under concurrent distinct click receipts');
// Corrupt authority records fail closed, never create a replacement ledger.
const corrupt = harness({ 'migration:v1': { at: 1 }, ['earn:' + oldId]: { total: '100' } });
assert.equal((await corrupt.admin('enroll', {deviceId: oldId, confirmOwnership: true})).status, 503);
const missing = await workerFetch(new Request('https://x.test/track', {method: 'POST', body: '{}'}), {}, {});
assert.equal(missing.status, 503);
console.log('PASS secure ledger migration, enrollment, body-bound receipts, concurrent replay, rollback and referral atomicity');
