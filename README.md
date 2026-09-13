# FreeCoffee

**Your menu bar buys the coffee.** FreeCoffee is a Mac menu-bar advertising product: advertisers
bid in a real-time auction for minute-long placements in the empty stretch of your menu bar, and
you keep a transparent share of every winning bid — enough, on the demo numbers, for the coffee
(**1 cup = $5**, so every balance also reads "≈ N cups").

This repository is a **complete local demo** — a static marketing/demo site plus a real, compiled
macOS menu-bar app. Everything runs on your machine: no backend, no frameworks, no build step for
the web layer, no CDNs, no external fonts, no npm.

> **FreeCoffee demo — simulated data.**

---

## Run the site

```bash
cd freecoffee
python3 -m http.server 8090
# open http://127.0.0.1:8090
```

That's it — any static file server works.

### Page map

| Page | What it is |
|---|---|
| `index.html` | Landing page: hero with a **live CSS/DOM mock of the macOS menu bar** (rotating sponsor chip, ticking clock, growing balance) **plus a mock of the menu-bar popover** (TOTAL BALANCE block with cups hint, caramel boost line, 7-day bar chart, footer buttons), how-it-works, the privacy data boundary, FAQ. |
| `dashboard.html` | App-shell page (**Earn › Overview**, light theme). Sidebar + breadcrumb shell, balance stat card (Total **$28.55** "≈ 5 cups", Available, Pending, This week, payout-progress toward the $2 minimum), a 14-day SVG area chart (slate-teal line `#4C7A8A` on fill `#DFE9ED`, y-grid, dotted markers), the full ledger with winning bids and exact cuts, an "Action required" panel, a "Recent sponsors" list, and the live payout simulator. Dismissible Setup-guide ("1 of 4 complete") and dark promo cards in the sidebar. `localStorage` key: `freecoffee:v1`. |
| `payouts.html` | App-shell page (**Earn › Payouts**, light theme). Choose how you get paid: Stripe (gold gradient CTA) and Whop (orange gradient CTA) rails split by a divider — clicking marks `freecoffee:v1 → profile.payoutRail` connected (demo-only until the backend payout integration), a Balance 3-stat strip (Total/Available/Pending from the seeded ledger), and the Withdrawal history table fed by simulated `paidOut` records (empty state until the first simulated payout). |
| `model.html` | App-shell page (**Account › Payout model**, light theme). The payout model in plain numbers: lever table, honesty policy, sustainability math (worked example), anti-fraud controls, payout rails. |
| `campaigns.html` | App-shell page (**Advertise › Campaigns**, light theme). Advertiser-side management view with honest zeros (Active 0 / In review 0 / Total spend $0.00 / Impressions 0), working filter tabs (All/Running/In review/Paused/Archived + "N shown"), and the "No campaigns yet" empty state with a gold CTA to the advertiser pitch. |
| `profile.html` | App-shell page (**Account › Profile**). Wide Account form (display name, email, coffee preference, email prefs → saved with a toast to `freecoffee:v1`) plus Payout account (Not set up + Set up), Connected Mac (green Connected pill, "This Mac · macOS 26", Unlink with confirm), and AI agents (Copy setup prompt → clipboard). |
| `referrals.html` | App-shell page (**Earn › Referrals**). Referral link card (URL + Copy → clipboard), rewards cards, a 3-stat row (referred users **2** / referral earnings **$2.82** / next tier), and the referee table from the seeded ledger. |
| `advertisers.html` | App-shell page (**Advertise › Campaigns**). The advertiser pitch + self-serve onboarding: hero, how-it-works (submit feed → review → live), the copyable feed contract JSON, the honesty box (what the client reports today vs what needs the platform backend), pricing (auction CPM with tier floors, $15 minimum, 65% to the user), and the contact card (`advertisers@freecoffee.tech`). |
| `assets/js/demo.js` | Seeded PRNG (mulberry32, seed 42), history generator, projection math, cups helper, menu-bar demo + popover mock cycler, and the live-feed bridge (`fetchLiveCampaigns` — the AD FEED CONTRACT client). Also CommonJS-exported — `node` can `require` it. |
| `assets/js/dashboard.js` | Dashboard rendering + interactions, plus the live-campaign surfaces (banner under the balance card, LIVE rows in Recent sponsors, disconnect). All dynamic strings go through `textContent`/`createElement` — no `innerHTML` with dynamic data. |
| `assets/css/styles.css` | The whole design system: espresso darks, coffee-gold `#E0A93E` family, the app-shell (sidebar / breadcrumb / cards), popover panel, forms, tables, chips, toggles, sliders, toasts, the menu-bar mock, responsive stacking, `:focus-visible`, `prefers-reduced-motion`. |
| `manifest.webmanifest` + `sw.js` | The PWA layer: installable manifest (standalone display, `#E0A93E` theme) and the service worker that precaches all eight pages. See **PWA — installable web app** below. |
| `assets/icons/` | Generated PWA icons (192, 512, 512 maskable) — same coffee-cup generator as the Mac app icon. |
| `app/` | The Mac menu-bar app (see below). |

## The Mac menu-bar app

A single-file Swift/AppKit app — no Xcode project needed. `build.sh` produces the
bare dev binary **and** an installable `dist/FreeCoffee.app` + `dist/FreeCoffee.dmg`:

```bash
cd freecoffee/app
./build.sh             # swiftc build → icons → dist/FreeCoffee.app → ad-hoc sign → dist/FreeCoffee.dmg
./FreeCoffeeMenuBar    # bare dev run: "☕ FreeCoffee" appears at the top-right of your menu bar
```

### What it does

- **Left-click** the ☕ FreeCoffee status item → an **NSPopover** matching the web reference:
  - header row (cup icon, name + subtitle, status dot **Earning** / **Waiting**),
  - divider → **TOTAL BALANCE** label + oversized mono figure + right-aligned
    available/pending + muted "≈ N cups" hint (1 cup = $5),
  - caramel boost line **"☕ 65% base share — always on"**,
  - **Earnings · 7 days** inset bar chart (M T W T F S S with value labels, drawn from the
    persisted per-day history by a custom `NSView`),
  - the gray **"Tip: Hold ⌘ and drag menu-bar items to rearrange them."** line,
  - divider → footer **Settings · Snooze · Disable · Account** buttons:
    Settings opens the demo dashboard (`http://127.0.0.1:8090/dashboard.html`),
    Snooze pauses earning for 30 minutes with a live countdown,
    Disable toggles the persisted earning kill-switch,
    Account opens the demo profile page.
- **Right-click** → menu: **Pause earning** toggle, **Launch at Login** (bundled app only),
  **Check for Updates…**, **About FreeCoffee demo**, **Quit FreeCoffee**.
- Earning ticks up $0.01 every 90 s while your Mac is awake.
- **Auto-updates:** checks GitHub Releases on launch and every 6 h (one anonymous request);
  downloads + sha256-verifies the new DMG and offers **Update & Relaunch**. One-click install,
  applies on next launch if dismissed — details in [`app/Info-howto.md`](app/Info-howto.md#updates).
- Persists `{balance, today, paused, disabled, snoozeUntil, history, lastTick, updateSeen, updateSkipped}`
  to `~/Library/Application Support/FreeCoffee/ledger.json` (created on first run; delete it to reset).
- Privacy: the app collects nothing — no screen, file, keystroke, or window-title access. The only
  outbound traffic is the opt-in advertiser-feed fetch and the anonymous GitHub Releases update
  check; nothing is ever sent back. See the comment block at the top of `FreeCoffeeMenuBar.swift`.

### Install the app (DMG)

1. Open `app/dist/FreeCoffee.dmg` and **drag FreeCoffee into `/Applications`**.
2. **First launch only:** right-click FreeCoffee → **Open** → confirm (see the Gatekeeper
   note in [`app/Info-howto.md`](app/Info-howto.md)), or use System Settings → Privacy & Security →
   **Open Anyway**.
3. That's it — the ☕ status item appears at the top-right of the menu bar.

### Launch at Login

When run from the bundle, the right-click menu has a **Launch at Login** toggle (SMAppService,
macOS 13+; the first enable may need approval in System Settings → General → Login Items &
Extensions). The bare dev binary shows the item disabled — register it manually via Login
Items instead. Details: [`app/Info-howto.md`](app/Info-howto.md).

## PWA — installable web app

The site is also a full PWA (works entirely offline after first visit — no backend anywhere).

- **What works offline:** all eight pages (`index.html`, `dashboard.html`, `payouts.html`, `model.html`,
  `campaigns.html`, `profile.html`, `referrals.html`, `advertisers.html`), the stylesheet, both scripts, and the icons
  are precached at install. The seeded demo engine is deterministic, so the dashboard renders
  identically offline; the payout simulator, ledger, chart, profile form, and pause/payout
  interactions all work with no network. A connected live feed needs the network for fresh fetches,
  but the last-fetched campaigns are cached in `freecoffee:v1` and still render.
- **Install on desktop Chrome/Edge:** the **Install app** button in the hero/dashboard (it appears
  when the browser fires `beforeinstallprompt`) or the browser's own install icon in the address bar.
- **Install on iOS Safari:** iOS never fires the prompt event — use **Share → Add to Home
  Screen** (the site shows this hint line on iPhones). Requires HTTPS or localhost serving.
- **Service worker caching behavior** (`sw.js`, cache `freecoffee-v5`): precached app shell is served
  cache-first; navigations are network-first with cache fallback (so content updates when you're
  online); other same-origin GETs are runtime-cached on first fetch; cross-origin and non-GET
  requests are untouched. Bump `CACHE` when changing content — `activate()` deletes old caches
  automatically, and `skipWaiting`/`clients.claim` make updates take effect on reload.
- Served over plain `python3 -m http.server`, the SW registers on `http://127.0.0.1:*` (localhost
  is a secure context). On `file://` the registration is skipped by design.
- **Storage:** the demo persists to `localStorage` key **`freecoffee:v1`**. If an older demo wrote
  state under its previous key, it is migrated into `freecoffee:v1` on first load and the old key
  is removed. Removing `freecoffee:v1` resets the demo.

## The payout model (summary)

- **Base share:** 65% of auction revenue, always on — publicly committed to 70% once platform
  revenue passes $50k/month.
- **Click bonus:** $0.05 per verified click (≥10s after the impression, ≥2s dwell). Caps:
  max 5/day and ≤25% of verified monthly impressions.
- **Tiered earnings floor on user earnings:** $4.00 CPM-equivalent Tier 1 (US, CA, UK, CH, EEA),
  $2.50 Tier 2 (AU, NZ, JP, KR, SG, AE), $1.25 Tier 3 (rest of world).
- **Referrals:** 10% of referee base earnings for 12 months, gated on ≥60 verified minutes in the
  referee's first 30 days.
- **Streak:** +1% per 5 consecutive active days (≥30 verified min/day), cap +10%.
- **Payouts:** $2 minimum, 24-hour rail, instant stablecoin option, no fees — rails subject to
  provider availability.
- **Transparency:** every ledger row shows the winning bid and your exact cut.
- **Sustainability (displayed as-is):** margin ≈27% at $6 CPM, ≈20% at $2 CPM, break-even ≈$0.70 CPM.
  Worked example: 1,000 impressions @ $6 CPM = $6.00 → user base $3.90 → bounded bonuses ≤$0.55 →
  platform keeps ≥ ~$1.55.

No competitor comparisons appear anywhere on the site or in copy — the product stands on its own
published economics: the 65%→70% ratchet, the $2 payout floor, and the tier floors.

## Connecting real advertisers

FreeCoffee has a pluggable ad-feed contract: when you obtain **any** real ad campaign — an affiliate
feed, an offerwall, or a direct sponsor — it plugs in by pasting **one HTTPS URL**. No rebuild, no
backend, no code changes. Campaigns from the feed render with a **LIVE** marker in the menu bar,
on the dashboard, and on the landing demo; the honest labels say what is true: live campaigns are
*connected*, but their **earnings settle once the platform backend is live** — they never inject
anything into the simulated demo ledger.

### The feed contract

A feed is any HTTPS URL returning a JSON array of campaigns:

```json
[
  {
    "id": "camp_001",
    "sponsor": "Acme Coffee Co.",
    "tagline": "Single-origin beans — 20% off first bag",
    "clickUrl": "https://advertiser.example/offer?utm_source=freecoffee",
    "cpm": 6.0,
    "logoText": "AC",
    "accent": "#C98F4E"
  }
]
```

| Field | Type | Rules |
|---|---|---|
| `id` | string | Unique, max 40 chars; duplicates dropped. Optional (falls back to array position). |
| `sponsor` | string | Brand name, trimmed, max 40 chars. **Required** — entries without it are skipped. |
| `tagline` | string | One line of creative, trimmed, max 90 chars. Optional. |
| `clickUrl` | string | Must be `https://`. Anything else is dropped; the campaign renders linkless. |
| `cpm` | number | What the platform earns per 1,000 verified minutes. Coerced, clamped 0–100. |
| `logoText` | string | 1–2 char monogram. Optional (initials derived from the sponsor name). |
| `accent` | string | Optional `#RRGGBB` tile color; invalid values fall back to the default caramel. |

Validation is identical on both clients (web: `assets/js/demo.js → fetchLiveCampaigns`; Mac app:
`config.json → adFeedURL`): 8-second timeout, https-only URLs, trimmed/capped strings, deduped by
`id`, capped at **20 campaigns**, invalid entries skipped — and a failed feed always falls back to
the fictional demo sponsors without touching earnings math.

### Where real campaigns come from (three realistic channels, ranked)

1. **Affiliate feeds** — networks like **Impact** or **PartnerStack** expose offer feeds / APIs you
   can transform into the JSON shape above with a small script hosted anywhere. Fastest route to a
   real, varied inventory; you pick offers that fit a menu-bar audience.
2. **Offerwall APIs** — **BitLabs**, **TapResearch**, and similar offerwall APIs return JSON offer
   lists (surveys, app trials) with payout rates; map their fields to the contract (`cpm` ← their
   payout rate) and the bridge does the rest.
3. **Direct sponsors** — coffee brands are the natural pitch: a roaster's "20% off your first bag"
   chip in the menu bar of people who literally measure their day in cups. One sponsor, one JSON
   file on their CDN — the pitch page is [`advertisers.html`](advertisers.html).

### The self-serve flow (advertisers.html)

The **Advertise › Campaigns** page (`advertisers.html`) is the pitch + onboarding in one: the hero,
how review works, the copyable feed spec, the honesty box, and the pricing card (auction CPM with
the published tier floors, $15 minimum campaign spend, 65% to the user). The flow: host the JSON
anywhere HTTPS (GitHub raw, your CDN, your server) → paste the URL into **Profile › Ad feed URL**
(Test button verifies it) → campaigns appear in the menu bar and dashboard. Email
`advertisers@freecoffee.tech` for the review step — every campaign is human-reviewed before it can
reach other users.

### Honesty note (read this before pitching)

**The feed bridge is live today; payment collection and advertiser-facing reporting are not.** The
client counts impressions/clicks locally (demo accounting on simulated numbers) and we do not
pretend otherwise: no fabricated delivery dashboards, no invoices until the platform backend and
payment rails exist. What you can honestly demo today is the full placement experience — your
brand rotating in the menu bar, LIVE-marked everywhere, with the exact verification rules the
production platform will bill on.

## Demo-data honesty

- All sponsors are fictional: **Northline, Ledgerly, Fernhill Coffee, Breeze VPN, Kite Studio**.
- All bids, balances, clicks, and payouts are **simulated**. No real money moves; the payout button
  is explicitly labeled as a simulation.
- The seeded ledger is deterministic (mulberry32, seed 42): `require('./assets/js/demo.js').generateHistory()`
  returns identical output every run — timestamps are anchored to a fixed demo epoch. Lifetime is
  **$28.55** and available + pending = lifetime, always.
- No analytics, no network calls, no third-party code anywhere in this folder.


## Going live for real money

The site above stays a demo forever unless you flip one switch: the
**production backend** in [`backend/`](backend/README.md) — a Cloudflare
Worker + KV on the free plan that serves the validated feed (`/feed.json`),
records impressions/clicks (`/track`), and settles a **real** per-device
earnings ledger (`/earnings/{deviceId}`). Money math is server-side only;
the client reports `minutes` + `type` and nothing else.

**Honest separation, everywhere:** the REAL EARNINGS (backend) panel on the
dashboard appears **only** when Profile → BACKEND API URL is set, shows only
what the Worker actually recorded, and is labeled as separate from the
simulated ledger. Empty URL = 100% offline demo; nothing ever leaves the
browser. The two ledgers never mix.

The account checklist — Cloudflare (free), a KV namespace, `ADMIN_TOKEN`,
one free ad network, the optional CI token — with exact click-paths lives in
[`backend/ACCOUNT-CHECKLIST.md`](backend/ACCOUNT-CHECKLIST.md). Deployment
details (Workers Builds "Connect to Git" with zero tokens, or the included
`.github/workflows/deploy-backend.yml` with `CLOUDFLARE_API_TOKEN`) are in
[`backend/README.md`](backend/README.md).

## Cold start: zero users, zero advertisers — the honest plan

The honest position today is **0 paying campaigns, 0 settled dollars** — and the site says so on the
landing ("Day zero"), on `advertisers.html` ("Live network status / 0 live campaigns"), and on
`campaigns.html` (no campaign rows). No staged counters, no seeded "X users joined" claims. The
counter moves the day a real campaign clears review, by hand, with a reference. This is the plan to
make that day come faster — each item is a channel, not a guess.

1. **Sell the first 10 advertisers, not impressions.** `advertisers.html#launchOffer` waives the
   $15 minimum and the platform cut on the first $100 for the first 10. Prospect list to work by
   hand (email `advertisers@freecoffee.tech` is already on the page): indie macOS app makers
   (they're your natural audience — they ship on Macs), developer-tool SaaS, coffee/desk brands,
   and any brand already buying menu-bar or desktop placements elsewhere (proven buyers of this
   exact format). Each gets a two-minute pitch: "menu bar, 1 minute, your CPM, your dashboard — 0
   competition today because the room is empty."
2. **Ship the universal DMG + Homebrew tap before pitching.** `app/build.sh` now builds
   arm64+x86_64 with a `/Applications` link in the DMG; a `v1.1.0` release makes the download
   buttons real. Nothing converts a sponsor faster than a working install.
3. **Deploy the backend (30 minutes, free):** follow `backend/ACCOUNT-CHECKLIST.md` exactly —
   Cloudflare Worker + KV + `ADMIN_TOKEN`. Once `/feed.json` and `/earnings/{deviceId}` are live,
   "your campaign went live" is a curl, not an engineering promise.
4. **First-slot bait:** when the first paid campaign clears review, the honest network counters
   (index `#netCount`, advertisers `#liveCount`) flip from 0 to 1 — that's the "auction is filling"
   signal every subsequent prospect and user sees on the live site. Say exactly "the first campaign
   went live", never "N users joined".
5. **User-side cold start is by design:** $2 minimum, 24-hour rail, 65%→70% ratchet, and referral
   terms are all published *before* the auction fills. The install pitch is "lock in the rules;
   earnings start the day campaign #1 clears review." No fake day-one income.

Anti-patterns this repo actively refuses: seeding fake campaign rows, freezing the demo ledger as
"real earnings", showing "X advertisers joined" counters, or prepending house ads to `/feed.json`
(that minted an unsustainable liability — a fictional CPM on the real ledger). The ledger only ever
contains verified placements from campaigns that actually exist.

## Hosting & domain

- **Live:** https://freecoffee.tech (GitHub Pages, branch `main`, root; repo
  CNAME = `freecoffee.tech`) — also https://ayodhyamohanthy.github.io/freecoffee/
  and https://freecoffee-at0.pages.dev/ (Cloudflare Pages mirror)
- **Mac app download:** https://github.com/ayodhyamohanthy/freecoffee/releases/latest/download/FreeCoffee.dmg
- **Custom domain status:** DNS lives at the registrar (orderbox-dns, not
  Cloudflare). Required records at the registrar: apex `A` → `185.199.108.153`,
  `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (replace the old
  Framer `31.43.160.6` / `31.43.161.6`), and `CNAME www → ayodhyamohanthy.github.io`.
  GitHub issues + auto-renews the `_github-pages-challenge-ayodhyamohanthy`
  TXT while Pages is configured for the domain. MX (`zoho.in`), SPF, and the
  Zoho verification TXT are untouched. The Framer waitlist page that
  previously served the apex is retired; the app's join-waitlist surface
  replaces it.
- The PWA uses only relative paths, so it runs at any host/subpath unchanged.
