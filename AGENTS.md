# AGENTS.md — System Operating Manual for AI Engineers

This document governs all AI-driven contributions, refactors, and terminal executions in this repository. Read and follow these principles strictly before inspecting or altering any code.

---

## 1. Prime Directives (Non-Negotiable)

1. **Surgical Diffs Over Rewrites:** Never rewrite whole files when a localized function change suffices. Preserve existing formatting, imports, and non-targeted utilities.
2. **Deterministic Schemas:** Treat the ad-feed contract, the KV record shapes, and the `/track` payload as strictly typed contracts. Never assume optional fields or mutate schemas without explicit instruction. The human-readable contract is in `README.md` and `advertisers.html#contract`; the **executable** one is the validator in `backend/src/worker.js` — when they disagree, the validator wins and the docs are the bug.
3. **Fail Fast & Loud:** Do not swallow errors in empty `catch` blocks or return mock objects silently. Every failure must produce readable logs with error boundaries or structured responses.
4. **Zero Package Hallucinations:** **There is no root `package.json`, no `tsconfig.json`, no `node_modules`, no bundler, and no npm dependency for the web layer.** Do not add one, and do not import a library that would require one. `backend/package.json` exists solely to declare `wrangler` as a devDependency.
5. **No Regressions on Working Code:** Run the suites in §4 before declaring an issue resolved.
6. **Say What Is True.** This repository's most expensive past bugs were not crashes — they were **the product misdescribing itself**: advertising a payout rate the code did not pay, and shipping docs that named a palette no longer present in the stylesheet. Green tests prove internal consistency, **not** truthfulness. If you change a number or a behaviour, grep the copy that describes it — across `README.md`, `model.html`, `advertisers.html`, `index.html`, and the Swift popover — in the same change.

---

## 2. Tech Stack & Environment Reference

> This section was previously left as the generic template default (Next.js / Tailwind / Supabase / Prisma / Zod). **None of that applies to this repository** and must not be reintroduced.

- **Web layer:** hand-written static **HTML + CSS + vanilla JS**. No framework, no bundler, no build step, no CDN, no external fonts, no npm. Eleven pages live at the repo root.
- **Design authority:** `DESIGN.md` — the Promova midnight-magazine reskin (black `#000000` canvas on every page, white/Smoke `#f5f5f5` cards at 30px radius, one highlighter `#fff050` CTA per page). **If the code drifts from that file, fix the code, not the file.**
- **Backend:** a single **Cloudflare Worker** — `backend/src/worker.js` (ES module, `export default { fetch: handleFetch }`, routed by `pickRoute()`) plus `backend/src/pilots.js` and `backend/src/ledger.js`. Feed/config use **Cloudflare KV** (`SITE_KV`); money uses one SQLite-backed Durable Object (`LEDGER`, `LedgerAuthority`, `earnings-v1`). The deployment entry is `backend/src/entry.js`, which omits test-only exports. Plain JavaScript: no TypeScript, no framework, no ORM.
- **Mac app:** `app/` — a single-file **Swift / AppKit** menu-bar app (`FreeCoffeeMenuBar.swift`), built by `app/build.sh` via `swiftc`. There is **no Xcode project**.
- **Runtime:** Node 22 and `python3` are needed by the **test harness only**. The site itself requires neither at runtime.
- **Validation:** hand-rolled guards in `backend/src/worker.js` (`normalizeRegion`, `normalizePlatform`, the feed-contract filters). **There is no Zod — do not add it.**
- **Deployment — two independent targets; do not confuse them.** The **Worker** is
  deployed by `.github/workflows/deploy-backend.yml` on push, and that workflow
  **fails loudly when `CLOUDFLARE_API_TOKEN` is absent, on purpose** — a green run
  there means a real deploy happened. The **static site** is *not* deployed by CI at
  all: `freecoffee.tech` is GitHub Pages on the separate **public** mirror repo
  `ayodhyamohanthy/freecoffee-dist`, and the only thing that updates it is
  `./sync-dist.sh`, run by hand. **Pushing this repo publishes nothing.** See
  `README.md` → *Publishing*.

### The economics contract — `70/10/5/5/30/14`

`backend/src/worker.js` is the executable source of truth. Do not change these by accident:

| Value | Constant | Meaning |
|---|---|---|
| 70 | `USER_SHARE` | viewer share of impression revenue |
| 10 | `LAUNCH_SHARE` | platform-funded launch boost (never a cut of the 70) |
| 5 | `REFERRAL_SHARE` / `REFEREE_SHARE` | referrer / referee bonus, platform-funded |
| 5 | `CLICK_BONUS` | dollars per verified click |
| 30 | `REFERRAL_TERM_DAYS` | referral earning term |
| 14 | `REFERRAL_CLICK_DAYS` | last-click attribution window |

Any change here must be mirrored in `README.md`, `model.html`, `advertisers.html`, and the Mac popover copy. **Grep for the number before you touch it.**

---

## 3. Architecture & File Layout Conventions

Follow the real boundaries below; do not create arbitrary top-level folders:

```text
├── *.html                  # 11 hand-written pages — no build step
├── assets/                 # PUBLISHED WHOLESALE — see the allowlist note in §4
│   ├── css/styles.css      # the entire design system, one file
│   ├── js/demo.js          # seeded PRNG demo engine; also CommonJS-exported for node
│   ├── js/dashboard.js     # dashboard rendering + interactions
│   └── icons/              # PWA icons (icon-192/512, maskable-512)
├── sw.js                   # service worker — ASSET_V and CACHE move in lockstep
├── manifest.webmanifest
├── backend/                # Cloudflare Worker + KV (plain JS)
│   ├── src/worker.js       # routes, money math, validation — server-side only
│   ├── src/pilots.js       # founding-pilot state machine
│   ├── wrangler.toml       # name / main / account_id / KV binding
│   └── test.mjs            # assertion groups
├── app/                    # Swift/AppKit menu-bar app (no Xcode project)
├── tests/                  # dependency-free regression suites (.cjs)
├── feeds/                  # demo feed JSON
├── launch/                 # launch + marketing copy
├── sync-dist.sh            # the ONLY thing that publishes to freecoffee.tech
├── dist-assets/            # README template for the public dist mirror
└── DESIGN.md               # design authority
```

### Three invariants that are easy to break

1. **Asset versions move together.** `?v=N` in every HTML asset URL ↔ `sw.js` `ASSET_V` ↔ `CACHE`. A mismatch silently breaks the precache and offline first loads. The *Asset version pairing* check in `test.sh` enforces the pairing and the `APP_VERSION` floor. (Named, not numbered, on purpose — step numbers shift as checks are added.)
2. **Money math is server-side only.** An enrolled client reports `{deviceId, type, campaignId, minutes, platform, region, receiptId}` with its device bearer credential. Tracking additionally needs an administrator-authorized bounded receipt; see `backend/SECURITY-LEDGER.md`. Never compute, trust, or accept a client-supplied amount.
3. **The two ledgers never mix.** The seeded demo ledger (`localStorage` key `freecoffee:v1`) and the real backend ledger are separate. The REAL EARNINGS panel appears only when a backend URL is configured, but the existing demo is not enrolled and its real tracking now fails closed. A backend URL is not payout readiness.

---

## 4. Verify before you claim

```bash
./test.sh                                                   # 12 checks
cd backend && node --check src/worker.js && node test.mjs    # backend groups
REQUIRE_BROWSER=1 bash test.sh                              # force the browser check to fail instead of skip
./sync-dist.sh --check                                      # would the live site change?
```

`./test.sh` runs **twelve numbered checks**; the twelfth is the optional
real-browser step, which SKIPs wherever Chrome cannot be driven. The step numbers
print themselves, so a run showing one more step than the total (`13/12`) means
`TOTAL_STEPS` in `test.sh` has gone stale. Two of those checks
(`tests/public-regressions.cjs`, `tests/state-regressions.cjs`) sat unwired for a
while and never ran — **if you add a suite under `tests/`, wire it into `test.sh`,
or it does not exist.**

Environment notes learned the hard way:

- **The browser step no longer hangs forever, but a sandbox still cannot verify anything.**
  It is capped by `BROWSER_TIMEOUT` (default 120s) and a timeout counts as a **SKIP**,
  not a pass. `REQUIRE_BROWSER=1` turns that timeout into a failure. Read a skip as
  **inconclusive — never as verification.**
- The git credential store may be locked by a stale `~/.git-credentials.lock`, making
  `git fetch`/`push` report `unable to get credential storage lock` even for read-only
  operations. Override the helper for that command; **do not delete files in `$HOME`**
  to work around it. Note `git ls-remote` can still print the correct ref *after* that
  error — read stdout, not the exit code.
- `app/TemporaryDirectory.*` directories are build residue that a blanket `git add -A`
  swept into the repo. **Do not commit more of them**; they are in `.gitignore` now.
- **`assets/` is a published directory.** `sync-dist.sh` copies it wholesale, so a test
  harness, scratch file, or source map dropped there would ship to freecoffee.tech by
  default. An allowlist in `sync-dist.sh` now refuses to publish anything not listed —
  if it stops you, that is the guard working, not a bug.
