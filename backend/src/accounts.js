/* Accounts: sign in with a personal GitHub or Google account. No passwords and
   no email codes. We keep a provider id, a display name and an optional avatar
   URL. We do not store the provider's email address or any provider token.
   Sessions are random bearer tokens; only their SHA-256 is stored. */
const SITE = 'https://freecoffee.tech/account.html';
const STATE_TTL = 600;
const SESSION_TTL = 60 * 60 * 24 * 30;
const PROVIDERS = {
  github: {
    auth: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user',
    idKey: 'GITHUB_CLIENT_ID', secretKey: 'GITHUB_CLIENT_SECRET'
  },
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid profile',
    idKey: 'GOOGLE_CLIENT_ID', secretKey: 'GOOGLE_CLIENT_SECRET'
  }
};

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
const cleanName = v => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'FreeCoffee member';
const httpsUrl = v => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.href.slice(0, 300) : ''; } catch (e) { return ''; } };

export function providerConfigured(env, name) {
  const p = PROVIDERS[name];
  return !!(p && env && env[p.idKey] && env[p.secretKey] && env.SITE_KV);
}

export function pickAuthRoute(method, pathname) {
  var m = /^\/auth\/(github|google)\/(start|callback)$/.exec(pathname);
  if (method === 'GET' && m) return { route: 'auth' + m[2][0].toUpperCase() + m[2].slice(1), provider: m[1] };
  if (method === 'GET' && pathname === '/me') return { route: 'me' };
  if (method === 'GET' && pathname === '/me/bids') return { route: 'myBids' };
  if (method === 'POST' && pathname === '/me/link-code') return { route: 'linkCode' };
  if (method === 'POST' && pathname === '/link/redeem') return { route: 'linkRedeem' };
  if (method === 'GET' && pathname === '/me/link') return { route: 'myLink' };
  if (method === 'POST' && pathname === '/me/link/unlink') return { route: 'unlink' };
  if (method === 'POST' && pathname === '/auth/logout') return { route: 'logout' };
  return null;
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}
const back = (code) => redirect(SITE + '#error=' + code);

export async function authStart(request, env, name) {
  if (!providerConfigured(env, name)) return back('not_configured');
  const p = PROVIDERS[name];
  const state = rand(24);
  await env.SITE_KV.put('auth-state:' + state, name, { expirationTtl: STATE_TTL });
  const cb = new URL(request.url).origin + '/auth/' + name + '/callback';
  const q = new URLSearchParams({ client_id: env[p.idKey], redirect_uri: cb, state, scope: p.scope });
  if (name === 'google') q.set('response_type', 'code');
  return redirect(p.auth + '?' + q.toString());
}

async function fetchProfile(name, code, env, origin, doFetch) {
  const p = PROVIDERS[name];
  const cb = origin + '/auth/' + name + '/callback';
  const body = new URLSearchParams({ client_id: env[p.idKey], client_secret: env[p.secretKey], code, redirect_uri: cb });
  if (name === 'google') body.set('grant_type', 'authorization_code');
  const tr = await doFetch(p.token, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const tj = await tr.json();
  if (!tj || !tj.access_token) return null;
  const auth = { authorization: 'Bearer ' + tj.access_token, accept: 'application/json', 'user-agent': 'freecoffee' };
  if (name === 'github') {
    const r = await doFetch('https://api.github.com/user', { headers: auth });
    const u = await r.json();
    if (!u || !u.id) return null;
    return { sub: String(u.id), name: cleanName(u.name || u.login), avatar: httpsUrl(u.avatar_url) };
  }
  const r = await doFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: auth });
  const u = await r.json();
  if (!u || !u.sub) return null;
  return { sub: String(u.sub), name: cleanName(u.name), avatar: httpsUrl(u.picture) };
}

export async function authCallback(request, env, name, doFetch) {
  if (!providerConfigured(env, name)) return back('not_configured');
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!/^[a-f0-9]{48}$/.test(state) || !code || code.length > 2000) return back('bad_request');
  const stored = await env.SITE_KV.get('auth-state:' + state);
  if (stored !== name) return back('expired');
  await env.SITE_KV.delete('auth-state:' + state);
  let profile;
  try { profile = await fetchProfile(name, code, env, url.origin, doFetch); } catch (e) { return back('provider_failed'); }
  if (!profile) return back('provider_failed');
  const key = 'acct:' + name + ':' + profile.sub;
  let acct = null;
  try { acct = JSON.parse(await env.SITE_KV.get(key) || 'null'); } catch (e) { acct = null; }
  if (!acct || !acct.id) {
    acct = { id: crypto.randomUUID(), provider: name, createdAt: Date.now() };
  }
  acct.name = profile.name; acct.avatar = profile.avatar;
  await env.SITE_KV.put(key, JSON.stringify(acct));
  const token = rand(32);
  await env.SITE_KV.put('sess:' + await sha(token), JSON.stringify({ key, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
  return redirect(SITE + '#session=' + token);
}

export async function sessionAccount(request, env) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '');
  if (!m || !env || !env.SITE_KV) return null;
  const hash = await sha(m[1]);
  let s = null;
  try { s = JSON.parse(await env.SITE_KV.get('sess:' + hash) || 'null'); } catch (e) { return null; }
  if (!s || !s.key || s.exp < Date.now()) return null;
  let a = null;
  try { a = JSON.parse(await env.SITE_KV.get(s.key) || 'null'); } catch (e) { return null; }
  return a && a.id ? { account: a, hash } : null;
}

export async function me(request, env, json) {
  const s = await sessionAccount(request, env);
  if (!s) return json({ ok: false, error: 'sign in required' }, 401);
  const a = s.account;
  return json({ ok: true, account: { id: a.id, provider: a.provider, name: a.name, avatar: a.avatar || '', createdAt: a.createdAt } }, 200, { 'cache-control': 'no-store' });
}

export async function logout(request, env, json) {
  const s = await sessionAccount(request, env);
  if (s) await env.SITE_KV.delete('sess:' + s.hash);
  return json({ ok: true }, 200, { 'cache-control': 'no-store' });
}

export function authStatus(env) {
  return { github: providerConfigured(env, 'github'), google: providerConfigured(env, 'google') };
}

/* "Your bids": a short per-account list written after a bid is placed while
   signed in. It records what was true at the time of the bid, nothing more. */
const BIDS_MAX = 50;
export async function recordAccountBid(env, request, summary) {
  const s = await sessionAccount(request, env);
  if (!s) return false;
  const key = 'acctbids:' + s.account.id;
  let list = [];
  try { list = JSON.parse(await env.SITE_KV.get(key) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list.unshift({
    campaignId: String(summary.campaignId || '').slice(0, 40),
    sponsor: String(summary.sponsor || '').slice(0, 40),
    cpm: Number(summary.cpm) || 0,
    placed: Number(summary.placed) || 0,
    winningAtTime: Number(summary.winning) || 0,
    ts: Number(summary.ts) || Date.now()
  });
  await env.SITE_KV.put(key, JSON.stringify(list.slice(0, BIDS_MAX)));
  return true;
}

export async function myBids(request, env, json) {
  const s = await sessionAccount(request, env);
  if (!s) return json({ ok: false, error: 'sign in required' }, 401);
  let list = [];
  try { list = JSON.parse(await env.SITE_KV.get('acctbids:' + s.account.id) || '[]'); } catch (e) { list = []; }
  return json({ ok: true, bids: Array.isArray(list) ? list : [], note: 'Standing at the time each bid was placed. Highest bid per slot wins.' }, 200, { 'cache-control': 'no-store' });
}

/* Account-side Mac link. A signed-in user makes a one-time code; the Mac side
   redeems it and the account records one linked Mac (label only). This changes
   nothing about earning: no device is enrolled in the ledger and nothing is
   credited by linking. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_TTL = 600;
const REDEEM_PER_HOUR = 20;
function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return c.slice(0, 4) + '-' + c.slice(4);
}
const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function createLinkCode(request, env, json) {
  const s = await sessionAccount(request, env);
  if (!s) return json({ ok: false, error: 'sign in required' }, 401);
  const code = newCode();
  const exp = Date.now() + CODE_TTL * 1000;
  await env.SITE_KV.put('linkcode:' + await sha(normCode(code)), JSON.stringify({ accountId: s.account.id, exp }), { expirationTtl: CODE_TTL });
  return json({ ok: true, code, expiresAt: exp, note: 'One use. Expires in 10 minutes. Linking does not change what you earn.' }, 200, { 'cache-control': 'no-store' });
}

export async function redeemLinkCode(request, env, json, ip) {
  let body = null;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  const code = normCode(body && body.code);
  if (code.length !== 8) return json({ ok: false, error: 'invalid code' }, 400);
  const rk = 'linkrate:' + String(ip || 'x').slice(0, 64) + ':' + new Date().toISOString().slice(0, 13);
  const used = Number(await env.SITE_KV.get(rk)) || 0;
  if (used >= REDEEM_PER_HOUR) return json({ ok: false, error: 'too many attempts, try later' }, 429);
  await env.SITE_KV.put(rk, String(used + 1), { expirationTtl: 3700 });
  const ck = 'linkcode:' + await sha(code);
  let rec = null;
  try { rec = JSON.parse(await env.SITE_KV.get(ck) || 'null'); } catch (e) { rec = null; }
  if (!rec || !rec.accountId || rec.exp < Date.now()) return json({ ok: false, error: 'code not valid or expired' }, 400);
  const lk = 'acctlink:' + rec.accountId;
  if (await env.SITE_KV.get(lk)) return json({ ok: false, error: 'this account already has a linked Mac; unlink it first' }, 409);
  await env.SITE_KV.delete(ck);
  const label = cleanName(body.label || 'My Mac').slice(0, 40);
  const link = { linkId: crypto.randomUUID(), label, linkedAt: Date.now() };
  await env.SITE_KV.put(lk, JSON.stringify(link));
  return json({ ok: true, linked: true, label }, 200, { 'cache-control': 'no-store' });
}

export async function myLink(request, env, json) {
  const s = await sessionAccount(request, env);
  if (!s) return json({ ok: false, error: 'sign in required' }, 401);
  let link = null;
  try { link = JSON.parse(await env.SITE_KV.get('acctlink:' + s.account.id) || 'null'); } catch (e) { link = null; }
  return json({ ok: true, link: link ? { label: link.label, linkedAt: link.linkedAt } : null }, 200, { 'cache-control': 'no-store' });
}

export async function unlinkMac(request, env, json) {
  const s = await sessionAccount(request, env);
  if (!s) return json({ ok: false, error: 'sign in required' }, 401);
  await env.SITE_KV.delete('acctlink:' + s.account.id);
  return json({ ok: true }, 200, { 'cache-control': 'no-store' });
}
