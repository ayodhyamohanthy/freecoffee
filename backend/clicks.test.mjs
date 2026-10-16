import assert from 'node:assert/strict';
import { workerFetch } from './src/worker.js';
import { trackedUrl } from './src/clicks.js';

const store = new Map();
const kv = {
  get: async k => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => { store.set(k, String(v)); },
  delete: async k => { store.delete(k); },
  list: async () => ({ keys: [], list_complete: true })
};
const env = { SITE_KV: kv, ADMIN_TOKEN: 'adm' };
store.set('feed:current', JSON.stringify([
  { id: 'camp1', sponsor: 'S1', clickUrl: 'https://s1.example/landing?x=1', cpm: 5 },
  { id: 'noclick', sponsor: 'S2', clickUrl: 'https://s2.example/', cpm: 5, allowClicks: false },
  { id: 'cheap', sponsor: 'S3', clickUrl: 'https://s3.example/', cpm: 0.1 }
]));
const get = (path, ip, headers = {}) => workerFetch(new Request('https://api.test' + path, { headers: { 'cf-connecting-ip': ip || '1.1.1.1', ...headers } }), env, {});

const r = await get('/c/camp1');
assert.equal(r.status, 302);
const loc = new URL(r.headers.get('location'));
assert.equal(loc.origin + loc.pathname, 'https://s1.example/landing');
assert.equal(loc.searchParams.get('x'), '1', 'sponsor query kept');
assert.equal(loc.searchParams.get('utm_source'), 'freecoffee');
assert.equal(loc.searchParams.get('utm_campaign'), 'camp1');
// Never an open redirect: unknown, click-disabled and below-floor campaigns 404.
for (const id of ['unknown', 'noclick', 'cheap']) assert.equal((await get('/c/' + id)).status, 404, id);
assert.equal((await get('/c/..%2Fevil')).status, 404);
// Counted once per network per hour; a different network counts.
await get('/c/camp1'); await get('/c/camp1');
await get('/c/camp1', '2.2.2.2');
const adm = await (await get('/admin/clicks?campaign=camp1&days=1', '9.9.9.9', { authorization: 'Bearer adm' })).json();
assert.equal(adm.days[0].clicks, 2, 'two networks counted, repeats ignored');
assert.equal((await get('/admin/clicks?campaign=camp1')).status, 401);
assert.ok(![...store.keys()].some(k => k.includes('1.1.1.1')) && ![...store.values()].some(v => v.includes('1.1.1.1')), 'raw address never stored');
assert.ok(![...store.keys()].some(k => k.startsWith('earn:')), 'clicks credit nothing');
// Existing sponsor tracking parameters are not overwritten; http is refused.
assert.equal(new URL(trackedUrl('https://a.example/?utm_source=x', 'c')).searchParams.get('utm_source'), 'x');
assert.equal(trackedUrl('http://a.example/', 'c'), null);
console.log('PASS clicks: verified redirect, tracking parameters, per-network hourly dedupe, no open redirect, no earnings change');
