# Cold-start outreach kit

Everything you need to land the first real advertiser. Honest selling only:
the product is live, the DMG is real, the backend is real — but the campaign
feed is empty and every counter reads 0 until a real campaign clears. Say
exactly that. It is the strongest thing we have.

## Who to contact first

| Priority | Who | Why they bite |
|---|---|---|
| 1 | Indie Mac apps already buying Google/Apple search ads | They already pay $1–3 per click; $0.5–2 CPM-equivalent in-app placement is cheap reach on the same audience |
| 2 | Dev-tool / SaaS newsletters that sponsor macOS content | They want zero-CPM-hassle placements with a live link |
| 3 | Coffee gear brands (beans, grinders, desks) | Thematic fit with the FreeCoffee name; small budgets, fast decisions |
| 4 | Local cafés in your city | The tap + barcode moment is a physical-world curiosity; $50/mo pilot is nothing to them |

Keep a simple sheet: name, contact, sent date, follow-up 1, follow-up 2,
result. Ten rows is a working pipeline. Do not buy lists; DMs and short
emails only.

## The launch offer (use verbatim)

> **FreeCoffee launch offer — first advertiser terms**
> - Your campaign is the *only* campaign live for the first 30 days (100% share of voice).
> - Flat **$99 for the month** — no CPM math, no minimum impressions.
> - If the campaign serves fewer than **50,000 real impressions**, the next month is free.
> - You approve the creative and the destination URL; we review for malware/scams.
> - Cancel anytime; you get a live dashboard link showing exactly what was served.

Numbers you can say out loud:
- App: signed universal DMG, v1.1.0, ~283 KB, macOS 13+, runs from /Applications.
- Site: static GitHub Pages, SW v9 PWA, no analytics on users.
- Backend: Cloudflare Worker + KV, free tier, counters are live and public.
- Everything is honest: zero states read zero because nothing is fabricated.

## Email 1 — first contact (dev tools / Mac apps)

Subject: 1-line pitch: your product on a Mac menu bar for $99

> Hi <name>,
>
> I built FreeCoffee — a Mac menu-bar app + PWA where users watch one
> sponsor slide per session and real micro-earnings accrue to a public
> ledger. It just shipped (v1.1.4, universal DMG + release notes on
> GitHub: https://github.com/ayodhyamohanthy/freecoffee-dist).
>
> The campaign feed is intentionally empty right now — you would be the
> first and only advertiser, 100% share of voice, flat $99/month. If we
> serve under 50k real impressions, the next month is free.
>
> Worth 15 minutes? I can show the app, the tap flow, and the ledger.
>
> — <your name>

## DM variant (X/LinkedIn, indie devs)

> congrats on shipping — quick one: FreeCoffee (Mac menubar + PWA, open
> metrics on GitHub) has one launch slot for its first-ever sponsor.
> $99/mo flat, only campaign live, no CPM games. want the one-pager?

## Follow-up 1 (+3 days)

> Short bump — the first-slot offer stands for the first signed advertiser
> only. After that it's standard $2 CPM. Happy to send the DMG + a demo
> device id so you can watch a session end-to-end.

## Follow-up 2 (+7 days, final)

> Last note — closing the launch slot either way by <date>. If you're in,
> reply "in" and I'll send the campaign sheet (creative, URL, budget).

## When someone says yes — first-campaign runbook

1. Agree creative + destination URL + budget. Review for malware/claims yourself.
2. Push the campaign (edit ids/fields first — never use QA ids on live).
   Fast path: `backend/publish-campaign.sh feeds/my-real-sponsor.json`
   (fixture guard + backend-rules validation + POST + live verify). Manual
   equivalent:

   ```bash
   export ADMIN_TOKEN=$(cat ~/freecoffee-admin-token.txt)
   curl -s -X POST https://freecoffee-backend.ayodhya-711.workers.dev/admin/feed \
        -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
        --data-binary @feeds/first-campaign-template.json
   ```

   (Fill in the advertiser's real fields first. Same schema as
   `feeds/test-campaigns.json`; the server clamps cpm to 0–100, requires
   https-only click URLs, dedupes by `id`, caps at 20 campaigns.)

3. Verify it went live (the 0→1 flip):

   ```bash
   curl -s https://freecoffee-backend.ayodhya-711.workers.dev/feed.json
   ```

4. Update the honesty copy by hand in one commit (counters flip 0→1 only
   because a real campaign exists now — do it in the same commit as the
   launch announcement):
   - `index.html`: "0 slots claimed" → "1 slot claimed" (or retired copy)
   - `advertisers.html`: `#launchOffer` block + `#liveCount` copy
   - `campaigns.html`: `#netCount` note
5. Confirm `test.sh` and `backend/test.mjs` still green; commit + push.
6. Send the advertiser a link to `/feed.json` and their payout terms —
   they can watch their own campaign in the public feed.

## Hygiene rules

- Never push a fictional campaign to the live feed. QA fixtures stay in
  `backend/test/fixtures/`.
- Never edit counters without a matching real state change.
- The 50k-impressions guarantee: impressions are what KV counted
  (`counters.impressions`), not "opportunities". Quote it exactly.
- All money talk stays in email; the repo never contains advertiser PII.
