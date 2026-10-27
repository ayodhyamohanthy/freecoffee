#!/usr/bin/env bash
# ============================================================================
# FreeCoffee repo-wide smoke test — zero dependencies (node + python3 only).
#
# Checks, in execution order (step numbers are printed automatically — see
# step() below — so adding a check never means renumbering the others):
#   - Repo hygiene: committed merge-conflict markers. A half-resolved merge
#     shipped once and silently broke sw.js (a top-level '<<<<<<< HEAD' is a
#     syntax error, so the service worker died) while every other check passed.
#   - JS syntax (node --check) over assets/js/*.js and the Worker
#     + Swift parse gate (macOS only, skipped elsewhere)
#   - Backend unit tests (backend/test.mjs)
#   - HTML structure / inline JS / element-ID references / duplicate ids
#   - Demo-engine determinism + balance invariant (seed 42)
#   - Public-page regressions (tests/public-regressions.cjs) — the 70% share
#     claim, the "platform-funded 10% launch boost" wording, and PWA wiring
#   - Dashboard/payout state regressions (tests/state-regressions.cjs)
#   - Competitor brand references
#   - Referenced local files exist + in-page fragments resolve to real ids
#   - Asset version pairing (?v= in HTML <-> sw.js ASSET_V <-> CACHE) — a
#     mismatch silently breaks the precache and offline first loads — plus the
#     PWA lockstep floor (ASSET_V >= padded APP_VERSION from app/build.sh) so
#     DMG bumps always bust the web cache, plus a single-declaration rule (a
#     duplicated ASSET_V hides the real version)
#   - DESIGN.md conformance — black canvas, rejected-palette and paint
#     invariants (tests/design-conformance.cjs; static, no browser needed)
#   - Real-browser layout + interaction regressions on the dashboard
#     (headless Chrome + CDP, zero npm deps; skipped cleanly when Chrome or
#     Node 22+ WebSocket is unavailable — REQUIRE_BROWSER=1 forces a failure)
#
# Run from the repo root:   ./test.sh      (or:  bash test.sh)
# Exit 0 when everything passes, non-zero otherwise.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"

PASS=0
FAIL=0
# Steps number themselves. These labels used to be hardcoded "1/9".."9/9", so
# adding a check silently mis-numbered every step after it — the same class of
# quiet lie as a stale "(24 groups)" in the backend label. Now there is one
# number to maintain, and a stale one is self-evident: the run prints a step
# count one higher than the total, e.g. "13/12".
TOTAL_STEPS=12
STEP_NO=0
step() { STEP_NO=$((STEP_NO+1)); printf '\n==> %d/%d %s\n' "$STEP_NO" "$TOTAL_STEPS" "$1"; }
ok()  { PASS=$((PASS+1)); printf '    PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '    FAIL  %s\n' "$1"; }

# ------------------------------------------------------------------ 0. Repo hygiene
# A committed conflict marker is the worst kind of failure: it is invisible to
# every other check here (the HTML parser treats it as text, and the ?v= regex
# happily matches whichever side it finds first) yet it can make a file
# unparseable. Detect it first, before anything else trusts the tree.
step "Repo hygiene (no committed merge-conflict markers)"
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
step "JS syntax (node --check)"
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
step "Backend unit tests"
# Read the group count out of the tool's own output rather than hardcoding it.
# The label used to say "(24 groups)" for a suite that had grown to 32, so the
# harness quietly under-reported its own coverage.
BACKEND_OUT="$( cd backend && node test.mjs 2>&1 )"
BACKEND_RC=$?
if [ "$BACKEND_RC" -eq 0 ]; then
  BACKEND_GROUPS="$(printf '%s\n' "$BACKEND_OUT" | grep -oE '\([0-9]+ groups\)' | tail -1)"
  ok "backend/test.mjs ${BACKEND_GROUPS:-(group count not reported by test.mjs)}"
else
  bad "backend/test.mjs"
  printf '%s\n' "$BACKEND_OUT" | tail -25 | sed 's/^/    /'
fi

# ------------------------------------------------------------------ 3. Static-site checks (python3)
step "HTML structure, inline JS, ID references"
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
step "Demo engine determinism + balance invariant"
node -e '
const D = require("./assets/js/demo.js");
const a = JSON.stringify(D.generateHistory(42));
const b = JSON.stringify(D.generateHistory(42));
if (a !== b) { console.error("NON-DETERMINISTIC output"); process.exit(1); }
const t = D.generateHistory(42).totals;
if (Math.abs((t.available + t.pending) - t.lifetime) > 0.011) { console.error("available+pending != lifetime"); process.exit(1); }
if (t.lifetime < 33.9 || t.lifetime > 34.0) { console.error("unexpected lifetime " + t.lifetime); process.exit(1); }
console.log("    ok   seed 42 reproducible; available + pending = lifetime ($" + t.lifetime + ")");
'
[ $? -eq 0 ] && ok "demo engine" || bad "demo engine"

# ------------------------------------------------------------------ 5. Orphaned suites
# tests/public-regressions.cjs and tests/state-regressions.cjs both existed and
# both passed, but nothing invoked them: the suite had quietly grown two orphan
# files. public-regressions.cjs guards the economics claims on the public pages
# (70% share, platform-funded 10% launch boost, no stale "$50k/month" ratchet)
# plus PWA registration — precisely the guard whose absence let the site
# describe a different product three separate times.
step "Public-page regressions (economics claims, PWA wiring)"
node tests/public-regressions.cjs
[ $? -eq 0 ] && ok "public-page regressions" || bad "public-page regressions"

# state-regressions.cjs drives dashboard.js under a stub DOM: payout accounting
# and persistence, empty/stale feed responses, blocked storage.
step "Dashboard/payout state regressions"
node tests/state-regressions.cjs
[ $? -eq 0 ] && ok "dashboard/payout state regressions" || bad "dashboard/payout state regressions"

# ------------------------------------------------------------------ 6. De-branding guard
step "No competitor brand references"
HITS=$(grep -riIl --exclude-dir=.git --exclude-dir=.workbuddy-ai --exclude=test.sh -E "$(printf '%s' sponsor bar)|kickbot" . 2>/dev/null)
if [ -z "$HITS" ]; then
  ok "no competitor brand references in any tracked text file"
else
  bad "competitor brand references found:"; echo "$HITS" | sed 's/^/    /'
  exit 1
fi

# ------------------------------------------------------------------ 6. Asset presence
step "Referenced local files exist + in-page fragments resolve"
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

# .well-known/security.txt (RFC 9116). The site takes payments and runs a
# Worker backend; a stale or dead security contact is the one rot that shows
# up in no diff and no console. Expires must be current and no more than a
# year out (renew annually), Contact must be the support address the site
# itself publishes, and that address must really appear in the public pages
# so the file cannot outlive it.
sec_path = '.well-known/security.txt'
if not os.path.exists(sec_path):
    print('    FAIL missing .well-known/security.txt (RFC 9116)')
    sys.exit(1)
sec = open(sec_path, encoding='utf-8').read()
sec_fields = {}
for line in sec.splitlines():
    line = line.strip()
    if line.startswith('#') or not line:
        continue
    if ':' in line:
        k, v = line.split(':', 1)
        sec_fields.setdefault(k.strip().lower(), v.strip())
sec_fails = []
from datetime import datetime, timezone
for req in ('contact', 'expires'):
    if req not in sec_fields:
        sec_fails.append('missing %s field' % req)
if 'expires' in sec_fields:
    try:
        exp = datetime.fromisoformat(sec_fields['expires'].replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        if exp <= now:
            sec_fails.append('Expires is in the past: %s' % sec_fields['expires'])
        elif (exp - now).days > 365:
            sec_fails.append('Expires more than a year out; renew annually instead: %s' % sec_fields['expires'])
    except ValueError:
        sec_fails.append('Expires is not an RFC3339 date: %s' % sec_fields['expires'])
if sec_fields.get('contact') != 'mailto:hello@freecoffee.tech':
    sec_fails.append('Contact is not the published support address: %r' % sec_fields.get('contact'))
if 'mailto:hello@freecoffee.tech' not in ''.join(srcs.values()):
    sec_fails.append('Contact address appears on no public page')
if sec_fails:
    for m in sec_fails: print('    FAIL security.txt: ' + m)
    sys.exit(1)
print('    ok   security.txt present, current, and pointing at the published contact')

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
step "Asset version pairing (?v= <-> sw.js ASSET_V <-> CACHE)"
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

# ------------------------------------------------------------------ 9. DESIGN.md
# This class of drift was previously invisible: the paint drifted from
# DESIGN.md while every check stayed green, three separate times. The scan is
# static (no browser), so it runs everywhere — see tests/design-conformance.cjs
# for its two documented limitations.
step "DESIGN.md conformance (canvas, palette, paint invariants)"
node tests/design-conformance.cjs
[ $? -eq 0 ] && ok "design system conforms to DESIGN.md" || bad "design system drift from DESIGN.md"

# Optional real-browser check: isolated Chrome profile + local server, no npm.
# REQUIRE_BROWSER=1 turns missing Chrome/Node 22+ into a failure for CI.
step "Browser layout and dashboard interactions (optional Chrome)"
# The driver is supposed to exit 77 when Chrome cannot be driven, but it has been
# observed to block indefinitely instead (sandboxed shells, no display). An
# unbounded wait is the worst failure mode here: it hides every check behind it
# and reads as "still running" rather than "not verified". Cap it, and treat a
# timeout as a SKIP — unless REQUIRE_BROWSER=1, which demands a real verdict.
BROWSER_TIMEOUT="${BROWSER_TIMEOUT:-120}"
python3 - "$BROWSER_TIMEOUT" <<'PY'
import subprocess, sys
try:
    sys.exit(subprocess.call(['node', 'tests/browser-regressions.cjs'],
                             timeout=float(sys.argv[1])))
except subprocess.TimeoutExpired:
    sys.exit(124)
PY
BROWSER_RESULT=$?
case "$BROWSER_RESULT" in
  0) ok "dashboard mobile/desktop layout + chip pause/resume" ;;
  77) printf '    SKIP  browser prerequisites unavailable\n' ;;
  124) if [ "${REQUIRE_BROWSER:-0}" = "1" ]; then
         bad "browser regressions timed out after ${BROWSER_TIMEOUT}s"
       else
         printf '    SKIP  browser check timed out after %ss (raise with BROWSER_TIMEOUT, or REQUIRE_BROWSER=1 to demand a verdict)\n' "$BROWSER_TIMEOUT"
       fi ;;
  *) bad "browser regressions" ;;
esac

# ------------------------------------------------------------------ summary
echo
echo "============================================"
printf '  %d passed · %d failed\n' "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" = "0" ]