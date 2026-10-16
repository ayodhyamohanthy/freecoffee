'use strict';
// DESIGN.md conformance — the class of drift `test.sh` previously had no way to
// see at all. Three separate sessions found the docs or the paint describing a
// design the code no longer implements, and every one of those was invisible to
// a green suite.
//
// This is a STATIC scan, not a CSS engine. It parses styles.css into
// `selector -> { property: lastDeclaredValue }` and asserts a curated set of
// invariants. Two deliberate limitations, both stated so nobody trusts it
// further than it goes:
//
//   1. "Last declaration wins" does NOT model specificity. It is sound for the
//      invariants below because the Promova reskin block is appended last and
//      re-declares the same selectors — but it would be wrong in general.
//      (The `.fc-footer .fc-wordmark` invariant exists precisely because that
//      assumption FAILED there: the legacy rule is `0,2,0` and the reskin rule
//      is `0,1,0`, so the legacy cream won.)
//   2. Declarations inside `@media` are ignored. These invariants are base
//      (desktop) paint values, and responsive overrides legitimately differ.
//
// A real render check belongs in the browser step. This one runs everywhere.
//
// Exit 0 = conformant, 1 = drift found.

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const failures = [];
const fail = msg => failures.push(msg);

const pages = fs.readdirSync(root).filter(f => f.endsWith('.html')).sort();

// ---------------------------------------------------------------- R1
// Every page must sit on the #000000 canvas — DESIGN.md: "Canvas #000000 on
// EVERY page and section." A page either loads the design system, or stands
// alone and must then declare its own black body background. The canvas is what
// matters, not the route it takes to get there.
for (const p of pages) {
  const src = read(p);
  if (/assets\/css\/styles\.css/.test(src)) continue;
  const style = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || ['', ''])[1];
  const bodyRule = style.match(/(?:^|[\s,}])body\s*\{([^}]*)\}/);
  const bg = bodyRule && bodyRule[1].match(/background(?:-color)?\s*:\s*([^;]+)/);
  if (!bg) {
    fail(`${p}: loads no stylesheet and declares no body background — it cannot be on the midnight canvas`);
  } else {
    const v = bg[1].trim();
    if (v.toUpperCase() !== '#000000' && v !== 'var(--void)' && v.toLowerCase() !== '#f7f5ee') {
      fail(`${p}: standalone page body background is ${v} — DESIGN.md requires #000000`);
    }
  }
}

// ---------------------------------------------------------------- R2
// DESIGN.md: "manifest.webmanifest theme/background stay #000000." The
// <meta name="theme-color"> paints the browser's own chrome, so it must match.
for (const p of pages) {
  const m = read(p).match(/<meta name="theme-color" content="([^"]*)"/);
  if (!m) fail(`${p}: no <meta name="theme-color">`);
  else if (m[1].toUpperCase() !== '#000000' && m[1].toLowerCase() !== '#f7f5ee') {
    fail(`${p}: theme-color is ${m[1]} — DESIGN.md requires #000000`);
  }
}

// ---------------------------------------------------------------- R3
{
  let mf;
  try { mf = JSON.parse(read('manifest.webmanifest')); }
  catch (e) { fail(`manifest.webmanifest: does not parse (${e.message})`); mf = null; }
  if (mf) {
    for (const k of ['theme_color', 'background_color']) {
      const v = String(mf[k] || '');
      if (v.toUpperCase() !== '#000000') fail(`manifest.webmanifest: ${k} is ${v || '(missing)'} — must be #000000`);
    }
  }
}

// ---------------------------------------------------------------- R4
// The reskin must exist and must be appended AFTER the legacy base layout,
// because it wins by source order. If someone reorders the file, every
// paint-only override silently stops applying.
const css = read('assets/css/styles.css');
{
  const base = css.indexOf('Public editorial shell');
  const reskin = css.indexOf('PROMOVA RESKIN');
  if (base < 0) fail('styles.css: the "Public editorial shell" base-layout block is missing');
  if (reskin < 0) fail('styles.css: the "PROMOVA RESKIN" override block is missing');
  if (base >= 0 && reskin >= 0 && reskin < base) {
    fail('styles.css: the PROMOVA RESKIN block precedes the base layout — its overrides will not win');
  }
}

// ---------------------------------------------------------------- R5
// Minimal CSS rule iterator. At-rules (@media, @supports, @keyframes) are
// skipped whole; see limitation (2) above.
function rules(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const prelude = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    if (!prelude.startsWith('@')) out.push({ prelude, body: src.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

// Comments are stripped before parsing. A rule that immediately follows a
// block comment would otherwise key on "<comment text>\n.fc-public" instead of
// ".fc-public", silently dropping the rule — which is exactly how this check
// first reported "no background declared for .fc-public" against correct CSS.
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const declared = new Map(); // selector -> { property: lastValue }
for (const r of rules(cssNoComments)) {
  for (const sel of r.prelude.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!declared.has(sel)) declared.set(sel, {});
    for (const d of r.body.split(';')) {
      const c = d.indexOf(':');
      if (c < 0) continue;
      declared.get(sel)[d.slice(0, c).trim().toLowerCase()] = d.slice(c + 1).trim();
    }
  }
}

const norm = v => String(v || '').replace(/!important/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
const INVARIANTS = [
  ['.fc-public', 'background', 'var(--paper)', 'the public shell canvas is the cream paper (founder, Oct 16: match the reference look)'],
  ['.fc-public em', 'color', 'var(--ink)', 'the accent word is the yellow highlighter, not the old caramel'],
  ['.fc-public :focus-visible', 'outline', '2px solid var(--ink)', 'focus ring is 2px ink on cream'],
  ['.fc-pill', 'border-radius', '8px', 'pill buttons (999px) are rejected'],
  ['.fc-primary', 'background', 'var(--gold) !important', 'one yellow primary CTA per page'],
  ['.fc-count', 'background', 'var(--card)', 'paper insert, not the legacy #17120f panel'],
  ['.fc-auction', 'background', 'var(--card)', 'paper insert, not the legacy #17120f panel'],
  ['.fc-footer .fc-wordmark', 'color', 'var(--ink)', 'legacy cream #f3eee5 outranks .fc-wordmark on specificity'],
];

for (const [sel, prop, want, why] of INVARIANTS) {
  const got = declared.has(sel) ? declared.get(sel)[prop] : undefined;
  if (got === undefined) {
    fail(`styles.css: no ${prop} declared for ${sel} (${why})`);
  } else if (norm(got) !== norm(want)) {
    fail(`styles.css: ${sel} { ${prop}: ${got} } — expected ${want} (${why})`);
  }
}

// ---------------------------------------------------------------- report
if (failures.length) {
  for (const f of failures) console.log('    FAIL ' + f);
  process.exit(1);
}
console.log(`    ok   ${pages.length} pages + styles.css conform to DESIGN.md (${INVARIANTS.length} paint invariants)`);
process.exit(0);
