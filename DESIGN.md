> **Superseded for public pages (Oct 16, founder).** The founder said the site
> "doesn't look like" the reference and asked for a visible match. Public
> (`.fc-public`) pages now use: cream paper `#f7f5ee`, ink `#202521`, mint
> `#edf3f0` and teal `#e4f1f0` bands, dark ink bands, one gold action
> `#f6c944` (8px radius, 1px `#d9a92b` border), Archivo Variable headlines
> (weight 735, tracking -0.045em), 1194px container, 110px section rhythm,
> cards `#fffefa` with 1px ink border and 16px radius. The black Promova
> rules below still describe the app-shell pages (dashboard, payouts,
> profile, referrals, flywheel, campaigns, model). Never use the reference's
> name or the words "menu bar" in public copy.

# FreeCoffee DESIGN.md — Promova midnight-magazine reskin

Source lock: **Promova** (Refero style `dae5e893…`, primary) + **Hellotime**
(`dbc5ecba…`, secondary, app-shell/state discipline only). No other authority.
If implementation drifts from this file, fix the code, not the file.

## Reference lock

Primary (Promova) — preserve:
- Canvas `#000000` on EVERY page and section. No alternating section backgrounds.
- White / Smoke (`#f5f5f5`) cards with **30px radius** as the ONLY surface
  separation. Flat, no shadows, 1px Fog (`#dddddd`) hairlines at most.
- Highlighter yellow `#fff050` ONLY for the single primary CTA per page and
  small icon highlights. Never decorative fills, secondary buttons, or statuses.
- Display headlines at 40px+ in the display face, line-height 1.0, no tracking
  tweaks. Body/interface 14–20px in the text face (200 light / 500 body / 700 labels).
- 1200px max width, 80px section rhythm, 30px card padding.

Borrow only (Hellotime):
- State via weight/fill/border changes, never new hues.
- Compact UI rows may use tighter leading than marketing copy.
- One dark filled card allowed for the final conversion block.

Reject: warm cream canvas, serif display, pill buttons (999px), gradients (except
none — no gradients at all), card shadows, blue links, multi-hue statuses,
fully-rounded tags (tags are 4–6px).

## Tokens

```css
--void: #000000;   /* page canvas, everywhere */
--paper: #ffffff;  /* card inserts, primary text on black */
--smoke: #f5f5f5;  /* secondary card fill */
--ink: #0a0a0a;    /* text on white cards */
--muted-ink: #595959;
--mist: #a6a6a6;   /* secondary text ON BLACK */
--faint: #7a7a7a;  /* metadata ON BLACK */
--fog: #dddddd;    /* hairlines on black */
--fog-ink: #e2e2e2;/* hairlines on white cards */
--hi: #fff050;     /* primary CTA + icon highlights ONLY */
--on-hi: #000000;
```

Fonts (offline: webface-first stacks, system fallback — never a CDN):
```css
--font-display: "Nekst","Bricolage Grotesque","Space Grotesk","General Sans",system-ui,sans-serif;
--font-sans: "Manrope","Inter","Plus Jakarta Sans","DM Sans",system-ui,sans-serif;
--font-mono: ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace; /* data only */
```

Radius: cards 30px · buttons 20px · small buttons/inputs 10px · tags/chips 4–6px.
Elevation: none, ever. Focus ring: 2px `--hi` outline.

## Component map (existing classes, new treatment)

- `.btn-primary`, `.fc-primary` — yellow fill, black 700 text, 20px radius. One per page.
- `.btn-ghost`, secondary links — transparent, 1px Fog border, white text.
- `.card`, `.earn-panel`, `.sim-results`, tables — white paper inserts: black text,
  30px radius, Fog-ink hairlines. Numbers stay tabular mono.
- `.sidebar`, `.topbar`, `.site-nav`, `.fc-nav` — black chrome, white text.
- `.menubar`, `.pop-panel`, `.codeblock`, `.code-block pre` — product depictions:
  stay dark (near-black), yellow reserved for the chip tile monogram and copy buttons.
- Links — white, underline on hover. No blue, no gold.
- Charts — monochrome: white line/gray fill on dark, black line/gray fill on white.
- Status (`.pill-ok/.pill-warn`, `.t-*`, `.status-pill`, dots) — keep green/red hues
  ONLY here (functional, never decorative), on dark washes with text labels.
- `.fc-public em` (accent word) — yellow, non-italic, low-frequency emphasis only.
- Browser surfaces — yellow caret/focus, dark scrollbars, tabular numerals.

## Rules for agents

- Copy, IDs, JS hooks, and economics (70/10/5/5/30/14) are untouchable by a reskin.
- `?v=` in every HTML asset URL, `sw.js` ASSET_V, and CACHE move together;
  ASSET_V must stay ≥ the APP_VERSION floor (`bash test.sh` check 8 enforces this).
- `manifest.webmanifest` theme/background stay `#000000`.
- Exceptions (documented, not drift): rail brand buttons (`.btn-stripe`,
  `.btn-whop`) keep Stripe/Whop brand fills for rail recognition; status hues
  (green/red) survive ONLY on status dots, pills, and type chips with labels;
  syntax tints stay inside code wells; the macOS menubar mock keeps native
  dark chrome; remote photography keeps its moody treatment.
- Verify: `bash test.sh`, `REQUIRE_BROWSER=1 bash test.sh`, plus desktop + mobile
  screenshots of index and dashboard before handoff.
