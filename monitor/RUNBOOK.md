# FreeCoffee Competitor Release Monitor — Runbook

## What this does
Every day at 09:00 IST, an AutoClaw cron job (`8bea3b47`, name "FreeCoffee competitor release watcher (daily)") runs `run-daily.sh`. It:
1. Fetches https://sponsorbar.io/download and extracts the current DMG version from the filename.
2. Appends a ledger entry to `ledger.jsonl` (idempotent — same version+date never double-records).
3. Writes a digest to `reports/digest-YYYY-MM-DD.md` with a parity snapshot.
4. On failure: creates `FAILURE` flag + failure instructions inside the digest.

## Daily operation (zero-touch)
- Open the AutoClaw 「定时」(Scheduled) panel after 09:00 — the job's output shows: their version, ours, new-version alerts.
- If a NEW version appears: open sponsorbar.io, compare their FAQ/homepage claims against our payouts.html/model.html copy, and update ours if they improved.

## Adding / removing a source
1. Open `config.json`.
2. Add/remove an object in `sources[]` (url + extract type).
3. If the new source needs different parsing, extend `append.py` (claims regex) or add a new helper — no other file changes needed.
4. Re-run `./watcher.sh` manually once to seed the ledger.

## Changing the schedule
AutoClaw App → 「定时」panel → "FreeCoffee competitor release watcher (daily)" → edit schedule. (Default: daily 09:00 Asia/Calcutta, timeout 300s.)

## Failure recovery
- Check `FAILURE` flag file in this folder — it contains the manual fallback steps.
- Source unreachable: usually transient. `./run-daily.sh` to retry immediately.
- Format changed (no version found): open their download page in a browser, read the version from the DMG filename, and append manually:
  `python3 append.py $(date -u +%F) 1.0.14 manual`
- Missed days: just run `./run-daily.sh` once per missed day (or `./watcher.sh`); the ledger dedupes, so replays never double-record (verified: 4 consecutive runs → 1 entry).

## History / export
- Ledger: `ledger.jsonl` (JSON lines, one entry per version+date). Retention: keep ≥12 months (file is tiny).
- Export: `cp ledger.jsonl ledger-export-$(date +%F).jsonl` — it's already CSV/JSON-analyzable.
- Digests: `reports/digest-*.md` (one per day).

## Rotation / security
- No secrets in this folder. ADMIN_TOKEN etc. live in Cloudflare Worker secrets (see backend/README.md).
- The cron job identity is your AutoClaw account — rotate via the App's account settings if ever needed.
