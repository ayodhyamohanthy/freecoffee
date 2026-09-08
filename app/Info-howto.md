# FreeCoffee menu-bar app — install & run

## Install the .app (DMG)

1. Build (or grab) the DMG: `cd freecoffee/app && ./build.sh` → `app/dist/FreeCoffee.dmg`
   (needs the Xcode command-line tools — `xcode-select --install`).
2. Open `dist/FreeCoffee.dmg` and **drag FreeCoffee into your Applications folder**.
3. **First launch only:** right-click FreeCoffee in `/Applications` → **Open** → confirm.
   Because the app is **ad-hoc signed (not notarized)**, macOS Gatekeeper blocks a
   plain double-click the first time. If you've already tripped the "cannot be
   opened" dialog, clear it via System Settings → Privacy & Security → scroll to
   the Security section → **Open Anyway**.
4. A "☕ FreeCoffee" status item appears at the top-right of your menu bar.

**Honest note:** the signature is ad-hoc, so it is *not* notarized — there is no
developer identity behind it. Gatekeeper will require right-click→Open (or the
Open Anyway override) on every machine the DMG is moved to. Anyone can verify
this themselves by rebuilding from `FreeCoffeeMenuBar.swift`, which is a single
readable file.

## What it does

1. **Left-click** the status item: the earnings popover opens —
   - header row: cup icon, **☕ FreeCoffee** + "Menu-bar advertising · demo", status dot
     **Earning** / **Waiting** / **Disabled**;
   - **TOTAL BALANCE** (oversized mono figure) with right-aligned available/pending and the
     muted **"≈ N cups of coffee"** hint (1 cup = $5);
   - the caramel **"☕ 65% base share — always on"** boost line;
   - **Earnings · 7 days** inset bar chart — weekday letters M T W T F S S with value labels,
     drawn from the app's persisted per-day history;
   - the gray **"Tip: Hold ⌘ and drag menu-bar items to rearrange them."** line;
   - footer buttons: **Settings** (opens the demo dashboard), **Snooze** (pause 30 min with a
     live countdown on the button), **Disable** (persisted earning toggle — the button becomes
     **Enable**), **Account** (opens the demo profile page).
2. **Right-click** the status item: **Pause earning** (checkmark toggle), **Launch at Login**
   (bundle only — see below), **About FreeCoffee demo**, **Quit FreeCoffee**.
3. Earning ticks up **$0.01 every 90 s** while the Mac is awake and not paused/disabled; the
   7-day chart buckets update with it.
4. State persists in `~/Library/Application Support/FreeCoffee/ledger.json` — delete that file
   and restart to reset the demo (first run reseeds to the web demo's $28.55 lifetime).
5. The demo pages it opens live at `http://127.0.0.1:8090/…` — start the server with
   `cd freecoffee && python3 -m http.server 8090`.
6. Privacy: the app collects nothing (see the comment block at the top of `FreeCoffeeMenuBar.swift`).
7. All data is simulated. FreeCoffee demo — not affiliated with SponsorBar or KickBot Inc.

## Launch at Login

Run from the bundle, the app has a menu toggle:

> menu bar → right-click ☕ FreeCoffee → **Launch at Login** (checkmark = on)

It uses SMAppService (macOS 13+). First time you switch it on, macOS may ask you
to approve the entry — System Settings → General → Login Items & Extensions, where
FreeCoffee appears once approved. If the toggle fails it shows a disabled state
("Launch at Login (unavailable)") instead of pretending to work.

The bare dev binary (`./FreeCoffeeMenuBar`, not from a bundle) shows the item disabled —
it has no bundle identity to register. For that build, add it manually:
System Settings → General → Login Items & Extensions → "+" → select `freecoffee/app/FreeCoffeeMenuBar`.

## Connecting a real ad feed (optional — config.json)

The app can show **real advertiser campaigns** instead of the fictional demo sponsors. Create
`~/Library/Application Support/FreeCoffee/config.json` pointing at any HTTPS campaign feed
(the contract is documented in the repo README and on `advertisers.html`):

```json
{
  "adFeedURL": "https://example.com/freecoffee-feed.json"
}
```

The feed itself is a JSON array of campaigns:

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

Behavior once configured:

- The feed is fetched **on launch and every 30 minutes** (8-second timeout), validated field-by-field
  (https-only `clickUrl`, trimmed/capped strings, `cpm` clamped 0–100, deduped by `id`, cap 20), and
  the last-good list is cached to `campaigns-cache.json` next to `config.json` — so the chip still
  shows campaigns offline, and deleting the cache file resets it.
- The menu-bar chip shows the current live sponsor; the popover header gains a
  **`LIVE · Sponsor — tagline`** line and the status line gains a **LIVE** marker. Campaigns rotate
  every 60 s.
- The right-click menu gains **Sponsor: … — LIVE** (opens the campaign's https `clickUrl` — https
  only, nothing else is ever opened) and **Reload campaigns** (⌘R) items.
- Any failure (no config, malformed JSON, non-https URL, fetch error) falls back to the fictional
  demo sponsors — the app never breaks, and **the earning tick and ledger are never touched**: live
  campaigns are display-only and their earnings settle once the platform backend is live.
- Remove `config.json` (or clear `adFeedURL`) to go back to the pure simulated demo.

Privacy: the configured feed URL is the app's **only** outbound request, and nothing is ever sent
back to it — no identifiers, no telemetry, no impression data. Everything else in the privacy
boundary (no screen, files, keystrokes, window titles) is unchanged.

## Build from source / remove

- Build everything (binary, icons, bundle, DMG): `cd freecoffee/app && ./build.sh`
  (artifacts land in `app/dist/`; the bare `app/FreeCoffeeMenuBar` binary is kept for dev runs).
- Remove: quit FreeCoffee from its menu, delete `/Applications/FreeCoffee.app`, delete the
  ledger at `~/Library/Application Support/FreeCoffee/` if it exists, and check
  System Settings → General → Login Items & Extensions for a leftover FreeCoffee entry.
