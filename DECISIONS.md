# FreeCoffee decisions

The founder's recorded decisions and rules for this project. Read this and AGENTS.md at the start of every session. Rules 7-9 in AGENTS.md (free-or-earning-only money rule, read decisions first, recommend better but never override) apply to everything here.

Add a dated line whenever the founder makes or changes a decision. Newest last.

- 2026-09-16: Site structure rebuilt to the reference layout; ad frame matched to the founder's reference screenshot.
- 2026-09-21: Demo withdrawal minimum is $10 (deliberate).
- 2026-09-22: Ad surface is compact text in unused macOS menu-bar space, shown only in categories the user chose.
- 2026-10-15: FreeCoffee is priority 3, after SkipWait and Swap.
- 2026-10-16: Free or money-earning options only; never pick money-spending ones (rule 7).
- 2026-10-16: Read decisions at session start; recommend better approaches, never override (rules 8 and 9).
- 2026-10-22: Proof rule. Nothing is reported done, ready or verified without proof the founder can see: a screenshot, or log/output from a real test run, shown before handover. Anything without proof is labeled "unverified".
- 2026-10-22: Full-stack verification rule. Before saying done, run the real flow end to end (UI, API, data, deploy) and show proof. Shared test accounts, when one exists for this project, are for every agent to sign in and exercise the flows. Never put passwords in the repo or chat; fetch them from the vault. FreeCoffee sign-in is GitHub or Google only, so it has no shared test account yet; none is recorded here.

## 2026-10-27 — The site publishes .well-known/security.txt (RFC 9116)

The site takes payments (Razorpay / PayPal) and runs a Worker backend, but a
security researcher had no standard place to report to; hello@freecoffee.tech
is the support address the pages publish, so that is the contact the file
names. `.well-known/security.txt` carries Contact / Expires / Preferred-Languages
/ Canonical, Expires set a year out (2027-10-26) because RFC 9116 requires
renewal within twelve months. Two gates make the file honest rather than
merely present: `sync-dist.sh` gained the file on its SITE_FILES allowlist
(the publish surface stays an explicit decision — the same rule that stopped
a test harness reaching freecoffee.tech), and test.sh's referenced-files step
now fails loudly when the file is missing, its Contact is not the published
address, that address appears on no public page, or Expires is unparseable,
in the past, or more than a year out — so the file cannot silently rot.
Four mutations checked (Contact dropped; Expires backdated; Expires pushed to
2040; Contact renamed to an address no page publishes) — all caught, 11/0 green.
