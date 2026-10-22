# FreeCoffee

**Your Mac status area buys the coffee.** FreeCoffee is a Mac status area advertising product: advertisers
bid in a real-time auction for minute-long placements in the empty stretch of your Mac status area, and
you keep a transparent share of every winning bid — enough, on the demo numbers, for the coffee
(**1 cup = $5**, so every balance also reads "≈ N cups").

This repository is a **complete local demo** — a static marketing/demo site plus a real, compiled
macOS status area app. Everything runs on your machine: no backend, no frameworks, no build step for
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
| `index.html` | Landing page: hero with a **live CSS/DOM mock of the macOS status area** (rotating sponsor chip, ticking clock, growing balance) **plus a mock of the Mac status area popover** (TOTAL BALANCE block with cups hint, caramel boost line, 7-day bar chart, footer buttons), how-it-works, the privacy data boundary, FAQ. |
| `dashboard.html` | App-shell page (**Earn › Overview**, paper inserts on a black canvas). Sidebar + breadcrumb shell, balance stat card (Total **$33.94** "≈ 6 cups", Available, Pending, This week, payout-progress toward the $10 minimum), a 14-day SVG area chart (monochrome — white line on gray fill, y-grid, dotted markers), the full ledger with winning bids and exact cuts, an "Action required" panel, a "Recent sponsors" list, and the live payout simulator. Dismissible Setup-guide ("1 of 4 complete") and dark promo cards in the sidebar. `localStorage` key: `freecoffee:v1`. |
| `payouts.html` | App-shell page (**Earn › Payouts**, paper inserts on a black canvas). Choose how you get paid: Stripe (gold gradient CTA) and Whop (orange gradient CTA) rails split by a divider — clicking marks `freecoffee:v1 → profile.payoutRail` connected (demo-only until the backend payout integration), a Balance 3-stat strip (Total/Available/Pending from the seeded ledger), and the Withdrawal history table fed by simulated `paidOut` records (empty state until the first simulated payout). |
| `model.html` | App-shell page (**Account › Payout model**, paper inserts on a black canvas). The payout model in plain numbers: lever table, honesty policy, sustainability math (worked example), anti-fraud controls, payout rails. |
| `campaigns.html` | App-shell page (**Advertise › Campaigns**, paper inserts on a black canvas). Advertiser-side management view with honest zeros (Active 0 / In review 0 / Total spend $0.00 / Impressions 0), working filter tabs (All/Running/In review/Paused/Archived + "N shown"), and the "No campaigns yet" empty state with a gold CTA to the advertiser pitch. |
| `profile.html` | App-shell page (**Account › Profile**). Wide Account form (display name, email, coffee preference, email prefs → saved with a toast to `freecoffee:v1`) plus Payout account (Not set up + Set up), Connected Mac (green Connected pill, "This Mac · macOS 26", Unlink with confirm), and AI agents (Copy setup prompt → clipboard). |
| `referrals.html` | App-shell page (**Earn › Referrals**). Referral link card (URL + Copy → clipboard), rewards cards, a 3-stat row (referred users **2** / referral earnings **$2.82** / next tier), and the referee table from the seeded ledger. The link itself is real and attributed (`?ref=<your code>`); a `REAL (backend)` line appears above the seeded numbers once a backend URL is configured. |
| `flywheel.html` | App-shell page (**Earn › Flywheel**). The growth loop as code: the five stages (capture → activate → earn → share → advertise) with the back-edge that makes it compound, your own share kit (code + attributed link + Web Share), **ten platform artifacts** (Mac .dmg · Homebrew · PWA · GitHub · AI agent/MCP · X · LinkedIn · Reddit · Hacker News · email) each labelled *attributed* or *no referrer*, three live tile counts (`—` until a backend is configured, never a fake zero), the full "what is live today / what is not" audit table, and the compounding argument. `localStorage`: `freecoffee:refcode`, `freecoffee:refcapture`. |
| `advertisers.html` | App-shell page (**Advertise › Campaigns**). The advertiser pitch + self-serve onboarding: hero, how-it-works (submit feed → review → live), the copyable feed contract JSON, the honesty box (what the client reports today vs what needs the platform backend), pricing (auction CPM, $15 minimum, 70% + 10% launch boost to the user), and the contact card (`hello@freecoffee.tech`). |
| `assets/js/demo.js` | Seeded PRNG (mulberry32, seed 42), history generator, projection math, cups helper, Mac status area demo + popover mock cycler, and the live-feed bridge (`fetchLiveCampaigns` — the AD FEED CONTRACT client). Also CommonJS-exported — `node` can `require` it. |
| `assets/js/dashboard.js` | Dashboard rendering + interactions, plus the live-campaign surfaces (banner under the balance card, LIVE rows in Recent sponsors, disconnect). All dynamic strings go through `textContent`/`createElement` — no `innerHTML` with dynamic data. |
| `assets/css/styles.css` | The whole design system: the Promova midnight-magazine palette (`--void #000000` canvas on every page, white/Smoke `#f5f5f5` cards at 30px radius, Fog `#dddddd` hairlines, highlighter `#fff050` reserved for the single primary CTA per page) plus the app-shell (sidebar / breadcrumb / cards), popover panel, forms, tables, chips, toggles, sliders, toasts, the Mac status area mock, responsive stacking, `:focus-visible`, `prefers-reduced-motion`. `DESIGN.md` is the authority for all of it — if the code drifts from that file, fix the code, not the file. |
| `manifest.webmanifest` + `sw.js` | The PWA layer: installable manifest (standalone display, `#000000` theme and background) and the service worker that precaches all eleven pages. See **PWA — installable web app** below. |
| `assets/icons/` | Generated PWA icons (192, 512, 512 maskable) — same coffee-cup generator as the Mac app icon. |
| `app/` | The Mac status area app (see below). |

## The Mac status area app

A single-file Swift/AppKit app — no Xcode project needed. `build.sh` produces the
bare dev binary **and** an installable `dist/FreeCoffee.app` + `dist/FreeCoffee.dmg`:

```bash
cd freecoffee/app
./build.sh             # swiftc build → icons → dist/FreeCoffee.app → ad-hoc sign → dist/FreeCoffee.dmg
./FreeCoffeeMenuBar    # bare dev run: "☕ FreeCoffee" appears at the top-right of your Mac status area
```

### What it does

- **Left-click** the ☕ FreeCoffee status item → an **NSPopover** matching the web reference:
  - header row (cup icon, name + subtitle, status dot **Earning** / **Waiting**),
  - divider → **TOTAL BALANCE** label + oversized mono figure + right-aligned
    available/pending + muted "≈ N cups" hint (1 cup = $5),
  - caramel boost line **"70% base + 10% launch share"** (launch bonus funded by the platform),
  - **Earnings · 7 days** inset bar chart (M T W T F S S with value labels, drawn from the
    persisted per-day history by a custom `NSView`),
  - the gray **"Tip: Hold ⌘ and drag Mac status area items to rearrange them."** line,
  - divider → footer **Settings · Snooze · Disable · Account** buttons:
    Settings opens the live dashboard (`https://freecoffee.tech/dashboard.html`),
    Snooze pauses earning for 30 minutes with a live countdown,
    Disable toggles the persisted earning kill-switch,
    Account opens the live profile page.
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
3. That's it — the ☕ status item appears at the top-right of the Mac status area.

### Launch at Login

When run from the bundle, the right-click menu has a **Launch at Login** toggle (SMAppService,
macOS 13+; the first enable may need approval in System Settings → General → Login Items &
Extensions). The bare dev binary shows the item disabled — register it manually via Login
Items instead. Details: [`app/Info-howto.md`](app/Info-howto.md).

## PWA — installable web app

The site is also a full PWA (works entirely offline after first visit — no backend anywhere).

- **What works offline:** all eleven pages (`index.html`, `dashboard.html`, `payouts.html`, `model.html`,
  `campaigns.html`, `profile.html`, `referrals.html`, `flywheel.html`, `advertisers.html`, `agents.html`, `install-guide.html`),
  the stylesheet, both scripts, and the icons
  are precached at install. The seeded demo engine is deterministic, so the dashboard renders
  identically offline; the payout simulator, ledger, chart, profile form, and pause/payout
  interactions all work with no network. A connected live feed needs the network for fresh fetches,
  but the last-fetched campaigns are cached in `freecoffee:v1` and still render.
- **Install on desktop Chrome/Edge:** the **Install app** button in the hero/dashboard (it appears
  when the browser fires `beforeinstallprompt`) or the browser's own install icon in the address bar.
- **Install on iOS Safari:** iOS never fires the prompt event — use **Share → Add to Home
  Screen** (the site shows this hint line on iPhones). Requires HTTPS or localhost serving.
- **Service worker caching behavior** (`sw.js`, cache `freecoffee-v1002012`): precached app shell is served
  cache-first; navigations are network-first with cache fallback (so content updates when you're
  online); versioned assets (`assets/*?v=N`) are stale-while-revalidate — served from cache instantly
  and refreshed in the background, so bumping `?v=` in the HTML always pulls the fresh asset; other
  same-origin GETs are runtime-cached on first fetch; cross-origin and non-GET requests are untouched.
  Bump `CACHE` **and** the `?v=` versions when changing assets — `activate()` deletes old caches
  automatically, and `skipWaiting`/`clients.claim` make updates take effect on reload.
  (`app/build.sh` also does this automatically on every DMG version bump — PWA lockstep.)
- Served over plain `python3 -m http.server`, the SW registers on `http://127.0.0.1:*` (localhost
  is a secure context). On `file://` the registration is skipped by design.
- **Storage:** the demo persists to `localStorage` key **`freecoffee:v1`**. If an older demo wrote
  state under its previous key, it is migrated into `freecoffee:v1` on first load and the old key
  is removed. Removing `freecoffee:v1` resets the demo.

## The payout model (summary)

- **Base share:** 70% of auction revenue, always on. During launch the platform additionally funds
  a 10% launch boost — promotional, never a reduction of the base share.
- **Click bonus:** $0.05 per verified click. Caps: max 5/day and ≤25% of verified monthly impressions.
- **Referrals:** 5% to the referrer and a 5% bonus to the referred user, both platform-funded on the
  referee's base earnings for the first 30 days; 14-day last-click attribution. Referral money is
  platform-side — the referee's 70% is never reduced.
- **Payouts:** $10 minimum withdrawal after a five-day pending period; payout setup unlocks at $5 in
  earnings (not a fee) — rails subject to provider availability.
- **Transparency:** every ledger row shows the winning bid and your exact cut.
- **Sustainability (displayed as-is):** with launch bonuses active at $6 CPM, the platform retains
  $0.78 per 1,000 impressions before operating costs. Worked example: 1,000 impressions @ $6 CPM =
  $6.00 → user base $4.20 (70%) → launch boost +$0.60 → referral bonuses +$0.42 (5% + 5%, platform-funded) →
  platform keeps $0.78 before costs.

No competitor comparisons appear anywhere on the site or in copy — the product stands on its own
published economics: the 70% base share with the platform-funded 10% launch boost and the $10
payout floor.

## Connecting real advertisers

FreeCoffee has a pluggable ad-feed contract: when you obtain **any** real ad campaign — an affiliate
feed, an offerwall, or a direct sponsor — it plugs in by pasting **one HTTPS URL**. No rebuild, no
backend, no code changes. Campaigns from the feed render with a **LIVE** marker in the Mac status area,
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
   real, varied inventory; you pick offers that fit a Mac status area audience.
2. **Offerwall APIs** — **BitLabs**, **TapResearch**, and similar offerwall APIs return JSON offer
   lists (surveys, app trials) with payout rates; map their fields to the contract (`cpm` ← their
   payout rate) and the bridge does the rest.
3. **Direct sponsors** — coffee brands are the natural pitch: a roaster's "20% off your first bag"
   chip in the Mac status area of people who literally measure their day in cups. One sponsor, one JSON
   file on their CDN — the pitch page is [`advertisers.html`](advertisers.html).

### The self-serve flow (advertisers.html)

The **Advertise › Campaigns** page (`advertisers.html`) is the pitch + onboarding in one: the hero,
how review works, the copyable feed spec, the honesty box, and the pricing card (auction CPM,
$15 minimum campaign spend, 70% + 10% launch boost to the user). The flow: host the JSON
anywhere HTTPS (GitHub raw, your CDN, your server) → paste the URL into **Profile › Ad feed URL**
(Test button verifies it) → campaigns appear in the Mac status area and dashboard. Email
`hello@freecoffee.tech` for the review step — every campaign is human-reviewed before it can
reach other users.

### Honesty note (read this before pitching)

**The feed bridge is live today; payment collection and advertiser-facing reporting are not.** The
client counts impressions/clicks locally (demo accounting on simulated numbers) and we do not
pretend otherwise: no fabricated delivery dashboards, no invoices until the platform backend and
payment rails exist. What you can honestly demo today is the full placement experience — your
brand rotating in the Mac status area, LIVE-marked everywhere, with the exact verification rules the
production platform will bill on.

## Demo-data honesty

- All sponsors are fictional: **Northline, Ledgerly, Fernhill Coffee, Breeze VPN, Kite Studio**.
- All bids, balances, clicks, and payouts are **simulated**. No real money moves; the payout button
  is explicitly labeled as a simulation.
- The seeded ledger is deterministic (mulberry32, seed 42): `require('./assets/js/demo.js').generateHistory()`
  returns identical output every run — timestamps are anchored to a fixed demo epoch. Lifetime is
  **$33.94** and available + pending = lifetime, always.
- No analytics, no network calls, no third-party code anywhere in this folder.


## Going live for real money

The public site remains a demo. The [backend](backend/README.md) serves a
validated public feed (`/feed.json`), while its real earnings use a separate,
transactional Durable Object. Real tracking requires a reviewed legacy migration,
administrator-verified device enrollment, a private device bearer token and an
administrator-issued bounded receipt for every event. A backend URL alone does
not enable earnings. The existing browser demo is not enrolled, and the Mac app
does not report telemetry or real earnings.

**Honest separation:** the seeded demo ledger and the real authority never mix.
The current browser real-earnings panel cannot authenticate and will show its
generic backend error rather than a real balance. No admin token belongs in the
public client. Event receipts authorize reports, not independent proof of ad views.
This is not a payout/settlement implementation. See the
[security migration runbook](backend/SECURITY-LEDGER.md) before enabling money.

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
   hand (email `hello@freecoffee.tech` is already on the page): indie macOS app makers
   (they're your natural audience — they ship on Macs), developer-tool SaaS, coffee/desk brands,
   and any brand already buying Mac status area or desktop placements elsewhere (proven buyers of this
   exact format). Each gets a two-minute pitch: "Mac status area, 1 minute, your CPM, your dashboard — 0
   competition today because the room is empty."
2. **Ship the universal DMG + Homebrew tap before pitching.** `app/build.sh` now builds
   arm64+x86_64 with a `/Applications` link in the DMG; a `v1.1.0` release makes the download
   buttons real. Nothing converts a sponsor faster than a working install.
3. **Deploy the backend (30 minutes, free):** follow `backend/ACCOUNT-CHECKLIST.md` exactly —
   Cloudflare Worker + KV feed + transactional Durable Object. Complete the security
   migration/enrollment runbook before enabling money; a healthy feed alone is not delivery proof. Once a reviewed feed is serving,
   "your campaign went live" is a curl, not an engineering promise.
4. **First-slot bait:** when the first paid campaign clears review, the honest network counters
   (index `#netCount`, advertisers `#liveCount`) flip from 0 to 1 — that's the "auction is filling"
   signal every subsequent prospect and user sees on the live site. Say exactly "the first campaign
   went live", never "N users joined".
5. **User-side cold start is by design:** $10 withdrawal minimum after a five-day pending period,
   the 70% base share plus the 10% launch boost, and referral terms are all published *before* the
   auction fills. The install pitch is "lock in the rules;
   earnings start the day campaign #1 clears review." No fake day-one income.

Anti-patterns this repo actively refuses: seeding fake campaign rows, freezing the demo ledger as
"real earnings", showing "X advertisers joined" counters, or prepending house ads to `/feed.json`
(that minted an unsustainable liability — a fictional CPM on the real ledger). The ledger only ever
contains verified placements from campaigns that actually exist.

## Hosting & domain

- **Live:** https://freecoffee.tech — GitHub Pages, but served from the **public
  mirror repo `ayodhyamohanthy/freecoffee-dist`** (`main`, root, its `CNAME` =
  `freecoffee.tech`). **This dev repo is private and has no Pages site of its
  own**, so committing or pushing here publishes nothing. See *Publishing* below.
- **Mac app download:** https://github.com/ayodhyamohanthy/freecoffee-dist/releases/latest/download/FreeCoffee.dmg
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
- Two mirrors this file used to advertise are gone and must not be re-listed:
  `ayodhyamohanthy.github.io/freecoffee/` (404 — it needs Pages enabled on this
  repo, which it never was) and `freecoffee-at0.pages.dev` (522, unreachable).

### Publishing — the only path to the live site

```bash
./sync-dist.sh            # test.sh must pass, then copy + push to freecoffee-dist
./sync-dist.sh --check    # exit 1 if dist would change; changes nothing
```

`sync-dist.sh` is the single way anything reaches https://freecoffee.tech. It
runs `test.sh`, refuses to publish any file outside an explicit allowlist of
public paths, copies the eleven pages + `assets/` + `sw.js` +
`manifest.webmanifest` + `feeds/` into a clone of `freecoffee-dist`, strips the
build-from-source sections out of `app/Info-howto.md`, and pushes. No Swift, no
Worker, no workflows, no internal docs, and no secrets cross over.

**Nothing runs it automatically.** No workflow calls it, so the public site moves
only when someone runs the script deliberately. That is why the live site can
legitimately sit several commits behind `main` — and why "the site is stale" is a
silent failure rather than a red build. If you change anything public, run
`./sync-dist.sh --check` before assuming the change is live.

Do not commit to `freecoffee-dist` directly. It is a generated mirror; a direct
commit there bypasses `test.sh` entirely and can leave the two repos disagreeing
about what the product says.

