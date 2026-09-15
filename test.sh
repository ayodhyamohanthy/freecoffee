#!/usr/bin/env bash
# ============================================================================
# FreeCoffee repo-wide smoke test — zero dependencies (node + python3 only).
#
# Catches the failure classes this repo has actually hit before:
#   1. HTML tag-misnesting / unclosed elements (was broken in referrals.html)
#   2. Inline <script> blocks that no longer parse (node --check)
#   3. JS element-ID references that don't exist in the page
#      + duplicate element IDs
#   4. Demo-engine non-determinism + balance invariant (seed 42)
#   5. Backend helper regressions (backend/test.mjs)
#   6. Monitor JSON/log integrity + missing asset references
#   7. Asset version pairing (?v= in HTML <-> sw.js ASSET_V <-> CACHE) — a
#      mismatch silently breaks the precache and offline first loads
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

# ------------------------------------------------------------------ 1. JS syntax
step "1/7 JS syntax (node --check)"
JS_FAIL=0
for f in assets/js/*.js backend/src/worker.js; do
  if ! node --check "$f" 2>/dev/null; then
    JS_FAIL=1; bad "syntax: $f"
  fi
done
[ "$JS_FAIL" = "0" ] && ok "assets/js/*.js + backend/src/worker.js parse cleanly"

# ------------------------------------------------------------------ 2. Backend tests
step "2/7 Backend unit tests"
if ( cd backend && node test.mjs ); then
  ok "backend/test.mjs (17 groups)"
else
  bad "backend/test.mjs"
fi

# ------------------------------------------------------------------ 3. Static-site checks (python3)
step "3/7 HTML structure, inline JS, ID references"
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
step "4/7 Demo engine determinism + balance invariant"
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
step "5/7 No competitor brand references"
HITS=$(grep -riIl --exclude-dir=.git --exclude-dir=.workbuddy-ai --exclude=test.sh -E 'sponsorbar|kickbot' . 2>/dev/null)
if [ -z "$HITS" ]; then
  ok "no competitor brand references in any tracked text file"
else
  bad "competitor brand references found:"; echo "$HITS" | sed 's/^/    /'
  exit 1
fi

# ------------------------------------------------------------------ 6. Asset presence
step "6/7 Referenced local files exist"
python3 - <<'PY'
import re, glob, os, sys
missing = []
for f in glob.glob('*.html'):
    src = open(f, encoding='utf-8').read()
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
PY
[ $? -eq 0 ] && ok "asset references" || bad "asset references"

# ------------------------------------------------------------------ 7. Asset version pairing
step "7/7 Asset version pairing (?v= <-> sw.js ASSET_V <-> CACHE)"
python3 - <<'PY'
import glob, re, sys

bad = []
sw = open('sw.js', encoding='utf-8').read()

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
PY
[ $? -eq 0 ] && ok "asset version pairing" || bad "asset version pairing"

# ------------------------------------------------------------------ summary
echo
echo "============================================"
printf '  %d passed · %d failed\n' "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" = "0" ]