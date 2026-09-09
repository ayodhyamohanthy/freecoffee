#!/bin/bash
# FreeCoffee daily competitor release watcher (v2)
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LEDGER="$DIR/ledger.jsonl"
STATE="$DIR/state.json"
TODAY=$(date -u +%F)
REPORT="$DIR/reports/digest-$TODAY.md"
mkdir -p "$DIR/reports"

REPLAY_DATE=""
if [ "${1:-}" = "--replay" ]; then REPLAY_DATE="${2:-}"; fi

PAGE=$(curl -sL --max-time 30 https://sponsorbar.io/download 2>/dev/null)
SPONSOR_VERSION=""
[ -n "$PAGE" ] && SPONSOR_VERSION=$(echo "$PAGE" | grep -oE 'SponsorBar-[0-9]+\.[0-9]+\.[0-9]+' | head -1 | cut -d- -f2)

STATUS_OK=true
[ -z "$SPONSOR_VERSION" ] && STATUS_OK=false

LAST=""
[ -f "$STATE" ] && LAST=$(python3 -c "import json;print(json.load(open('$STATE')).get('lastVersion',''))" 2>/dev/null)

if [ "$STATUS_OK" = "true" ]; then
  DUP=$(grep -c "\"version\":\"$SPONSOR_VERSION\",\"date\":\"$TODAY\"" "$LEDGER" 2>/dev/null || true)
  DUP=${DUP:-0}
  if [ "$DUP" = "0" ]; then
    python3 append.py "$TODAY" "$SPONSOR_VERSION" "$([ "$SPONSOR_VERSION" = "$LAST" ] && echo seen || echo new)"
  fi
fi

python3 digest.py "$SPONSOR_VERSION" "$STATUS_OK" "$TODAY" "$LAST" "$REPORT"

if [ "$STATUS_OK" = "true" ]; then
  python3 state.py "$SPONSOR_VERSION" "$STATE"
fi

echo "=== RUN SUMMARY ==="
echo "status: $STATUS_OK"
echo "version: $SPONSOR_VERSION (last: $LAST)"
[ -f "$LEDGER" ] && echo "ledger lines: $(wc -l < "$LEDGER" | xargs)"
echo "report: $REPORT"
[ "$STATUS_OK" = "false" ] && exit 1
exit 0
