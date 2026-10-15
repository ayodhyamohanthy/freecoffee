/* Explicit local-only integration gate. Uses the existing Wrangler dev tool;
   no account credentials or production APIs, all state in a temporary folder.
   Run from backend/: node runtime-smoke.mjs */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
const state = await mkdtemp(join(tmpdir(), 'freecoffee-ledger-'));
const port = randomInt(20000, 55000);
const child = spawn('npx', ['--yes', 'wrangler@3', 'dev', '--local', '--port', String(port), '--persist-to', state,
  '--var', 'ADMIN_TOKEN:local-test-only', '--var', 'LEGACY_LEDGER_FROZEN:true'], {
  cwd: new URL('.', import.meta.url), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
});
let output = '';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local Wrangler startup timed out\n' + output)), 60000);
    const read = chunk => { output += chunk.toString(); if (output.includes('Ready on')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(Error('Wrangler exit ' + code + '\n' + output)); });
  });
  const call = async (path, body, token) => {
    const response = await fetch('http://127.0.0.1:' + port + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let bodyValue;
    try { bodyValue = JSON.parse(text); }
    catch { throw Error('Non-JSON local runtime response for ' + path + ' (' + response.status + '): ' + text + '\n' + output); }
    return { status: response.status, body: bodyValue };
  };
  const admin = (path, body) => call('/admin/ledger/' + path, body, 'local-test-only');
  assert.equal((await call('/track', {})).status, 503);
  assert.equal((await admin('migrate', { confirm: 'legacy writers stopped; snapshot reviewed', recordCount: 0,
    snapshotSha256: createHash('sha256').update('[]').digest('hex') })).status, 200);
  const owner = (await admin('enroll', { confirmOwnership: true })).body;
  const viewer = (await admin('enroll', { confirmOwnership: true })).body;
  assert.ok(owner.token && viewer.token);
  assert.equal((await call('/admin/feed', [{id: 'camp_1', sponsor: 'Local', cpm: 6}], 'local-test-only')).status, 200);
  assert.equal((await call('/referral', {deviceId: owner.deviceId, code: 'local-code', action: 'register'}, owner.token)).status, 200);
  assert.equal((await call('/referral', {deviceId: viewer.deviceId, code: 'local-code', action: 'claim'}, viewer.token)).status, 200);
  const report = { deviceId: viewer.deviceId, type: 'impression', campaignId: 'camp_1', minutes: 60, platform: 'web', region: 'IN' };
  const receipt = await admin('receipt', {...report, eventId: 'local_upstream_event_00001'});
  assert.equal(receipt.status, 201);
  const events = await Promise.all(Array.from({length: 12}, () => call('/track', {...report, receiptId: receipt.body.receiptId}, viewer.token)));
  events.forEach(value => { assert.equal(value.status, 200); assert.deepEqual(value.body, events[0].body); });
  assert.equal(events[0].body.earned, 0.26);
  const earnings = await call('/earnings/' + viewer.deviceId, undefined, viewer.token);
  assert.equal(earnings.body.counters.impressions, 60);
  const referral = await call('/earnings/' + owner.deviceId, undefined, owner.token);
  assert.equal(referral.body.referral.total, 0.01);
  assert.equal((await call('/earnings/' + viewer.deviceId)).status, 401);
  assert.equal((await call('/stats')).body.totals.impressions, 60);
  console.log('PASS real local Workers/Durable Object migration, auth, referral transaction and concurrent replay');
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited during failed startup */ }
  await rm(state, {recursive: true, force: true});
}
