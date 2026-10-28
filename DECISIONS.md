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
2026-10-28 (08:00 IST pass) — cafe-table.jpg was on the published allowlist but no page displays it (every img src in the 10 pages was checked; sw.js precaches no images), so it shipped 279 KB of dead weight on every cold sync. Removed from both the repo and sync-dist.sh's ASSET_FILES in the same commit, per the allowlist's own two-direction rule. Next sync-dist.sh run updates the dist repo; until then --check reports the intended drift. cafe-laptop.jpg stays byte-identical: re-encoding at q82/q75 saved only 0.5-4.4% (the source is already an optimized progressive JPEG), not worth a quality-risk re-encode.
