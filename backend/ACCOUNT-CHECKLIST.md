# FreeCoffee — go-live account checklist

Everything needed to take FreeCoffee from honest demo to real settled
earnings. Every account below is **free** unless marked; nothing here needs
a credit card until the two optional paid items at the end. Work top to
bottom — each item lists the exact click-path and what it unlocks.

---

## ☐ 1. [FREE] Cloudflare account → deploy the backend Worker

**Click-path:**
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Sign up** (email +
   password; choose the **Free $0/month** plan when asked).
2. Left sidebar → **Workers & Pages** → **Create** → **Connect to Git**.
3. **Connect GitHub** → authorize → pick the `freecoffee` repository.
4. Configuration:
   - Project name: `freecoffee-backend`
   - Root directory: `backend` (the folder this checklist lives in)
   - Deploy command: `npx wrangler deploy`
5. **Deploy** → from now on every `git push` to `main` redeploys the Worker
   automatically. No API token needed anywhere.

**Unlocks:** the `/health`, `/feed.json`, `/track`, `/earnings/{deviceId}`
and `/admin/feed` endpoints on
`https://freecoffee-backend.<your-subdomain>.workers.dev` — the thing the
site's REAL EARNINGS panel talks to. Free tier = 100k requests/day.

## ☐ 2. [FREE] Cloudflare KV namespace → give the Worker memory

**Click-path:**
1. Same dashboard → **Workers & Pages → KV → Create a namespace** →
   name: `freecoffee-kv` → **Add**.
2. Copy the **Namespace ID** → paste it into `backend/wrangler.toml`
   (replace `REPLACE_WITH_KV_ID`; also replace `REPLACE_WITH_ACCOUNT_ID`
   with your Account ID from the dashboard's right sidebar) → commit/push
   (or add it as a binding: Worker → Settings → Bindings → KV namespace →
   variable name `SITE_KV`).
3. **Deployments → your deployment → Retry deploy** if the first deploy ran
   before the id was in place.

**Unlocks:** the earnings ledger (`earn:{deviceId}`) and the campaign cache
(`feed:current`). Without KV, `/track` honestly answers
`503 KV not configured` instead of pretending.

## ☐ 3. [FREE] ADMIN_TOKEN secret → lock the admin route

**Click-path:** dashboard → Workers & Pages → `freecoffee-backend` →
**Settings → Variables and Secrets → Add** → type **Secret**, name
`ADMIN_TOKEN`, value: a long random string (`openssl rand -hex 24` in a
terminal) → **Encrypt** → Deploy.
(Or from a terminal: `cd backend && npx wrangler secret put ADMIN_TOKEN`.)

**Unlocks:** only you can upload campaigns via `POST /admin/feed`
(`Authorization: Bearer <that token>`). Without it the endpoint answers 401.

## ☐ 4. [FREE] Ad network account → real campaigns, real CPM

Pick **one** to start; you can add more later.

**Option A — BitLabs (offerwall, instant self-serve approval):**
1. [bitlabs.ai](https://bitlabs.ai) → **Become a partner / Sign up** (free).
2. Dashboard → copy your **API key / token**.
3. Either paste the key as a Worker secret (`ADAPTER_KEY`, same flow as
   step 3) and extend the adapter slot in `backend/src/worker.js` (a
   `// TODO(adapter)` marker shows where their offer list maps to the feed
   contract: their payout rate → `cpm`), or run their feed through any
   HTTPS JSON endpoint you control and point `ADAPTER_URL` at it.

**Option B — Impact (affiliate feeds):**
1. [impact.com](https://impact.com) → **Get started** (free creator/partner
   signup) → approve as a partner.
2. UI → **Create → tracking links / API** → generate an offer feed.

**Option C — PartnerStack:** same shape — free partner signup →
**Integrations/API keys** → offer feed.

**Unlocks:** real campaigns with real payout rates flowing into
`/feed.json` → LIVE-marked placements → **actual money** accruing against
your deviceId via `/track` (65% user share, click caps enforced
server-side). Until this exists the site keeps serving the fictional demo
sponsors and $0.00 — by design.

## ☐ 5. [FREE] GitHub (you already have this) → CI deploy token

**Click-path:** *only if you did NOT use Workers Builds in step 1:*
Cloudflare → **My Profile → API Tokens → Create Token → "Edit Cloudflare
Workers" template** → Create → copy → GitHub repo → **Settings → Secrets
and variables → Actions → New repository secret** → name
`CLOUDFLARE_API_TOKEN` → paste. The included
`.github/workflows/deploy-backend.yml` then deploys on every push touching
`backend/**`; with no secret it prints instructions and stays green.

**Unlocks:** push-to-deploy CI for the backend.

## ☐ 6. [PAID, optional] freecoffee.tech domain

**Click-path:** any registrar (~$10/yr) → Cloudflare (free plan) → **Add a
site** → point the nameservers → Workers & Pages → your Worker →
**Settings → Domains & Routes → Add → Custom domain** → `freecoffee.tech`.

**Unlocks:** a branded backend URL (`https://backend.freecoffee.tech`) and,
later, Pages custom domains. Cosmetic — nothing else changes.

## ☐ 7. [PAID, skipped on purpose] Apple Developer ($99/yr)

**Do not buy.** macOS Gatekeeper is already solved by the Homebrew tap
(`ayodhyamohanthy/freecoffee-tap`): `brew install --cask freecoffee`
installs a tap-notarized flow without any Apple certificate. The included
`bump-tap.yml` workflow keeps the Cask's version/sha256 in sync with each
DMG release.

---

## After the checklist: 60-second go-live test

```bash
curl https://freecoffee-backend.<your-subdomain>.workers.dev/health        # {"ok":true}
curl -X POST https://freecoffee-backend.<your-subdomain>.workers.dev/admin/feed \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d @feeds/test-campaigns.json
```

Then: site → **Profile → BACKEND API URL** → paste the workers.dev URL →
**Test** → "Backend OK" → **Save changes** → open **Overview** → the
**REAL EARNINGS (backend)** panel appears above the payout simulator and
starts counting verified impressions. Demo ledger untouched, as labeled.
