import assert from 'node:assert/strict';
import { workerFetch, slotIdOf } from './src/worker.js';

const store = new Map();
const kv = {
  get: async k => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => { store.set(k, String(v)); },
  delete: async k => { store.delete(k); },
  list: async () => ({ keys: [], list_complete: true })
};
const env = { SITE_KV: kv };
const call = (path, init, e = env) => workerFetch(new Request('https://api.test' + path, init), e, {});

// Not configured: nothing is faked.
let r = await call('/auth/github/start');
assert.equal(r.status, 302);
assert.match(r.headers.get('location'), /#error=not_configured$/);
assert.deepEqual((await (await call('/auth/status')).json()).providers, { github: false, google: false });

Object.assign(env, { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' });
assert.deepEqual((await (await call('/auth/status')).json()).providers, { github: true, google: true });

// Start redirects to the provider with a one-time state.
r = await call('/auth/github/start');
const loc = new URL(r.headers.get('location'));
assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
assert.equal(loc.searchParams.get('client_id'), 'gh-id');
assert.equal(loc.searchParams.get('redirect_uri'), 'https://api.test/auth/github/callback');
const state = loc.searchParams.get('state');
assert.match(state, /^[a-f0-9]{48}$/);

// Callbacks with a missing, forged or wrong-provider state are refused.
assert.match((await call('/auth/github/callback?code=x&state=' + 'a'.repeat(48))).headers.get('location'), /#error=expired$/);
assert.match((await call('/auth/github/callback?code=x')).headers.get('location'), /#error=bad_request$/);
assert.match((await call('/auth/google/callback?code=x&state=' + state)).headers.get('location'), /#error=expired$/);

// Provider fetches are mocked at the global level for this test only.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('github.com/login/oauth/access_token')) return Response.json({ access_token: 'tok' });
  if (u.includes('api.github.com/user')) return Response.json({ id: 4242, login: 'octo', name: 'Octo <b>Cat</b>', avatar_url: 'https://avatars.example/o.png', email: 'secret@example.com' });
  throw Error('unexpected fetch ' + u);
};
r = await call('/auth/github/callback?code=abc&state=' + state);
globalThis.fetch = realFetch;
const done = new URL(r.headers.get('location'));
assert.equal(done.origin + done.pathname, 'https://freecoffee.tech/account.html');
const token = /^#session=([a-f0-9]{64})$/.exec(done.hash)[1];
assert.ok(![...store.values()].some(v => v.includes('secret@example.com')), 'provider email never stored');
assert.ok(![...store.keys()].some(k => k.includes(token)), 'raw session token never stored');
// State is single use.
assert.match((await call('/auth/github/callback?code=abc&state=' + state)).headers.get('location'), /#error=expired$/);

// /me needs the bearer token.
assert.equal((await call('/me')).status, 401);
assert.equal((await call('/me', { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } })).status, 401);
const mine = await (await call('/me', { headers: { authorization: 'Bearer ' + token } })).json();
assert.equal(mine.account.provider, 'github');
assert.equal(mine.account.name, 'Octo bCat/b', 'markup characters stripped from display names');
assert.ok(!JSON.stringify(mine).includes('secret@example.com'));

// Same person signing in again keeps the same account id.
r = await call('/auth/github/start');
const st2 = new URL(r.headers.get('location')).searchParams.get('state');
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('access_token')) return Response.json({ access_token: 'tok2' });
  return Response.json({ id: 4242, login: 'octo', name: 'Octo', avatar_url: '' });
};
r = await call('/auth/github/callback?code=abc&state=' + st2);
globalThis.fetch = realFetch;
const token2 = /#session=([a-f0-9]{64})/.exec(r.headers.get('location'))[1];
const again = await (await call('/me', { headers: { authorization: 'Bearer ' + token2 } })).json();
assert.equal(again.account.id, mine.account.id, 'stable account id per provider identity');

// Bids placed while signed in appear under "your bids"; anonymous bids do not.
const slotX = slotIdOf(Date.now() + 3 * 86400000);
const campX = (id, cpm) => ({ id, sponsor: 'Sponsor ' + id, tagline: 't', clickUrl: 'https://ads.example/' + id, cpm });
const bid = (id, cpm, tk) => call('/slots/bid', { method: 'POST', headers: { 'content-type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify({ campaign: campX(id, cpm), slots: [slotX], bidder: 'x@example.com' }) });
assert.equal((await call('/me/bids')).status, 401);
assert.equal((await bid('anon1', 5)).status, 200);
assert.equal((await bid('mine1', 7, token2)).status, 200);
const bids = await (await call('/me/bids', { headers: { authorization: 'Bearer ' + token2 } })).json();
assert.equal(bids.bids.length, 1, 'only the signed-in bid is listed');
assert.equal(bids.bids[0].campaignId, 'mine1');
assert.equal(bids.bids[0].cpm, 7);
assert.equal(bids.bids[0].winningAtTime, 1);
// A second session of the same account sees the same list; a forged token sees nothing.
assert.equal((await (await call('/me/bids', { headers: { authorization: 'Bearer ' + token } })).json()).bids.length, 1);
assert.equal((await call('/me/bids', { headers: { authorization: 'Bearer ' + 'e'.repeat(64) } })).status, 401);

// Logout kills only that session.
assert.equal((await call('/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).status, 200);
assert.equal((await call('/me', { headers: { authorization: 'Bearer ' + token } })).status, 401);
assert.equal((await call('/me', { headers: { authorization: 'Bearer ' + token2 } })).status, 200);
console.log('PASS accounts: GitHub and Google sign-in flow, one-time state, hashed sessions, no email stored');
