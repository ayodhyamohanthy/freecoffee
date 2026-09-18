/* Founding-pilot campaign lane.
   This module deliberately owns no delivery or billing integration. Records stay
   in KV and every state that implies funding, eligibility, delivery, proof, or
   settlement is gated by explicit server flags. Unset flags are false. */

const PILOT_STATES = Object.freeze([
  'draft', 'submitted', 'in_review', 'changes_requested', 'rejected',
  'approved_not_funded', 'pilot_enabled', 'scheduled', 'eligible',
  'delivering', 'paused', 'completed', 'stopped'
]);

const PILOT_TRANSITIONS = Object.freeze({
  draft: ['submitted'],
  submitted: ['in_review'],
  in_review: ['changes_requested', 'rejected', 'approved_not_funded'],
  changes_requested: ['submitted'],
  rejected: [],
  approved_not_funded: ['pilot_enabled'],
  pilot_enabled: ['scheduled', 'stopped'],
  scheduled: ['eligible', 'stopped'],
  eligible: ['delivering', 'paused', 'stopped'],
  delivering: ['paused', 'completed', 'stopped'],
  paused: ['eligible', 'delivering', 'stopped'],
  completed: [],
  stopped: []
});

const PILOT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const PILOT_LIST_KEY = 'pilots:index';
const PILOT_KEY_PREFIX = 'pilot:';

function flagOn(env, key) { return !!(env && env[key] === 'true'); }
function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
function newPilot(input, now = Date.now()) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = cleanText(body.id, 40).toLowerCase();
  if (!PILOT_ID_RE.test(id)) return { error: 'id must be 3-40 lowercase letters, numbers, _ or -' };
  const sponsor = cleanText(body.sponsor, 80);
  if (!sponsor) return { error: 'sponsor required' };
  const commercialMode = body.commercialMode === 'free' ? 'free' : 'manual';
  return { record: {
    id, sponsor,
    creative: {
      tagline: cleanText(body.tagline, 120),
      clickUrl: /^https:\/\//i.test(cleanText(body.clickUrl, 500)) ? cleanText(body.clickUrl, 500) : '',
      marker: body.creativeKind === 'reviewed_real' ? 'reviewed_real' : 'fictional_sample'
    },
    state: 'draft',
    commercialMode,
    grossMediaRevenueCents: 0,
    promotionalPoolCents: 0,
    viewerPoolAllocationCents: 0,
    allocationEvents: [],
    createdAt: now,
    updatedAt: now,
    foundingPilotSignedAt: null,
    history: [{ from: null, to: 'draft', at: now, note: 'admin intake' }]
  }};
}

function transitionGate(from, to, env) {
  if (!(PILOT_STATES.includes(from) && PILOT_STATES.includes(to))) return 'unknown state';
  if (!(PILOT_TRANSITIONS[from] || []).includes(to)) return 'invalid transition';
  if (to === 'pilot_enabled' && !flagOn(env, 'PILOT_ENABLEMENT_ENABLED')) {
    return 'pilot enablement is disabled';
  }
  if (to === 'scheduled' && !flagOn(env, 'PILOT_SCHEDULING_ENABLED')) return 'pilot scheduling is disabled';
  if (['eligible', 'delivering'].includes(to) && !flagOn(env, 'PILOT_DELIVERY_ENABLED')) return 'pilot delivery is disabled';
  return '';
}

function transitionPilot(record, target, env, input = {}, now = Date.now()) {
  if (!record || typeof record !== 'object') return { error: 'pilot not found' };
  const to = cleanText(target, 40);
  const gateError = transitionGate(record.state, to, env);
  if (gateError) return { error: gateError };
  if (to === 'approved_not_funded' && input.foundingPilotSigned !== true) return { error: 'founding pilot sponsor signature required' };
  const next = JSON.parse(JSON.stringify(record));
  const from = next.state;
  next.state = to;
  if (to === 'approved_not_funded') next.foundingPilotSignedAt = now;
  next.updatedAt = now;
  next.history = Array.isArray(next.history) ? next.history.slice(-99) : [];
  next.history.push({ from, to, at: now, note: cleanText(input.note, 240) });
  return { record: next };
}

function confirmPilotRevenue(record, input, env, now = Date.now()) {
  if (!flagOn(env, 'BILLING_ENABLED')) return { error: 'billing is disabled' };
  if (!record || record.state !== 'approved_not_funded') return { error: 'pilot must be approved_not_funded' };
  const gross = nonNegativeInt(input && input.grossMediaRevenueCents);
  if (gross <= 0) return { error: 'confirmed gross media revenue must be positive' };
  const next = JSON.parse(JSON.stringify(record));
  next.grossMediaRevenueCents = gross;
  next.viewerPoolAllocationCents = Math.floor(gross * 0.70);
  next.allocationEvents = Array.isArray(next.allocationEvents) ? next.allocationEvents.slice(-99) : [];
  next.allocationEvents.push({ type: 'viewer_pool_allocation', grossMediaRevenueCents: gross,
    viewerPoolAllocationCents: next.viewerPoolAllocationCents, at: now });
  next.updatedAt = now;
  return { record: next };
}

function fundPromotionalPool(record, input, env, now = Date.now()) {
  if (!flagOn(env, 'PROMOTIONAL_POOL_ENABLED')) return { error: 'promotional pool funding is disabled' };
  const cents = nonNegativeInt(input && input.promotionalPoolCents);
  if (cents <= 0) return { error: 'promotional pool must be positive' };
  const next = JSON.parse(JSON.stringify(record));
  next.promotionalPoolCents = cents;
  next.updatedAt = now;
  return { record: next };
}

function eligiblePilotView(records, env) {
  if (!flagOn(env, 'PILOT_DELIVERY_ENABLED')) return { enabled: false, campaigns: [] };
  const list = Array.isArray(records) ? records : [];
  return { enabled: true, campaigns: list.filter((r) => r && ['eligible', 'delivering'].includes(r.state))
    .map((r) => ({ id: r.id, sponsor: r.sponsor, creative: r.creative })) };
}

function sponsorSlot(realEligible, demoCampaign) {
  const real = Array.isArray(realEligible) ? realEligible.filter((r) => r && r.id && r.sponsor) : [];
  if (real.length) return { mode: 'real', campaign: real[0] };
  const demo = demoCampaign && demoCampaign.id && demoCampaign.sponsor ? demoCampaign :
    { id: 'demo-no-ad', sponsor: 'FreeCoffee', creative: { tagline: 'Demo only · no paid campaign', marker: 'fictional_sample' } };
  return { mode: 'demo_no_ad', campaign: demo };
}

function publicLaunchGate(records) {
  const list = Array.isArray(records) ? records : [];
  return { enabled: list.some((r) => r && Number.isFinite(r.foundingPilotSignedAt) && r.foundingPilotSignedAt > 0),
    requirement: 'at least one founding pilot sponsor signed' };
}

function proofGate(env) {
  return flagOn(env, 'PILOT_DELIVERY_ENABLED') && flagOn(env, 'PILOT_PROOF_ENABLED');
}
function settlementGate(env) {
  return flagOn(env, 'BILLING_ENABLED') && flagOn(env, 'PILOT_SETTLEMENT_ENABLED');
}

export { PILOT_STATES, PILOT_TRANSITIONS, PILOT_LIST_KEY, PILOT_KEY_PREFIX, flagOn,
  newPilot, transitionPilot, confirmPilotRevenue, fundPromotionalPool, eligiblePilotView,
  sponsorSlot, publicLaunchGate, proofGate, settlementGate };
