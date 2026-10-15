# Real earnings security and cutover

This is a fail-closed accounting boundary, not an ad-verification or payout system.
Economics remain 70% base, platform-funded 10% launch boost when enabled, 5% referrer
and 5% referee bonuses, 30-day earning term and 14-day last-click attribution.
Existing balances are imported unchanged, not recalculated or declared verified.

## Storage and trust

`src/entry.js` exports the Worker and `LedgerAuthority`. `wrangler.toml` adds a
SQLite Durable Object namespace named `LEDGER` and the one-time `ledger-v1` class
migration. Every request uses object name `earnings-v1`. Do not change that name,
namespace or class, delete storage, roll back to the legacy money writer, or rerun
initialization against a new object: that would fork balances.

The authority uses `storage.transaction()` and the transaction's `get`/`put`/`list`
methods. Referee award, referrer credit, accrual and consumed receipt/result are
one transaction across both devices. A write failure rolls back all of them. No
money write goes to eventually consistent `SITE_KV`. There is deliberately one
object, not a per-device object, so cross-device credits really are atomic.

`ADMIN_TOKEN` is server-side only. It can migrate, enroll and authorize events;
compromise means compromise of the accounting authority. Device tokens are random
64-character hex secrets, returned once at explicit admin enrollment and stored
only as SHA-256 hashes. Bearer credentials require HTTPS and private storage. Do
not put an admin secret, migration backup, device secret or receipt in public
assets, logs, URLs or git. CORS allows authorization headers, not cookie sessions.

## Deploy frozen first, migrate second

1. Back up all existing KV money records and retain an offline copy. Deploy this
   version with the `LEDGER` binding and `ledger-v1` class migration. Deploy all
   traffic to this version, stop old versions, preview writers and any external
   jobs that mutate `earn:`, `ref:`, `refcode:` or `refs:`. Never use a gradual
   mixed-version rollout for this cutover. At this point all real money endpoints
   return 503 until migration; `/health`, public feeds and the seeded demo work.
2. Let KV's eventual propagation drain. Wait at least two minutes after the last
   writer stops, then export **every page** of all four prefixes and review the
   complete backup. A record is `[key, parsed JSON value]`; the backup is an array
   of those records. Include zero-balance ledgers, referral bindings, owner records
   and indexes. Do not use a sample, truncated listing or balance totals alone.
   Keep the production namespace unchanged as a read-only historical backup.
3. Generate the manifest without sending private records to the shell output:
   `node migration-manifest.mjs < /private/reviewed-snapshot.json > /private/manifest.json`.
   This sorts keys and hashes `JSON.stringify(sortedRecords)` with SHA-256. Empty
   snapshots are permitted only if the administrator really reviewed a complete
   empty legacy namespace. A missing binding is never interpreted as empty.
4. Set the Worker variable `LEGACY_LEDGER_FROZEN=true` only after that review and
   freeze. POST `/admin/ledger/migrate` with admin bearer auth and the manifest.
   The manifest contains `confirm:"legacy writers stopped; snapshot reviewed"`,
   `recordCount`, and `snapshotSha256`. The server independently reads every KV
   prefix/page and verifies the same count and digest before a transaction imports
   the snapshot and writes its migration marker. Wrong hash/count, corrupt JSON,
   corrupt balances, missing referral owners/indexes or read failures fail closed.
   There is no fallback to zero. Every identity referenced by a binding, owner or
   index must have its own `earn:` record, even if it has never earned anything.
   Missing records reject the whole migration; there is no inferred-zero approval
   switch. All records and the marker commit together.
5. A successful import returns counts, not private records. Repeating migration
   returns 409 and never overwrites balances. Remove the freeze variable afterward
   to reduce accidental bootstrap attempts. Enrollment still works. If migration
   fails, investigate the source snapshot rather than deleting records or toggling
   to the old writer. Snapshot size is bounded to 5,000 records; larger deployments
   need a separately reviewed staged migration, not truncation.

The application cannot establish that legacy writers really stopped or that a
human exported a complete authoritative snapshot. Those are operational gates;
the explicit freeze acknowledgment and backup digest make the reviewed state
binding, but cannot prove the review happened. Preexisting KV balances were
client-reported and must not be treated as verified advertiser liabilities.

## Legacy compatibility and missing-ledger policy

The importer preserves accepted ledger records exactly. It never rebuilds totals
from retained rows or creates balances for referral-only identities. Legacy
registration/attribution could create owner records, bindings or indexes before
an earnings record existed. Such otherwise legitimate snapshots now BLOCK the
cutover. A known identity without an earnings record is not evidence of a zero
balance. Keep tracking frozen and resolve missing authoritative records through
a separate reconciliation review; a manifest approval alone cannot authorize
invented balances. Do not delete referral records to make migration pass.

At import and on authority reads, total/today/monthly/referral/bonus amounts and
row amounts must be finite nonnegative numbers. Counters, monthly impressions,
optional monthly paid clicks, daily click attempts, platform minutes/clicks and
optional row minutes must be nonnegative safe integers, not numeric strings.
Dates must be actual ISO calendar days and months; row types and timestamps
must have supported shapes. Present malformed optional data is rejected, not
replaced with defaults. Invalid stored or computed ledgers return 503 and no
transaction changes balances or consumes the receipt. Statistics also fail
closed rather than skipping corrupt ledgers.

Supported older shapes may omit `monthly.paidClicks`, `counters.platforms`,
`referral`, `bonuses`, `firstValidImpressionAt`, and row `minutes`, `platform` or
`region`. Existing pure helpers retain their legacy behavior: missing paid-click
counts use lifetime click attempts conservatively until month rollover; old
impression rows without minutes count as one in retained-row reporting. Core
balance, today/monthly buckets, impression/click counters and dated daily click
counter remain required. Missing core data or unsupported historical schemas
need separate evidence-backed reconciliation, not coercion or silent repair.
Daily click attempts above five are valid history (unpaid attempts still count),
not corruption; negative/fractional attempts are rejected even for older dates.
Review the full production snapshot for these compatibility risks before any
deployment. Available git history and helper tests do not establish every shape
that may exist in production KV.

## Administrator-only enrollment

POST `/admin/ledger/enroll` with `Authorization: Bearer $ADMIN_TOKEN`.
For a migrated identity send `{deviceId, confirmOwnership:true}`. The administrator
must verify its owner out of band; knowledge of a device UUID is not ownership.
Only migrated identities with an intact ledger qualify. Public requests cannot
bootstrap or claim a known device, even one that was never enrolled.

For a brand-new identity send only `{confirmOwnership:true}`. The server generates
a fresh UUID and a zero ledger in the same transaction as its hashed credential.
The response is `{ok:true, deviceId, token}` with 201. Deliver the token privately.
Existing enrollment returns 409; there is intentionally no public recovery or
rotation path. A lost enrollment response requires a separately reviewed recovery
procedure, not reinitializing the ledger.

Device auth protects GET `/earnings/{deviceId}`, POST `/referral` and GET
`/referrals/{code}`. The latter is now private to the owning referrer, despite
being aggregate-shaped. Referral actions are explicit `register`, `claim` or
`click`. Registration, attribution/index changes and the impression-lock check
are transactional. Once the first impression exists attribution cannot change.

## Bounded event authorization and replay

A trusted server/administrator calls POST `/admin/ledger/receipt`, using admin
bearer auth, with `{deviceId, eventId, type, campaignId, minutes, platform, region}`.
The stable upstream `eventId` must be 16–100 ASCII letters, digits, `_` or `-`.
It is globally unique to the original trusted event, not a client retry counter.
Impressions require an integer 1–60 minutes. Clicks require `minutes:0`.

The campaign must be currently serving and meet the existing $2 CPM floor. The
server snapshots the served campaign and launch flag, then stores an unpredictable
receipt ID bound to the normalized exact report and enrolled device. The receipt
expires after five minutes if unconsumed. Duplicate upstream event IDs with the
same report return the original receipt; reusing an ID with changed report fields
returns 409. Device credentials alone cannot obtain receipts or authorize minutes.

The enrolled device POSTs `/track` with its own bearer token and
`{deviceId, type, campaignId, minutes, platform, region, receiptId}`. No client amount
or extra field is accepted. Platform and region use the existing normalization;
that canonical report is the receipt's binding. Wrong device credentials return
401, missing/unknown/expired unconsumed receipts return 403, changed report fields
return 409, malformed bounded reports return 400. Missing security configuration,
migration or unavailable/corrupt storage returns 503. No such failure means zero.

A successful transaction stores the original result beside the receipt. Identical
retries, including concurrent calls and retries after expiry, return that result
without paying again. The original response total is intentional and may be older
than the current balance; GET authenticated earnings for current state. A receipt
pays against its authorization-time campaign snapshot, even if the feed changes
within its five-minute lifetime. The consumed record and event ID are retained;
there is no unsafe TTL that allows replay. Growth is bounded by trusted issuance,
not by an unauthenticated client's choice of novel event keys.

Receipts are opaque server-stored authorizations, not signed ad-proof documents.
There is **no independent ad-view verification**. Before issuing a receipt, a real
integration must verify its upstream evidence and reuse its stable event ID. No
such integration ships here, and no public receipt-minting endpoint exists. An
administrator can authorize bad events, and administrator-created sybil devices
are not prevented by device auth. Real disbursement remains blocked on verified
delivery, funded campaigns, abuse review and actual settlement/payout controls.

## Public clients and reports

The browser demo stays usable and its local simulated ledger is unchanged. Its
old real-earnings/referral calls have no credential or receipt, so they now fail
closed. The current real-earnings panel uses a generic backend error and has no
enrollment UI; do not describe setting a backend URL as enabling payouts. The Mac
app still does not send telemetry or real earnings. No client was wired in this
change, and no shared admin credential was embedded.

Public `/stats` reads a transactional aggregate after migration, never exposes
identities and labels data as historical reports/administrator authorizations,
not independent proof. It returns 503 before migration. It currently limits the
aggregate to 5,000 ledgers and fails instead of silently truncating. Legacy rows
still use the existing 200-row retention; these are retained-row reports, not a
complete lifetime invoice. There is no signed delivery proof or settlement receipt.

## Verification

Run `node test.mjs` for pure economics plus fail-closed migration, exact legacy
balance preservation, enrollment isolation, receipt binding, expiry, concurrent
deduplication, write-fault rollback and atomic click caps. `bash ../test.sh` runs
that suite plus the existing site gates. The optional browser gate can skip when
Chrome is unavailable and is not proof of a browser pass.

Run `node runtime-smoke.mjs` from backend for an actual local Workers/SQLite Durable
Object migration, enrollment, referral credit and twelve simultaneous duplicate
requests. It launches the existing Wrangler 3 tool locally, uses temporary state
and a test-only secret, and removes its state afterward. No production API writes.
Run `npx wrangler@3 deploy --dry-run` for the deployment bundle/bindings check.
Wrangler 3 emits an out-of-date warning and its local runtime falls back from the
configured 2026 date to 2025-07-18; the tested APIs work on that runtime. Upgrade the
toolchain separately rather than silently adding dependencies during security work.
