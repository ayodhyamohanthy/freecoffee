import sys, os
sp_ver, ok, today, last, report = sys.argv[1:6]
lines = ["# FreeCoffee daily competitor digest — " + today, ""]
if ok != "true":
    lines += ["## SOURCE FAILURE", "", "sponsorbar.io/download unreachable or format changed.", "Manual fallback:", "1. Open https://sponsorbar.io/download in a browser", "2. Note the DMG version from the filename", "3. Append to ledger.jsonl:", '   {"date":"' + today + '", "version":"<ver>", "source":"manual"}', "", "Resolve within 30 minutes per runbook.", ""]
else:
    lines += ["**SponsorBar latest version:** " + sp_ver, "**Our version:** 1.1.0 (FreeCoffee)", "**Last seen before this run:** " + (last or "none (first run)"), ""]
    if sp_ver != last:
        lines += ["## NEW/CHANGED version detected: " + sp_ver, "", "Action: open https://sponsorbar.io/ and check FAQ + homepage for changes (CPM, threshold, payout speed, boost, referrals), then diff our payouts.html / model.html copy against it.", ""]
    else:
        lines += ["No version change since last run.", ""]
lines += ["## Parity snapshot (always verify)", "", "- Payout threshold: theirs $5 / ours $2", "- Payout speed: theirs weekly / ours 24h", "- Referral: theirs 5%/14d / ours 10%/12mo", "- Base share: theirs unpublished / ours 65%->70%", "- PWA: theirs none / ours full", "- Notarization: theirs yes / ours adhoc (brew path mitigates)", ""]
os.makedirs(os.path.dirname(report), exist_ok=True)
open(report, "w").write("\n".join(lines))
print("digest written:", report)
