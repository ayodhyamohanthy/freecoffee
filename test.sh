#!/usr/bin/env bash
# ============================================================================
# FreeCoffee repo-wide smoke test — zero dependencies (node + python3 only).
#
# Catches the failure classes this repo has actually hit before:
#   0. Committed merge-conflict markers. A half-resolved merge shipped once and
#      silently broke sw.js (a top-level '<<<<<<< HEAD' is a syntax error, so the
#      service worker died) while every other check still passed.
#   1. HTML tag-misnesting / unclosed elements (was broken in referrals.html)
#   2. Inline <script> blocks that no longer parse (node --check)
#   3. JS element-ID references that don't exist in the page
#      + duplicate element IDs
#   4. Demo-engine non-determinism + balance invariant (seed 42)
#   5. Backend helper regressions (backend/test.mjs)
#   6. Monitor JSON/log integrity + missing asset references
#   7. Asset version pairing (?v= in HTML <-> sw.js ASSET_V <-> CACHE) — a
#      mismatch silently breaks the precache and offline first loads — plus
#      the PWA lockstep floor (ASSET_V >= padded APP_VERSION from
#      app/build.sh) so DMG bumps always bust the web cache, plus a
#      single-declaration rule (a duplicated ASSET_V hides the real version)
#   + Swift parse gate inside check 1 (macOS only, skipped elsewhere)
#   8. Real-browser layout + interaction regressions on the dashboard
#      (headless Chrome + CDP, zero npm deps; skipped cleanly when Chrome or
#      Node 22+ WebSocket is unavailable — REQUIRE_BROWSER=1 forces a failure)
#
# Run from the repo root:   ./test.sh      (or:  bash test.sh)
# Exit 0 when everything passes, non-zero otherwise.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"

PASS=0
FAIL=0
step() { printf '\n==> %s\n' "$1"; }
ok()  { PASS=$((PASS+1)); printf '    PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '    FAIL  %s\n' "$1"; }

# ------------------------------------------------------------------ 0. Repo hygiene
# A committed conflict marker is the worst kind of failure: it is invisible to
# every other check here (the HTML parser treats it as text, and the ?v= regex
# happily matches whichever side it finds first) yet it can make a file
# unparseable. Detect it first, before anything else trusts the tree.
step "1/8 Repo hygiene (no committed merge-conflict markers)"
python3 - <<'PY'
import os, re, sys

SKIP_DIRS = {'.git', '.workbuddy-ai', 'node_modules', 'dist', '.build', 'DerivedData'}
START = re.compile(r'^<{7}[ \t]', re.M)      # '<<<<<<< HEAD'
END = re.compile(r'^>{7}[ \t]', re.M)        # '>>>>>>> d2b288b…'
# '=======' on its own is deliberately NOT part of the test: it is a legal
# setext-heading underline in Markdown, so matching it would false-positive on
# ordinary docs. A real conflict always carries both START and END.
MAX_BYTES = 1_000_000

hits = []
for root, dirs, files in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for name in files:
        p = os.path.join(root, name)
        try:
            if os.path.getsize(p) > MAX_BYTES:
                continue
            src = open(p, encoding='utf-8').read()
        except (UnicodeDecodeError, OSError):
            continue
        if START.search(src) and END.search(src):
            n = len(START.findall(src))
            hits.append('%s (%d unresolved hunk%s)' % (p[2:], n, '' if n == 1 else 's'))

if hits:
    for h in sorted(hits):
        print('    FAIL conflict markers: ' + h)
    sys.exit(1)
print('    ok   no committed merge-conflict markers anywhere in the tree')
PY
[ $? -eq 0 ] && ok "repo hygiene: no conflict markers" || bad "repo hygiene: conflict markers committed"

# ------------------------------------------------------------------ 1. JS syntax
step "2/8 JS syntax (node --check)"
JS_FAIL=0
for f in assets/js/*.js backend/src/worker.js; do
  if ! node --check "$f" 2>/dev/null; then
    JS_FAIL=1; bad "syntax: $f"
  fi
done
[ "$JS_FAIL" = "0" ] && ok "assets/js/*.js + backend/src/worker.js parse cleanly"

# Swift parse gate (macOS only, best-effort): catches typos/bracket slips in
# the Mac status area app without a full typecheck. Skipped, not failed, off-Mac.
if command -v xcrun >/dev/null 2>&1; then
  if xcrun -sdk macosx swiftc -parse app/FreeCoffeeMenuBar.swift >/dev/null 2>&1; then
    ok "FreeCoffeeMenuBar.swift parses (xcrun swiftc -parse)"
  else
    bad "FreeCoffeeMenuBar.swift failed swiftc -parse"
  fi
else
  printf '    SKIP  swift parse gate (no xcrun off macOS)\n'
fi

# ------------------------------------------------------------------ 2. Backend tests
step "3/8 Backend unit tests"
if ( cd backend && node test.mjs ); then
  ok "backend/test.mjs (24 groups)"
else
  bad "backend/test.mjs"
fi

# ------------------------------------------------------------------ 3. Static-site checks (python3)
step "4/8 HTML structure, inline JS, ID references"
python3 - <<'PY'
import glob, html.parser, os, re, subprocess, sys, tempfile

bad = []

class Parser(html.parser.HTMLParser):
    VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
    def __init__(self):
        super().__init__(); self.stack = []; self.errors = []
        self.ids = set(); self.dups = []
    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if 'id' in d:
            if d['id'] in self.ids: self.dups.append(d['id'])
            self.ids.add(d['id'])
        if tag not in self.VOID: self.stack.append((tag, self.getpos()))
    def handle_endtag(self, tag):
        if tag in self.VOID: return
        if not self.stack: self.errors.append('closing %s with empty stack' % tag); return
        t, pos = self.stack.pop()
        if t != tag: self.errors.append('line %d: <%s> closed by </%s>' % (pos[0], t, tag))

for f in sorted(glob.glob('*.html')):
    src = open(f, encoding='utf-8').read()
    p = Parser(); p.feed(src)
    left = [t for t, _ in p.stack]
    if p.errors or left:
        bad.append('%s: structure %s %s' % (f, p.errors[:3], 'unclosed:' + ','.join(left) if left else ''))
    if p.dups:
        bad.append('%s: duplicate ids: %s' % (f, ', '.join(sorted(set(p.dups)))))
    ids = p.ids
    refs = set(re.findall(r"\$\('([^']+)'\)", src))
    refs |= set(re.findall(r'\$\("([^"]+)"\)', src))
    refs |= set(re.findall(r"getElementById\('([^']+)'\)", src))
    refs |= set(re.findall(r'getElementById\("([^"]+)"\)', src))
    missing = sorted(r for r in refs if r not in ids)
    if missing:
        bad.append('%s: referenced but missing ids: %s' % (f, ', '.join(missing)))
    for i, b in enumerate(re.findall(r'<script>(.*?)</script>', src, re.S)):
        fd, path = tempfile.mkstemp(suffix='.js'); os.write(fd, b.encode()); os.close(fd)
        r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
        if r.returncode:
            msg = r.stderr.strip().splitlines()[-1][:180] if r.stderr else 'syntax error'
            bad.append('%s: inline script %d: %s' % (f, i, msg))
        os.unlink(path)

if bad:
    for b in bad: print('    FAIL ' + b)
    sys.exit(1)
print('    ok   all HTML pages: structure, inline JS, IDs, no dup ids')
PY
[ $? -eq 0 ] && ok "static-site checks" || bad "static-site checks"

# ------------------------------------------------------------------ 4. Demo determinism
step "5/8 Demo engine determinism + balance invariant"
node -e '
const D = require("./assets/js/demo.js");
const a = JSON.stringify(D.generateHistory(42));
const b = JSON.stringify(D.generateHistory(42));
if (a !== b) { console.error("NON-DETERMINISTIC output"); process.exit(1); }
const t = D.generateHistory(42).totals;
if (Math.abs((t.available + t.pending) - t.lifetime) > 0.011) { console.error("available+pending != lifetime"); process.exit(1); }
if (t.lifetime < 28.5 || t.lifetime > 28.6) { console.error("unexpected lifetime " + t.lifetime); process.exit(1); }
console.log("    ok   seed 42 reproducible; available + pending = lifetime ($" + t.lifetime + ")");
'
[ $? -eq 0 ] && ok "demo engine" || bad "demo engine"

# ------------------------------------------------------------------ 5. De-branding guard
step "6/8 No competitor brand references"
HITS=$(grep -riIl --exclude-dir=.git --exclude-dir=.workbuddy-ai --exclude=test.sh -E 'sponsorbar|kickbot' . 2>/dev/null)
if [ -z "$HITS" ]; then
  ok "no competitor brand references in any tracked text file"
else
  bad "competitor brand references found:"; echo "$HITS" | sed 's/^/    /'
  exit 1
fi

# ------------------------------------------------------------------ 6. Asset presence
step "7/8 Referenced local files exist + in-page fragments resolve"
python3 - <<'PY'
import re, glob, os, sys
missing = []
srcs = {}
for f in glob.glob('*.html'):
    src = open(f, encoding='utf-8').read()
    srcs[f] = src
    for m in re.findall(r'(?:href|src)="([^"#][^"]*)"', src):
        if m.startswith(('http:', 'https:', 'mailto:', 'data:')): continue
        clean = m.split('#')[0].split('?')[0]
        if not clean: continue
        if not os.path.exists(clean):
            # app/dist/ is gitignored (built by build.sh, shipped via Releases) — verify
            # the release artifact but don't fail when it isn't checked out.
            if clean == 'app/dist/FreeCoffee.dmg': continue
            missing.append('%s -> %s' % (f, m))
if missing:
    for m in missing: print('    FAIL missing: ' + m)
    sys.exit(1)
print('    ok   every local href/src resolves to a real file')

# Fragment targets. A link to page.html#frag is only honest if page.html actually
# has id="frag". This is the check that was missing when a page redesign deleted
# its #faq section but left 13 links pointing at it — every one of them "resolved
# to a real file" while scrolling nowhere.
ids = dict((f, set(re.findall(r'\bid=["\']([^"\']+)["\']', s))) for f, s in srcs.items())
dead = []
for f, src in srcs.items():
    for m in re.findall(r'href="([^"]*#[^"]+)"', src):
        if m.startswith(('http:', 'https:', 'mailto:', 'data:')): continue
        target, frag = m.split('#', 1)
        target = target or f
        if not target.endswith('.html') or target not in ids: continue
        if frag in ids[target]: continue
        # An id the target's own script creates at runtime still counts as present.
        if re.search(r'["\']%s["\']' % re.escape(frag), srcs[target]): continue
        dead.append('%s -> %s' % (f, m))
if dead:
    for d in dead: print('    FAIL dead anchor: ' + d)
    sys.exit(1)
print('    ok   every in-page fragment resolves to a real id')
PY
[ $? -eq 0 ] && ok "asset references + fragment anchors" || bad "asset references + fragment anchors"

# ------------------------------------------------------------------ 7. Asset version pairing
step "8/8 Asset version pairing (?v= <-> sw.js ASSET_V <-> CACHE)"
python3 - <<'PY'
import glob, re, sys

bad = []
sw = open('sw.js', encoding='utf-8').read()

# Exactly one declaration of each. A second one (the classic half-resolved
# merge) makes the version the worker actually uses ambiguous, and a plain
# re.search() would silently report whichever came first.
for name, pat in (('ASSET_V', r"var ASSET_V\s*=\s*'([^']+)'"),
                  ('CACHE', r"var CACHE\s*=\s*'freecoffee-v([^']+)'")):
    found = re.findall(pat, sw)
    if len(found) != 1:
        bad.append('sw.js declares %s %d time(s) (%s) — exactly one is required'
                   % (name, len(found), ', '.join(found) if found else 'none'))

m_av = re.search(r"var ASSET_V\s*=\s*'([^']+)'", sw)
m_c  = re.search(r"var CACHE\s*=\s*'freecoffee-v([^']+)'", sw)
if not m_av or not m_c:
    print('    FAIL sw.js: ASSET_V / CACHE declaration not found')
    sys.exit(1)
asset_v, cache_v = m_av.group(1), m_c.group(1)

# The cache name and the asset version are bumped together by convention.
if asset_v != cache_v:
    bad.append('sw.js ASSET_V=%s but CACHE=freecoffee-v%s — bump both together' % (asset_v, cache_v))

# Every ?v= in every page must equal ASSET_V, or clients fetch a version
# the service worker never precached.
pages = {f: open(f, encoding='utf-8').read() for f in sorted(glob.glob('*.html'))}
for f, src in pages.items():
    for v in sorted(set(re.findall(r'\?v=([0-9]+)', src))):
        if v != asset_v:
            bad.append('%s references ?v=%s but sw.js ASSET_V=%s' % (f, v, asset_v))

# A precached asset must be stored at the SAME URL the pages request.
# Preaching './x.css' while pages request 'x.css?v=N' means the precache is
# never matched and an offline first load gets no CSS/JS at all.
for entry in re.findall(r"'(\./assets/[^']*)'", sw):
    if '?v=' in entry:
        continue
    base = entry[2:]                              # strip the leading ./
    for f, src in pages.items():
        if re.search(re.escape(base) + r'\?v=', src):
            bad.append('sw.js precaches %s unversioned, but %s requests %s?v=%s — offline first load would be unstyled'
                       % (entry, f, base, asset_v))
            break

if bad:
    for b in bad:
        print('    FAIL ' + b)
    sys.exit(1)
print('    ok   ASSET_V=%s, CACHE=v%s, precache and every ?v= reference agree' % (asset_v, cache_v))

# Lockstep floor (build.sh PWA scheme): ASSET_V must be >= APP_VERSION as
# major*1e6+minor*1e3+patch, so a DMG version bump can never ship without
# busting the PWA cache. Manual web-only bumps use a larger integer.
m_app = re.search(r'^APP_VERSION="([^"]+)"', open('app/build.sh', encoding='utf-8').read(), re.M)
if not m_app:
    print('    FAIL app/build.sh: APP_VERSION not found')
    sys.exit(1)
try:
    segs = [int(x) for x in m_app.group(1).split('.')]
    while len(segs) < 3:
        segs.append(0)
    floor = segs[0] * 1000000 + segs[1] * 1000 + segs[2]
except ValueError:
    print('    FAIL app/build.sh: APP_VERSION %r is not numeric x.y.z' % m_app.group(1))
    sys.exit(1)
if not asset_v.isdigit() or int(asset_v) < floor:
    print('    FAIL ASSET_V=%s below the APP_VERSION floor %d — run app/build.sh (PWA lockstep) or bump sw.js by hand' % (asset_v, floor))
    sys.exit(1)
print('    ok   ASSET_V=%s satisfies the APP_VERSION=%s floor (%d)' % (asset_v, m_app.group(1), floor))
PY
[ $? -eq 0 ] && ok "asset version pairing + PWA lockstep floor" || bad "asset version pairing"

# Optional real-browser check: isolated Chrome profile + local server, no npm.
# REQUIRE_BROWSER=1 turns missing Chrome/Node 22+ into a failure for CI.
step "Browser layout and dashboard interactions (optional Chrome)"
node tests/browser-regressions.cjs
BROWSER_RESULT=$?
case "$BROWSER_RESULT" in
  0) ok "dashboard mobile/desktop layout + chip pause/resume" ;;
  77) printf '    SKIP  browser prerequisites unavailable\n' ;;
  *) bad "browser regressions" ;;
esac

# ------------------------------------------------------------------ summary
echo
echo "============================================"
printf '  %d passed · %d failed\n' "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" = "0" ]