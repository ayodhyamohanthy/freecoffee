#!/bin/bash
# ============================================================================
# publish-campaign.sh — post ONE real campaign to the live feed, safely.
#
# Usage:
#   ./publish-campaign.sh feeds/my-real-sponsor.json
#
# What it does:
#   1. REFUSES fixtures (qa_* ids, SAMPLE markers, example.com URLs,
#      "Your Brand" placeholders) — fictional campaigns can never reach
#      the live feed through this script (see COLD-START-OUTREACH.md).
#   2. Validates every entry with the backend's own validateCampaigns
#      (node) — all entries must survive with id + sponsor intact.
#   3. POSTs to /admin/feed with your ADMIN_TOKEN (env ADMIN_TOKEN, else
#      ~/freecoffee-admin-token.txt — never committed, never printed).
#   4. Verifies the campaign is served by /feed.json and that /stats
#      answers 200.
#
# After it prints LIVE: point the site (Profile → BACKEND API URL) and the
# Mac app (config.json → adFeedURL) at the backend, then flip the honesty
# copy (COLD-START-OUTREACH.md step 4) — counters move only because a real
# campaign exists now.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND="${BACKEND_URL:-https://freecoffee-backend.ayodhya-711.workers.dev}"
FILE="${1:-}"
[ -n "$FILE" ] || { echo "usage: ./backend/publish-campaign.sh <campaign-json>" >&2; exit 1; }
[ -f "$FILE" ] || { echo "ERROR: no such file: $FILE" >&2; exit 1; }

echo "==> [1/4] Fixture guard"
if grep -qiE 'qa_|\(SAMPLE\)|SAMPLE AD|example\.com|Your Brand|your-https-destination' "$FILE"; then
  echo "ERROR: $FILE looks like a fixture/template (qa ids, SAMPLE markers," >&2
  echo "       example.com URLs, or placeholders). Fill in the advertiser's" >&2
  echo "       real fields first — fictional campaigns never go live." >&2
  exit 1
fi
echo "    no fixture markers"

echo "==> [2/4] Validating with the backend's own rules (node)"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
VALIDATED="$(node -e '
const fs = require("fs");
import("./backend/src/worker.js").then((W) => {
  const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(raw) || !raw.length) { console.error("not a non-empty array"); process.exit(1); }
  const v = W.validateCampaigns(raw);
  if (v.length !== raw.length) { console.error("only " + v.length + "/" + raw.length + " entries survive validation"); process.exit(1); }
  for (const c of v) {
    if (!c.id || !c.sponsor) { console.error("entry lost id/sponsor"); process.exit(1); }
    console.log("  - " + c.id + " | " + c.sponsor + " | cpm " + c.cpm + (c.clickUrl ? "" : " | linkless"));
  }
});' "$FILE")" || exit 1
echo "$VALIDATED"

echo "==> [3/4] POST /admin/feed"
TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/freecoffee-admin-token.txt" ]; then
  TOKEN="$(cat "$HOME/freecoffee-admin-token.txt")"
fi
[ -n "$TOKEN" ] || {
  echo "ERROR: set ADMIN_TOKEN or save it at ~/freecoffee-admin-token.txt" >&2
  echo "       (see backend/ACCOUNT-CHECKLIST.md step 3)" >&2
  exit 1
}
RESP="$(curl -s -m 20 -X POST "$BACKEND/admin/feed" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary "@$FILE" -w '\n%{http_code}')"
CODE="$(printf '%s' "$RESP" | tail -1)"
[ "$CODE" = "200" ] || { echo "ERROR: POST failed (HTTP $CODE): $(printf '%s' "$RESP" | head -1)" >&2; exit 1; }
echo "    accepted: $(printf '%s' "$RESP" | head -1)"

echo "==> [4/4] Verifying live (/feed.json + /stats)"
FEED="$(curl -s -m 20 "$BACKEND/feed.json")"
echo "$VALIDATED" | awk -F' \\| ' '{print $1}' | sed 's/^  - //' | while read -r id; do
  [ -n "$id" ] || continue
  echo "$FEED" | grep -q "\"id\"[ ]*:[ ]*\"$id\"" \
    && echo "    LIVE in feed: $id" \
    || { echo "ERROR: $id not served back by /feed.json" >&2; exit 1; }
done
curl -s -m 20 -o /dev/null -w "    /stats: %{http_code}\n" "$BACKEND/stats"
echo
echo "LIVE. Next: site → Profile → BACKEND API URL → $BACKEND, Mac app →"
echo "config.json adFeedURL, then flip the honesty copy (day-zero → live)."
