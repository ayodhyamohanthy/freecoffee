# FreeCoffee backend — Worker, KV feed, transactional earnings

> **Deployment status (2026-09-13):** live at
> **https://freecoffee-backend.ayodhya-711.workers.dev**. KV namespace
> `freecoffee-kv` bound as `SITE_KV`; `ADMIN_TOKEN` secret set. The admin
> token is saved locally at `~/freecoffee-admin-token.txt` (chmod 600) — it
> is never committed. `wrangler.toml` now carries the real account + KV ids.
> Feed is intentionally empty (`{"campaigns":[]}`) until the first real
> campaign is pushed via `POST /admin/feed` (see the cold-start runbook in
> the root README).

The feed and campaign configuration still use KV. Money now belongs to one
SQLite-backed Durable Object (`LEDGER`, class `LedgerAuthority`, object name
`earnings-v1`). Deploying this version freezes the old unauthenticated money
paths. Nothing initializes an empty replacement ledger automatically.

**Real tracking is disabled until a reviewed legacy migration and explicit
administrator enrollment.** Each event additionally needs a single-use,
body-bound server receipt from a trusted administrator. The existing static
web demo has neither credentials nor receipts and cannot earn real money;
its simulated ledger remains usable. The Mac app still does not report
telemetry or real earnings. Do not put `ADMIN_TOKEN` in either public client.

Read [SECURITY-LEDGER.md](SECURITY-LEDGER.md) before deploying or enabling money.
Receipts authorize events; they do not prove an ad was actually viewed. There
is no independent ad-view verification, settlement or payout integration here.

```
backend/
├── src/entry.js         deployment exports (handler + Durable Object only)
├── src/worker.js        routes, economics, feed, slots, MCP
├── src/accounts.js      sign-in (GitHub/Google), sessions, account + Mac linking
├── src/clicks.js        paid-click tracking + admin audit
├── src/pilots.js        pilot programs (create, transition, revenue, pools)
├── src/ledger.js        transactional money authority
├── test.mjs             unit tests:  node test.mjs
├── wrangler.toml        config — paste your KV namespace id + account id here
└── ACCOUNT-CHECKLIST.md the exact free-account checklist, in order
```

## API

| Route | Method | Auth | What it does |
|---|---|---|---|
| `/health` | GET | — | `{ok:true}` liveness probe (used by the site's Test button) |
| `/feed.json` | GET | — | Campaign feed (same JSON contract as the web `AD FEED URL`), CORS `*` |
| `/track` | POST | Device bearer + server receipt | Bounded report + `receiptId` → `{ok, earned, total}`; identical retry returns original result |
| `/earnings/{deviceId}` | GET | Owning device bearer | `{total, today, monthly, rows (last 50), counters}` |
| `/referral` | POST | Owning device bearer | Explicit `register`, `claim`, or `click`, transactionally updates binding/index |
| `/referrals/{code}` | GET | Owning referrer bearer | Private aggregate referral view |
| `/admin/ledger/migrate` | POST | Admin bearer + freeze acknowledgment + reviewed backup digest | One-time complete legacy import |
| `/admin/ledger/enroll` | POST | Admin bearer + verified ownership | Enroll a migrated device or generate a new identity; returns device token once |
| `/admin/ledger/receipt` | POST | Admin bearer | Authorize exact bounded event using stable upstream `eventId` |
| `/submit` | POST | — | Submit ONE campaign object → pending-review queue (id+sponsor required, https destination, $2 CPM floor, no duplicate ids, 5/day per IP, queue cap 50). Nothing serves without admin approval |
| `/admin/queue` | GET | `Authorization: Bearer $ADMIN_TOKEN` | List campaigns awaiting human review |
| `/admin/review` | POST | `Authorization: Bearer $ADMIN_TOKEN` | `{id, approve}` → approved goes live (feed cap 20), rejected leaves the queue |
| `/stats` | GET | — | Public aggregate delivery report: per-campaign authorized/historical reported minutes, clicks, user-share spend + network totals (not independent proof). No device ids, no rows — safe for the advertiser page, no token needed |
| `/admin/feed` | POST | `Authorization: Bearer $ADMIN_TOKEN` | Upload a validated campaign array → KV `feed:current` |
| `/slots` | GET | — | Slot-auction inventory for `?month=YYYY-MM` (defaults to the current month): every four-hour UTC block, its bids and price-to-win |
| `/slots/current` | GET | — | The four-hour block being served right now |
| `/market` | GET | — | Public market snapshot: serving floor and per-block pricing for the lookahead (`?blocks=` caps it at 48) |
| `/slots/bid` | POST | Optional account bearer | One bid object `{campaign, slots[], bidder}` across chosen blocks; first-price auction, highest CPM per block wins; a signed-in session records the bid on the account |
| `/mcp` | POST | — | Read-only agent endpoint: stateless JSON-RPC 2.0 MCP (market browse, block list, creative preview). It cannot bid, fund, or read anything private; GET answers 405 |
| `/pilot-interest` | POST | — | Pilot interest intake (company, name, valid email, optional https destination); rate-limited per IP, capped queue |
| `/campaigns/eligible` | GET | — | Campaigns currently eligible for pilot programs |
| `/auth/status` | GET | — | `{ok, providers:{github, google}}`: which sign-in providers are configured |
| `/auth/{github,google}/start` | GET | — | Redirect to the provider's sign-in |
| `/auth/{github,google}/callback` | GET | — | Completes sign-in and redirects back with a one-time session token |
| `/auth/logout` | POST | Account bearer | Deletes the session |
| `/me` | GET | Account bearer | Signed-in account profile (id, provider, name, avatar) |
| `/me/bids` | GET | Account bearer | The account's placed slot bids, as recorded at bid time (max 50) |
| `/me/link` | GET | Account bearer | The account's linked Mac, if any (label only; changes nothing about earning) |
| `/me/link-code` | POST | Account bearer | Mint a one-time Mac-linking code (10-minute TTL) |
| `/me/link/unlink` | POST | Account bearer | Unlink the Mac |
| `/link/redeem` | POST | One-time link code | Redeem a link code from the Mac app (rate-limited per IP) |
| `/admin/pilots` | GET / POST | `Authorization: Bearer $ADMIN_TOKEN` | List pilots / create a pilot |
| `/admin/pilots/transition` | POST | `Authorization: Bearer $ADMIN_TOKEN` | Move a pilot between states |
| `/admin/pilots/revenue` | POST | `Authorization: Bearer $ADMIN_TOKEN` | Confirm a pilot's revenue |
| `/admin/pilots/promotional-pool` | POST | `Authorization: Bearer $ADMIN_TOKEN` | Fund a pilot's promotional pool |
| `/admin/pilots/proof` | GET | `Authorization: Bearer $ADMIN_TOKEN` | Proof adapter (answers 501 until configured) |
| `/admin/pilots/settlement` | POST | `Authorization: Bearer $ADMIN_TOKEN` | Settlement adapter (answers 501 until configured) |
| `/admin/clicks` | GET | `Authorization: Bearer $ADMIN_TOKEN` | Paid-click audit for one campaign (`?campaign=`, `?days=`, default 7) |

- **Money math is server-side.** The enrolled client sends the exact authorized report and `receiptId`;
  amounts are computed from the campaign `cpm` looked up in the **served
  feed**. Impression: `minutes × cpm ÷ 1000 × 0.70`. Click: $0.05, capped
  server-side at 5/day per device and ≤25% of that device's monthly
  impressions (caps read from the stored ledger, not the request).
- Feed validation mirrors the web client exactly (https-only URLs, string
  caps, cpm clamp 0–100, dedupe by id, cap 20) plus one stricter rule: `id`
  is required server-side (it is the earnings pay-key).
- `GET /feed.json` sources, in order: KV `feed:current` → `ADAPTER_URL`
  (fetched, validated, cached to KV with a 10-min TTL) → `{campaigns: []}`
  with 200.
- Every response carries `access-control-allow-origin: *`; `OPTIONS`
  preflights get 204.
- Money reads/writes use a single Durable Object transaction. Referee balance,
  referrer balance, referral accrual, and receipt consumption commit together.
  KV is used only for legacy migration and non-money configuration.

## Setup — exact steps

> `ACCOUNT-CHECKLIST.md` is the same list with click-paths and "what it
> unlocks" per item. Follow either one; this file is the technical version.

### ① Deploy the Worker (pick ONE path)

**Path A — Workers Builds (easiest, no token at all):**

1. Sign up / log in at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan).
2. **Workers & Pages → Create → Choose "Connect to Git"** (Select a repository).
3. Authorize GitHub, pick the `freecoffee` repo, and set:
   - **Project name:** `freecoffee-backend`
   - **Root directory:** `freecoffee/backend` (or `backend` if the repo root *is* freecoffee)
   - **Deploy command:** `npx wrangler deploy`
   - **Entry point / main:** `src/entry.js`
4. Deploy. Workers Builds now deploys on **every push to main** — no token,
   no GitHub Actions needed. Skip step ②.

**Path B — GitHub Actions with an API token:**

1. Cloudflare dashboard → **My Profile (top-right avatar) → API Tokens →
   Create Token** → use the **"Edit Cloudflare Workers"** template →
   (optionally scope Account Resources to your account) → Create.
2. Copy the token → GitHub repo → **Settings → Secrets and variables →
   Actions → New repository secret** → name `CLOUDFLARE_API_TOKEN`, paste
   the token.
3. The included workflow (`.github/workflows/deploy-backend.yml`) runs
   `npx wrangler deploy` on every push that touches `backend/**`. If the
   secret is absent the workflow **fails loudly** and deploys nothing.

> ### Verify what is actually deployed — do this before debugging any page
>
> "Never fails" has a cost: both paths above can leave the live Worker silently
> behind the repo, with every check still green. That is not hypothetical. On
> **2026-09-16** the deployed Worker answered `/health`, `/feed.json`,
> `/earnings/{id}`, `/track` and `/admin/feed`, while **`/stats`, `/slots`,
> `/slots/current`, `/slots/bid`, `/submit`, `/admin/queue`, `/admin/review`,
> `/referral` and `/referrals/{code}` all returned
> `404 {"ok":false,"error":"not found"}`.** The delivery report on
> `campaigns.html`, the slot picker on `advertisers.html`, the submission form
> and the whole referral loop therefore could not work in production, and the
> site was promising all four.
>
> ```bash
> B=https://freecoffee-backend.ayodhya-711.workers.dev
> for p in /health /feed.json /stats /slots /slots/current; do
>   printf '%-18s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$B$p")"
> done
> ```
>
> Read the codes carefully: **404 means the route is absent from the
> deployment.** A 400 or 401 means the route exists and rejected the empty
> request — which is the answer you want. Note the real paths are `/feed.json`
> and `/earnings/{deviceId}`, not `/feed` and `/earnings`.
>
> Fix it with `cd backend && npx wrangler deploy`, or set the
> `CLOUDFLARE_API_TOKEN` repo secret so the workflow stops skipping, or switch
> to Workers Builds (Path A) which deploys on push with no token at all.

### ② Create the KV namespace and bind it

1. Dashboard → **Workers & Pages → KV → Create a namespace** → name it
   `freecoffee-kv` → Create.
2. Copy its **Namespace ID** (32 hex chars) into `wrangler.toml` →
   `kv_namespaces.id` (replace `REPLACE_WITH_KV_ID`), and your Cloudflare
   **Account ID** (dashboard right sidebar / Workers & Pages overview) into
   `account_id` — then push, or redeploy from the dashboard.
   - Dashboard-only alternative: Worker → Settings → Variables + Bindings →
     **KV namespace** → bind `SITE_KV`.
3. Lost money bindings are fail-safe: `/track` answers `503 secure ledger unavailable`
   instead of falling back to KV or starting new balances.

### ③ Set the admin token

```bash
cd backend
npx wrangler secret put ADMIN_TOKEN     # paste a long random string
# or: dashboard → Workers & Pages → freecoffee-backend → Settings →
#      Variables and Secrets → Add → type Secret, name ADMIN_TOKEN → Encrypt
```

`ADMIN_TOKEN` guards `POST /admin/feed` (feed uploads). Generate a strong
one with `openssl rand -hex 24`.

### ④ (Optional) Wire a real ad network

- Set `ADAPTER_URL` (Worker → Settings → Variables) to any HTTPS JSON feed
  matching the contract — the Worker fetches, validates, caches to KV for
  10 minutes and serves it.
- Or push a hand-made feed yourself:

```bash
curl -X POST https://freecoffee-backend.<your-subdomain>.workers.dev/admin/feed \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"id":"camp_001","sponsor":"Acme Coffee Co.","tagline":"20% off first bag","clickUrl":"https://acme.example/offer","cpm":6.0,"logoText":"AC","accent":"#C98F4E"}]'
```

- The ad-network account itself (BitLabs / Impact / PartnerStack — all
  free to join) and the `ADAPTER_KEY` slot are described in
  [`ACCOUNT-CHECKLIST.md`](ACCOUNT-CHECKLIST.md).

### ⑤ Test it and wire it into the site

```bash
curl https://freecoffee-backend.<your-subdomain>.workers.dev/health
# → {"ok":true}
```

A healthy `/health` proves liveness only, not migration, enrollment, receipt
verification, payout readiness or ad delivery. Setting a backend URL in Profile
still allows the public feed, but does not enroll that browser. Its real-earnings
panel cannot authenticate with this backend yet and may show its generic backend
error. This is intentional fail-closed behavior, not a zero balance. See the
security runbook for the separate administrator-only bootstrap.

## Local development / tests

```bash
node test.mjs                 # pure-helper unit tests (no network)
node --check src/worker.js    # syntax check
node --check src/ledger.js
node runtime-smoke.mjs        # local Wrangler + real Durable Object concurrency gate
npx wrangler dev              # full local Worker with emulated KV
```
