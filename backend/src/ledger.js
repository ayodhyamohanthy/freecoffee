/* One global SQLite-backed Durable Object, using its transactional KV API.
   No KV money writes, no public bootstrap, no automatic empty initialization.
   Helpers are injected to keep the executable economics in worker.js. */
export function createLedgerAuthority(h) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const device = value => typeof value === 'string' && h.DEVICE_ID_RE.test(value);
  const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const optional = (value, key, check) => !Object.hasOwn(value, key) || check(value[key]);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const month = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  // Validate supported stored shapes without filling missing legacy fields.
  // paidClicks was added later: applyEarnings conservatively uses lifetime
  // clicks when absent. Missing optional data is NOT malformed present data.
  const validLedger = value => object(value) && money(value.total) &&
    object(value.today) && date(value.today.date) && money(value.today.total) &&
    object(value.monthly) && month(value.monthly.month) && money(value.monthly.total) &&
    count(value.monthly.impressions) && optional(value.monthly, 'paidClicks', count) &&
    object(value.counters) && count(value.counters.impressions) && count(value.counters.clicks) &&
    object(value.counters.todayClicks) && date(value.counters.todayClicks.date) && count(value.counters.todayClicks.count) &&
    optional(value.counters, 'platforms', platforms => object(platforms) && Object.values(platforms).every(p =>
      object(p) && count(p.minutes) && count(p.clicks))) &&
    optional(value, 'referral', referral => object(referral) && money(referral.total)) &&
    optional(value, 'bonuses', bonuses => object(bonuses) && money(bonuses.launch) && money(bonuses.referee)) &&
    optional(value, 'firstValidImpressionAt', timestamp => timestamp === null || money(timestamp)) &&
    Array.isArray(value.rows) && value.rows.every(row => object(row) && money(row.t) &&
      ['impression', 'click', 'referral', 'launch', 'referee'].includes(row.type) &&
      typeof row.campaignId === 'string' && money(row.amount) &&
      optional(row, 'minutes', count) && optional(row, 'platform', p => typeof p === 'string') &&
      optional(row, 'region', r => typeof r === 'string'));
  async function digest(token) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  function canonicalReport(body) {
    if (!object(body) || !device(body.deviceId) || !['impression', 'click'].includes(body.type) ||
        typeof body.campaignId !== 'string' || !body.campaignId.trim() || body.campaignId.length > 40 ||
        !Number.isInteger(body.minutes) || body.minutes < 0 || body.minutes > 60 ||
        (body.type === 'impression' ? body.minutes < 1 : body.minutes !== 0)) fail(400, 'invalid bounded event');
    return { deviceId: body.deviceId, type: body.type, campaignId: body.campaignId,
      minutes: body.minutes, platform: h.normalizePlatform(body.platform), region: h.normalizeRegion(body.region) };
  }
  async function parseBody(req, maximum = 16384) {
    // Stream limit, not just a trusted Content-Length header.
    const reader = req.body && req.body.getReader();
    if (!reader) fail(400, 'JSON body required');
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); fail(413, 'body too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'invalid JSON'); }
    if (!object(body)) fail(400, 'invalid body');
    return body;
  }
  return class LedgerAuthority {
    constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }

    async fetch(req) {
      try {
        const path = new URL(req.url).pathname;
        const admin = path.startsWith('/admin/ledger/');
        if (admin && (!this.env.ADMIN_TOKEN || !h.safeEqual(req.headers.get('authorization') || '', 'Bearer ' + this.env.ADMIN_TOKEN))) fail(401, 'unauthorized');
        if (req.method === 'POST' && path === '/admin/ledger/migrate') return await this.migrate(await parseBody(req));
        if (!(await this.storage.get('migration:v1'))) fail(503, 'ledger migration required');
        if (req.method === 'POST' && path === '/admin/ledger/enroll') return await this.enroll(await parseBody(req));
        if (req.method === 'POST' && path === '/admin/ledger/receipt') return await this.issue(await parseBody(req));
        if (req.method === 'GET' && path === '/stats') {
          const feed = await h.getFeed(this.env);
          return await this.storage.transaction(async tx => {
            const ledgers = await tx.list({ prefix: 'earn:', limit: 5001 });
            if (ledgers.size > 5000) fail(503, 'stats capacity exceeded');
            const rows = [];
            for (const [key, ledger] of ledgers) {
              if (!validLedger(ledger)) fail(503, 'stored ledger unavailable');
              rows.push({ ...ledger, deviceId: key.slice(5) });
            }
            return h.json({ ...h.aggregateStats(rows, feed.campaigns),
              verification: 'Historical client reports and administrator-authorized events; not independent ad-view proof' });
          });
        }
        // Hash outside transaction, then authenticate inside the same transaction
        // as every operation. Never trust an identity header from the caller.
        const auth = req.headers.get('authorization') || '';
        if (!/^Bearer [a-f0-9]{64}$/.test(auth)) fail(401, 'device credential required');
        const hash = await digest(auth.slice(7));
        let body = null;
        if (req.method === 'POST') body = await parseBody(req);
        return await this.storage.transaction(async tx => {
          if (path === '/stats' && req.method === 'GET') fail(404, 'not found');
          const id = path.startsWith('/earnings/') ? decodeURIComponent(path.slice(10)) : body && body.deviceId;
          if (path.startsWith('/referrals/')) {
            const code = h.normalizeRefCode(decodeURIComponent(path.slice(11)));
            if (!code) fail(400, 'invalid referral code');
            const owner = await tx.get('refcode:' + code);
            if (!owner) fail(404, 'unknown referral code');
            await this.authenticate(tx, owner.deviceId, hash);
            await this.ledger(tx, owner.deviceId);
            const ids = (await tx.get('refs:' + code)) || [];
            const bindings = [];
            for (const referee of ids) {
              const binding = await tx.get('ref:' + referee);
              if (binding && binding.code === code) bindings.push(binding);
            }
            return h.json({ ...h.referralView(code, bindings, await this.ledger(tx, owner.deviceId)), registered: true });
          }
          await this.authenticate(tx, id, hash);
          await this.ledger(tx, id); // validate even registration/early-return operations
          if (req.method === 'GET' && path.startsWith('/earnings/')) {
            return h.json(h.ledgerView(await this.ledger(tx, id), { now: Date.now(), referral: await tx.get('ref:' + id) }));
          }
          if (req.method === 'POST' && path === '/track') return await this.track(tx, body);
          if (req.method === 'POST' && path === '/referral') return await this.referral(tx, body);
          fail(404, 'not found');
        });
      } catch (error) {
        if (!error.status) console.error('ledger transaction unavailable');
        return h.json({ ok: false, error: error.status ? error.message : 'ledger unavailable' }, error.status || 503);
      }
    }

    async authenticate(tx, id, hash) {
      if (!device(id)) fail(400, 'invalid deviceId');
      const stored = await tx.get('auth:' + id);
      if (!stored || !h.safeEqual(stored, hash)) fail(401, 'unauthorized');
    }
    async ledger(tx, id) {
      const value = await tx.get('earn:' + id);
      if (!validLedger(value)) fail(503, 'stored ledger unavailable');
      return value;
    }

    async migrate(body) {
      if (body.confirm !== 'legacy writers stopped; snapshot reviewed' || this.env.LEGACY_LEDGER_FROZEN !== 'true') fail(503, 'legacy freeze confirmation required');
      if (!this.env.SITE_KV) fail(503, 'legacy storage unavailable');
      // Stage a complete snapshot before touching the authority. There is no
      // zero-on-error fallback and no destructive migration/reset endpoint.
      const records = new Map();
      for (const prefix of ['earn:', 'ref:', 'refcode:', 'refs:']) {
        let cursor;
        do {
          const page = await this.env.SITE_KV.list({ prefix, limit: 100, cursor });
          if (!page || !Array.isArray(page.keys) || (!page.list_complete && !page.cursor)) fail(503, 'incomplete legacy listing');
          for (const { name } of page.keys) {
            if (records.size >= 5000) fail(503, 'migration exceeds reviewed batch limit');
            const raw = await this.env.SITE_KV.get(name);
            if (typeof raw !== 'string') fail(503, 'legacy snapshot missing record');
            let value; try { value = JSON.parse(raw); } catch { fail(503, 'corrupt legacy snapshot'); }
            records.set(name, value);
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
      }
      const snapshotHash = await digest(JSON.stringify([...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
      if (body.recordCount !== records.size || body.snapshotSha256 !== snapshotHash) fail(409, 'snapshot differs from reviewed backup');
      const identities = new Set();
      for (const [key, value] of records) {
        const [prefix, id] = key.split(':');
        if (prefix === 'earn') {
          if (!device(id) || !validLedger(value)) fail(503, 'corrupt legacy ledger');
          identities.add(id);
        } else if (prefix === 'ref') {
          if (!device(id) || !object(value) || !h.normalizeRefCode(value.code)) fail(503, 'corrupt legacy referral');
          identities.add(id);
        } else if (prefix === 'refcode') {
          if (!h.normalizeRefCode(id) || !object(value) || value.code !== id || !device(value.deviceId)) fail(503, 'corrupt legacy owner');
          identities.add(value.deviceId);
        } else if (prefix === 'refs') {
          if (!h.normalizeRefCode(id) || !Array.isArray(value) || value.length > h.REFERRALS_MAX || !value.every(device)) fail(503, 'corrupt legacy index');
          value.forEach(id => identities.add(id));
        }
      }
      for (const [key, value] of records) {
        if (key.startsWith('ref:')) {
          const owner = records.get('refcode:' + value.code);
          if (!owner || owner.deviceId === key.slice(4)) fail(503, 'inconsistent legacy referral');
          const index = records.get('refs:' + value.code);
          if (!index || !index.includes(key.slice(4))) fail(503, 'incomplete legacy referral index');
        }
      }
      for (const id of identities) {
        if (!records.has('earn:' + id)) fail(503, 'referenced legacy identity missing ledger');
      }
      return await this.storage.transaction(async tx => {
        if (await tx.get('migration:v1')) fail(409, 'migration already completed');
        for (const [key, value] of records) await tx.put(key, value);
        await tx.put('migration:v1', { at: Date.now(), records: records.size, identities: identities.size, snapshotSha256: snapshotHash });
        return h.json({ ok: true, records: records.size, identities: identities.size });
      });
    }

    async enroll(body) {
      if (body.confirmOwnership !== true) fail(400, 'administrator must verify ownership out of band');
      const id = body.deviceId === undefined ? crypto.randomUUID() : body.deviceId;
      if (!device(id)) fail(400, 'invalid deviceId');
      const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      const hash = await digest(token);
      return await this.storage.transaction(async tx => {
        if (await tx.get('auth:' + id)) fail(409, 'already enrolled; recovery requires separate review');
        if (body.deviceId !== undefined) await this.ledger(tx, id); // existing IDs must have migrated balances
        else {
          if (await tx.get('earn:' + id)) fail(409, 'identity collision');
          await tx.put('earn:' + id, h.freshLedger(Date.now()));
        }
        await tx.put('auth:' + id, hash);
        return h.json({ ok: true, deviceId: id, token }, 201);
      });
    }

    async issue(body) {
      const report = canonicalReport(body);
      if (typeof body.eventId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.eventId)) fail(400, 'stable upstream eventId required');
      const feed = await h.getFeed(this.env);
      const served = await h.servingList(this.env, feed.campaigns);
      const campaign = served.campaigns.find(c => c.id === report.campaignId);
      if (!campaign || campaign.cpm < 2) fail(400, 'campaign not serving');
      const receiptId = crypto.randomUUID();
      const now = Date.now();
      return await this.storage.transaction(async tx => {
        if (!(await tx.get('auth:' + report.deviceId))) fail(403, 'device not enrolled');
        await this.ledger(tx, report.deviceId);
        const previous = await tx.get('event:' + body.eventId);
        const fingerprint = JSON.stringify(report);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail(409, 'eventId already bound to another report');
          return h.json({ ok: true, receiptId: previous.receiptId });
        }
        await tx.put('receipt:' + receiptId, { report, fingerprint, campaign, issuedAt: now, expiresAt: now + 300000,
          launch: this.env.LAUNCH_BONUS_ENABLED === 'true' });
        await tx.put('event:' + body.eventId, { receiptId, fingerprint });
        return h.json({ ok: true, receiptId }, 201);
      });
    }

    async track(tx, body) {
      if (Object.keys(body).some(key => !['deviceId', 'type', 'campaignId', 'minutes', 'platform', 'region', 'receiptId'].includes(key))) fail(400, 'unexpected tracking field');
      const report = canonicalReport(body);
      if (typeof body.receiptId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.receiptId)) fail(403, 'server receipt required');
      const key = 'receipt:' + body.receiptId;
      const receipt = await tx.get(key);
      if (!receipt) fail(403, 'unknown receipt');
      if (receipt.fingerprint !== JSON.stringify(report)) fail(409, 'receipt body mismatch');
      await this.ledger(tx, report.deviceId);
      if (receipt.result) return h.json(receipt.result); // deterministic retry, including after expiry
      const now = Date.now();
      if (now > receipt.expiresAt) fail(403, 'receipt expired');
      const ledger = await this.ledger(tx, report.deviceId);
      const binding = await tx.get('ref:' + report.deviceId);
      let owner;
      if (binding) {
        owner = await tx.get('refcode:' + binding.code);
        if (!owner || owner.deviceId === report.deviceId) fail(503, 'referral owner unavailable');
        await this.ledger(tx, owner.deviceId);
      }
      const result = h.applyEarnings(ledger, report, [receipt.campaign], now, binding, receipt.launch);
      if (result.error) fail(400, result.error);
      if (!validLedger(result.ledger)) fail(503, 'computed ledger unavailable');
      const response = { ok: true, earned: h.round2(result.earned), total: h.round2(result.ledger.total),
        platform: result.platform, breakdown: { base: result.baseEarned, launch: result.launchBonus, referee: result.refereeBonus } };
      if (result.note) response.note = result.note;
      // All writes and receipt consumption commit together or none do.
      await tx.put('earn:' + report.deviceId, result.ledger);
      if (binding && result.referrerBinding) await tx.put('ref:' + report.deviceId, result.referrerBinding);
      if (owner && result.referrerCredit > 0) {
        const credited = h.applyReferralCredit(await this.ledger(tx, owner.deviceId), result.referrerCredit, now);
        if (!validLedger(credited)) fail(503, 'computed ledger unavailable');
        await tx.put('earn:' + owner.deviceId, credited);
        response.referral = { referrer: binding.code, released: h.round2(result.referrerCredit), credited: true };
      }
      await tx.put(key, { ...receipt, result: response });
      return h.json(response);
    }

    async referral(tx, body) {
      const id = body.deviceId, code = h.normalizeRefCode(body.code);
      if (!code) fail(400, 'invalid referral code');
      if (!['register', 'claim', 'click'].includes(body.action)) fail(400, 'explicit referral action required');
      const now = Date.now();
      const owner = await tx.get('refcode:' + code);
      if (body.action === 'register') {
        const result = h.applyReferralRegister(owner, id, code, now);
        if (result.error) fail(400, result.error);
        if (result.created) await tx.put('refcode:' + code, result.record);
        return h.json({ ok: true, created: result.created, note: result.note || null, code });
      }
      if (!owner || owner.deviceId === id) return h.json({ ok: true, claimed: false, note: owner ? 'self-referral ignored' : 'unknown referral code' });
      await this.ledger(tx, owner.deviceId);
      const ledger = await this.ledger(tx, id);
      if (Number.isFinite(ledger.firstValidImpressionAt) || ledger.counters.impressions > 0) return h.json({ ok: true, claimed: false, note: 'attribution locked after first impression' });
      const prior = await tx.get('ref:' + id);
      const claim = h.applyReferralClaim(prior, code, now, body.action === 'click');
      if (claim.error) fail(400, claim.error);
      if (claim.claimed) {
        const index = (await tx.get('refs:' + code)) || [];
        if (!index.includes(id)) {
          if (index.length >= h.REFERRALS_MAX) fail(409, 'referral capacity reached');
          index.push(id);
        }
        if (prior && prior.code !== code) {
          const oldIndex = (await tx.get('refs:' + prior.code)) || [];
          await tx.put('refs:' + prior.code, oldIndex.filter(value => value !== id));
        }
        await tx.put('refs:' + code, index);
        await tx.put('ref:' + id, claim.record);
      }
      return h.json({ ok: true, claimed: claim.claimed, code, note: claim.note || null });
    }
  };
}
