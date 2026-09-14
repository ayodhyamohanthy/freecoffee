#!/bin/bash
# ============================================================================
# sync-dist.sh — publish the public site + install docs to freecoffee-dist.
#
# The dev repo (this one) is private. The public dist repo
# (ayodhyamohanthy/freecoffee-dist) carries ONLY:
#   index.html + the other 9 pages, assets/, sw.js, manifest.webmanifest,
#   CNAME, app/Info-howto.md (dev-only sections stripped — see PATCHES
#   below), feeds/, and a generated README.md.
#
# No Swift, no Worker, no workflows, no internal docs, no secrets.
#
# Usage:
#   ./sync-dist.sh            # test.sh must pass, then copy + push to dist
#   ./sync-dist.sh --check    # exit 1 if dist would change (CI guard)
#
# Info-howto.md is the one file that differs between repos: the dev copy
# documents building from source, which is meaningless without the source.
# PATCHES below applies exact-match replacements to the dist copy and FAILS
# LOUDLY if the source text drifts, so the public copy can never silently
# rot (no sed regexes — exact strings only).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

DIST_REPO="ayodhyamohanthy/freecoffee-dist"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

SITE_FILES="index.html dashboard.html payouts.html model.html campaigns.html
  profile.html referrals.html advertisers.html agents.html install-guide.html
  manifest.webmanifest sw.js"
# CNAME lives in dist permanently (copied on first sync); it is intentionally
# NOT in SITE_FILES — the custom domain must survive even if the dev tree
# has no CNAME file.

echo "==> [1/4] test.sh must pass before anything ships"
./test.sh >/dev/null || { echo "ERROR: test.sh failed — dist not synced" >&2; exit 1; }
echo "    test.sh green"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/freecoffee-dist.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
if ! gh repo clone "$DIST_REPO" "$WORK/dist" -- --depth 1 >/dev/null 2>&1; then
  echo "ERROR: cannot clone $DIST_REPO (create it first: gh repo create freecoffee-dist --public)" >&2
  exit 1
fi

echo "==> [2/4] copying public files"
# shellcheck disable=SC2086
cp $SITE_FILES "$WORK/dist/"
mkdir -p "$WORK/dist/assets" "$WORK/dist/app" "$WORK/dist/feeds"
cp -R assets/css assets/js assets/icons "$WORK/dist/assets/"
cp app/Info-howto.md "$WORK/dist/app/"
cp feeds/*.json "$WORK/dist/feeds/"
cp dist-assets/README.md "$WORK/dist/README.md"

echo "==> [3/4] stripping dev-only sections from app/Info-howto.md"
python3 - "$WORK/dist/app/Info-howto.md" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()

patches = [
  # (exact source text, dist replacement)
  ("Open Anyway override) on every machine the DMG is moved to. Anyone can verify\n"
   "this themselves by rebuilding from `FreeCoffeeMenuBar.swift`, which is a single\n"
   "readable file.",
   "Open Anyway override) on every machine the DMG is moved to. The app requests\n"
   "no private permissions at all — see Privacy below."),
  ("## Build from source / remove",
   "## Remove"),
  ("- Build everything (binary, icons, bundle, DMG): `cd freecoffee/app && ./build.sh`\n"
   "  (artifacts land in `app/dist/`; the bare `app/FreeCoffeeMenuBar` binary is kept for dev runs).\n",
   ""),
]
for old, new in patches:
    if old not in src:
        print("ERROR: Info-howto.md patch target drifted (not found):\n%s" % old[:120], file=sys.stderr)
        sys.exit(1)
    src = src.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(src)
print("    3 patches applied")
PY

echo "==> [4/4] pushing to $DIST_REPO"
if [ -z "$(git -C "$WORK/dist" status --porcelain)" ]; then
  echo "    dist already up to date — nothing to push"
  exit 0
fi
if [ "$CHECK" = "1" ]; then
  echo "ERROR: --check: dist would change:" >&2
  git -C "$WORK/dist" status --porcelain >&2
  exit 1
fi
git -C "$WORK/dist" add -A
git -C "$WORK/dist" -c user.name="freecoffee-sync" -c user.email="sync@freecoffee.tech" \
  commit -m "Sync public site from dev repo ($(git rev-parse --short HEAD))" --quiet
git -C "$WORK/dist" push origin HEAD:main --quiet
echo "    pushed to $DIST_REPO"
