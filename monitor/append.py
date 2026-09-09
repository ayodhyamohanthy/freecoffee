import json, sys, os
d = os.path.dirname(os.path.abspath(__file__))
today, version, seen = sys.argv[1], sys.argv[2], sys.argv[3]
ledger = os.path.join(d, "ledger.jsonl")
# idempotency: skip if same version+date already recorded
if os.path.exists(ledger):
    for line in open(ledger):
        try:
            e = json.loads(line)
            if e.get("version") == version and e.get("date") == today:
                print("dup skipped:", version, today)
                sys.exit(0)
        except Exception:
            pass
entry = {"date": today, "version": version, "seen": seen, "source": "https://sponsorbar.io/download"}
import urllib.request
try:
    req = urllib.request.Request("https://sponsorbar.io/", headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
    html = urllib.request.urlopen(req, timeout=30).read().decode()[:200000]
    import re
    claims = sorted(set(re.findall(r"\$[0-9]+\.[0-9]{2} Recalculated hourly|weekly payouts|34 supported countries|200\+ countries|[0-9,]+ ads viewed|10% earning boost", html)))
    entry["claims"] = claims
except Exception as e:
    entry["claims_error"] = str(e)[:80]
with open(ledger, "a") as f:
    f.write(json.dumps(entry) + "\n")
print("appended:", version, today)
