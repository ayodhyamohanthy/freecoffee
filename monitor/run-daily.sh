#!/bin/bash
# Daily wrapper: runs watcher, logs outcome, writes FAILURE flag on error (picked up by dashboard/next digest)
DIR="$(cd "$(dirname "$0")" && pwd)"
if "$DIR/watcher.sh" >> "$DIR/watch.log" 2>&1; then
  rm -f "$DIR/FAILURE"
  echo "$(date -u +%FT%TZ) OK" >> "$DIR/run-history.log"
else
  echo "$(date -u +%FT%TZ) FAILED — sponsorbar.io/download unreachable or format changed. Manual fallback: open https://sponsorbar.io/download in a browser, note DMG version, append to ledger.jsonl" > "$DIR/FAILURE"
  echo "$(date -u +%FT%TZ) FAILED" >> "$DIR/run-history.log"
fi
