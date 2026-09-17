# Shared agent collaboration rules

These rules apply to every model, CLI, IDE assistant, and delegated agent working in this repository. Read this file before making changes. Tools that do not discover `AGENTS.md` automatically must be instructed to load it. Shared files and explicit handoffs are the coordination channel; never assume another platform can see your conversation.

## Start and establish ownership

1. Read relevant code, project instructions, and tests. Run `git status --short`, `git diff --stat`, and `git log -5 --oneline` to establish the current baseline. Inspect diffs for your intended files without printing secrets.
2. Check the active-work table below and any handoff supplied by the user. Announce a unique session ID, task, exact files or directories, and expected verification before editing.
3. Use one coordinator for concurrent work in a shared checkout. Only that coordinator updates the active-work table. Wait for an acknowledged assignment before concurrent edits. If the coordinator is unavailable or ownership is unclear, perform read-only research or ask the user; do not assume ownership.
4. Each file has one writer at a time, including tests, generated files, lockfiles, and this file. Reading another agent's files is allowed. Request an explicit handoff to change their scope.
5. Prefer separate branches and worktrees for independent tasks when the user approves creating them. Separate worktrees prevent working-copy collisions but do not eliminate semantic conflicts. Have one integrator review overlapping changes and shared contracts.

## Active work

The coordinator records assignments before writers begin. This table is an advisory record, not an atomic filesystem lock. Do not race to claim a row. Entries remain active until their owner or the coordinator explicitly releases them; timestamps alone do not authorize takeover.

| Session ID | Task | Owned paths | Base commit | Status / last UTC update |
| --- | --- | --- | --- | --- |

## Before and during edits

- Re-read each file immediately before editing and compare it to your baseline. Check `git status` and relevant diffs again before integration. A clean working tree does not prove that the base commit has not changed.
- If unexpected changes appear, stop writing the affected files. Read the new version, identify the owner through the coordinator or user, and agree on a merged result before continuing.
- Never restore, reset, clean, checkout, delete, stash, or overwrite another agent's work to recover your own version. Do not undo unrecognized changes, even when they look unrelated or incorrect.
- Delegate disjoint scopes with explicit allowed paths, forbidden paths, shared contracts, tests, and handoff requirements. Do not duplicate delegated work. An interrupted agent may have partial edits: inspect them before reassignment.
- Agree on API shapes, monetary units and precision, business rules, persistence migrations, and feature flags before parallel frontend/backend work. Assign one owner to each shared contract. Do not silently redefine a rule to make one component pass.
- Keep patches small and task-scoped. Do not change unrelated formatting, dependencies, generated artifacts, or tests owned by another session.
- Preserve existing conventions. Do not add code comments unless requested. Never expose credentials or treat demo integrations as live functionality.

## Verification and integration

- Record baseline failures before editing. Do not hide failures by deleting tests, weakening assertions, or changing expected values without verifying the intended contract.
- Run the focused tests for changed code, then have the integrator run the combined suite after all contributing patches are present. Agent reports are evidence, not a substitute for checking the final working tree.
- Repository checks from the root:
  - `bash test.sh`
  - `REQUIRE_BROWSER=1 bash test.sh` when browser verification must not be skipped
  - `npm test --prefix backend`
  - `node assets/js/test-regressions.cjs`
  - `node tests/public-regressions.cjs`
  - `node tests/browser-regressions.cjs`
  - `bash app/test-regressions.sh` for native changes, including native typechecks
  - `node --check backend/src/worker.js` and syntax checks for changed JavaScript files
  - `git diff --check`
- There is no dedicated lint script listed in `backend/package.json`. Verify current tooling before adding or assuming a lint/typecheck command.
- Separate pre-existing failures from new failures, and label checks passed, failed, or not run. Never claim full parity or production readiness based only on mocked tests.
- Do not commit, amend, push, deploy, or create a PR without explicit user authorization. Only the designated integrator stages intended files for an authorized commit; never use a blanket stage in a shared checkout.

## Required handoff

Send the coordinator or user:

- Session ID and baseline commit.
- Changed files and the behavior actually implemented.
- Contract/schema changes, migrations, and configuration requirements.
- Exact checks run and outcomes, including baseline failures and skipped checks.
- Remaining gaps, blockers, and any unexpected external edits.
- Ownership released, or explicitly retained while blocked.

On interruption, leave a partial handoff where possible. A replacement must inspect actual files and rerun relevant checks rather than trusting a completion message. The coordinator removes released assignments only after accepting the handoff.
