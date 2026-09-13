# FreeCoffee backend — Cloudflare Worker + KV

> **Deployment status (2026-09-13):** live at
> **https://freecoffee-backend.ayodhya-711.workers.dev**. KV namespace
> `freecoffee-kv` bound as `SITE_KV`; `ADMIN_TOKEN` secret set. The admin
> token is saved locally at `~/freecoffee-admin-token.txt` (chmod 600) — it
> is never committed. `wrangler.toml` now carries the real account + KV ids.
> Feed is intentionally empty (`{"campaigns":[]}`) until the first real
> campaign is pushed via `POST /admin/feed` (see the cold-start runbook in
> the root README).

The production backend for FreeCoffee's **real-earnings** layer: serves the
validated ad feed (`/feed.json`), records impressions/clicks from the web
dashboard, and keeps a per-device earnings ledger in Cloudflare KV. Runs on
the **Cloudflare free plan** (100k requests/day — orders of magnitude more
than this project needs).

**Honest separation:** everything on the web pages that is *not* wired to
this backend stays simulated (the seeded demo ledger, the payout simulator).
The dashboard's **REAL EARNINGS (backend)** panel only appears once a
backend URL is set in Profile → BACKEND API URL, and it only ever shows what
this Worker actually recorded. The two never mix.

```
backend/
├── src/worker.js        the Worker (plain ES module, no build step, no deps)
├── test.mjs             unit tests:  node test.mjs
├── wrangler.toml        config — paste your KV namespace id + account id here
└── ACCOUNT-CHECKLIST.md the exact free-account checklist, in order
```

## API

| Route | Method | Auth | What it does |
|---|---|---|---|
| `/health` | GET | — | `{ok:true}` liveness probe (used by the site's Test button) |
| `/feed.json` | GET | — | Campaign feed (same JSON contract as the web `AD FEED URL`), CORS `*` |
| `/track` | POST | — | `{deviceId, type:'impression'\|'click', campaignId, minutes?}` → `{ok, earned, total}` |
| `/earnings/{deviceId}` | GET | — | `{total, today, monthly, rows (last 50), counters}` |
| `/admin/feed` | POST | `Authorization: Bearer $ADMIN_TOKEN` | Upload a validated campaign array → KV `feed:current` |

- **Money math is server-side.** The client sends `minutes` + `type` only;
  amounts are computed from the campaign `cpm` looked up in the **served
  feed**. Impression: `minutes × cpm ÷ 1000 × 0.65`. Click: $0.05, capped
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
- KV write model is best-effort read-modify-write (eventually consistent,
  last-write-wins on the free tier — fine for an MVP ledger).

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
   - **Entry point / main:** `src/worker.js`
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
   `npx wrangler deploy` on every push that touches `backend/**`. Until the
   secret exists the workflow simply prints a reminder and **never fails**.

### ② Create the KV namespace and bind it

1. Dashboard → **Workers & Pages → KV → Create a namespace** → name it
   `freecoffee-kv` → Create.
2. Copy its **Namespace ID** (32 hex chars) into `wrangler.toml` →
   `kv_namespaces.id` (replace `REPLACE_WITH_KV_ID`), and your Cloudflare
   **Account ID** (dashboard right sidebar / Workers & Pages overview) into
   `account_id` — then push, or redeploy from the dashboard.
   - Dashboard-only alternative: Worker → Settings → Variables + Bindings →
     **KV namespace** → bind `SITE_KV`.
3. Lost bindings are fail-safe: `/track` answers `503 KV not configured`
   instead of corrupting data.

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

Then open the site → **Profile → BACKEND API URL** → paste the workers.dev
URL → **Test** (green "Backend OK" toast) → **Save changes**. The dashboard
gains a **REAL EARNINGS (backend)** panel that reports impressions via
`/track` once a minute (while the tab is visible and ads are not paused) and
polls `/earnings/{deviceId}`.

## Local development / tests

```bash
node test.mjs                 # pure-helper unit tests (no network)
node --check src/worker.js    # syntax check
npx wrangler dev              # full local Worker with emulated KV
```
