# FreeCoffee

**Your menu bar buys the coffee.** FreeCoffee is a Mac menu-bar advertising product: advertisers
bid in a real-time auction for minute-long placements in the empty stretch of your menu bar, and
you keep a transparent share of every winning bid — enough, on the demo numbers, for the coffee
(**1 cup = $5**, so every balance also reads "≈ N cups").

This repository is a **complete local demo** — a static marketing/demo site plus a real, compiled
macOS menu-bar app. Everything runs on your machine: no backend, no frameworks, no build step for
the web layer, no CDNs, no external fonts, no npm.

> **FreeCoffee demo — simulated data. Not affiliated with SponsorBar or KickBot Inc.**

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
| `index.html` | Landing page: hero with a **live CSS/DOM mock of the macOS menu bar** (rotating sponsor chip, ticking clock, growing balance) **plus a mock of the menu-bar popover** (TOTAL BALANCE block with cups hint, caramel boost line, 7-day bar chart, footer buttons), how-it-works, FreeCoffee-vs-SponsorBar comparison, the privacy data boundary, FAQ. |
| `dashboard.html` | App-shell page (**Earn › Overview**). Sidebar + breadcrumb shell, balance stat card (Total **$28.55** "≈ 5 cups", Available, Pending, This week, payout-progress toward the $2 minimum), a 14-day SVG area chart (caramel line, y-grid, dotted markers), the full ledger with winning bids and exact cuts, an "Action required" panel, a "Recent sponsors" list, and the live payout simulator. Dismissible Setup-guide and promo cards in the sidebar. `localStorage` key: `freecoffee:v1`. |
| `payouts.html` | App-shell page (**Earn › Payouts**). The payout model in plain numbers: lever table, honesty policy, sustainability math (worked example), anti-fraud controls, payout rails. |
| `profile.html` | App-shell page (**Account › Profile**). Wide Account form (display name, email, coffee preference, email prefs → saved with a toast to `freecoffee:v1`) plus Payout account (Not set up + Set up), Connected Mac (green Connected pill, "This Mac · macOS 26", Unlink with confirm), and AI agents (Copy setup prompt → clipboard). |
| `referrals.html` | App-shell page (**Earn › Referrals**). Referral link card (URL + Copy → clipboard), rewards cards, a 3-stat row (referred users **2** / referral earnings **$2.82** / next tier), and the referee table from the seeded ledger. |
| `assets/js/demo.js` | Seeded PRNG (mulberry32, seed 42), history generator, projection math, cups helper, menu-bar demo + popover mock cycler. Also CommonJS-exported — `node` can `require` it. |
| `assets/js/dashboard.js` | Dashboard rendering + interactions. All dynamic strings go through `textContent`/`createElement` — no `innerHTML` with dynamic data. |
| `assets/css/styles.css` | The whole design system: espresso darks, coffee-gold `#E0A93E` family, the app-shell (sidebar / breadcrumb / cards), popover panel, forms, tables, chips, toggles, sliders, toasts, the menu-bar mock, responsive stacking, `:focus-visible`, `prefers-reduced-motion`. |
| `manifest.webmanifest` + `sw.js` | The PWA layer: installable manifest (standalone display, `#E0A93E` theme) and the service worker that precaches all five pages. See **PWA — installable web app** below. |
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
  **About FreeCoffee demo**, **Quit FreeCoffee**.
- Earning ticks up $0.01 every 90 s while your Mac is awake.
- Persists `{balance, today, paused, disabled, snoozeUntil, history, lastTick}` to
  `~/Library/Application Support/FreeCoffee/ledger.json` (created on first run; delete it to reset).
- Privacy: the app collects nothing — no screen, file, keystroke, or window-title access. The only
  signals it touches are awake/asleep state and its own timers. See the comment block at the top of
  `FreeCoffeeMenuBar.swift`.

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

- **What works offline:** all five pages (`index.html`, `dashboard.html`, `payouts.html`,
  `profile.html`, `referrals.html`), the stylesheet, both scripts, and the icons are precached at
  install. The seeded demo engine is deterministic, so the dashboard renders identically offline;
  the payout simulator, ledger, chart, profile form, and pause/payout interactions all work with
  no network.
- **Install on desktop Chrome/Edge:** the **Install app** button in the hero/dashboard (it appears
  when the browser fires `beforeinstallprompt`) or the browser's own install icon in the address bar.
- **Install on iOS Safari:** iOS never fires the prompt event — use **Share → Add to Home
  Screen** (the site shows this hint line on iPhones). Requires HTTPS or localhost serving.
- **Service worker caching behavior** (`sw.js`, cache `freecoffee-v1`): precached app shell is served
  cache-first; navigations are network-first with cache fallback (so content updates when you're
  online); other same-origin GETs are runtime-cached on first fetch; cross-origin and non-GET
  requests are untouched. Bump `CACHE` to `freecoffee-v2` when changing content — `activate()`
  deletes old caches automatically, and `skipWaiting`/`clients.claim` make updates take effect on
  reload.
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

SponsorBar comparisons on the site use only figures observed on sponsorbar.io, Sep 2026. SponsorBar's
base share is not published and is never quoted or compared against — there is no "we pay more" claim.

## Demo-data honesty

- All sponsors are fictional: **Northline, Ledgerly, Fernhill Coffee, Breeze VPN, Kite Studio**.
- All bids, balances, clicks, and payouts are **simulated**. No real money moves; the payout button
  is explicitly labeled as a simulation.
- The seeded ledger is deterministic (mulberry32, seed 42): `require('./assets/js/demo.js').generateHistory()`
  returns identical output every run — timestamps are anchored to a fixed demo epoch. Lifetime is
  **$28.55** and available + pending = lifetime, always.
- No analytics, no network calls, no third-party code anywhere in this folder.


## Hosting & domain

- **Live:** https://ayodhyamohanthy.github.io/freecoffee/ (GitHub Pages, branch `main`, root)
- **Mac app download:** https://github.com/ayodhyamohanthy/freecoffee/releases/latest/download/FreeCoffee.dmg
- **Custom domain (freecoffee.tech):** not registered yet. Once registered: add the zone to
  Cloudflare → either connect a custom domain to Pages project `freecoffee` (freecoffee-at0.pages.dev,
  already created) or add a CNAME `@ → ayodhyamohanthy.github.io` in GitHub Pages settings and
  enforce HTTPS. The PWA uses only relative paths, so it runs at any host/subpath unchanged.
