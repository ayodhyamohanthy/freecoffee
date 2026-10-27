'use strict';
// Local, dependency-free regression checks for public pages and inline scripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('advertisers.html');
const home = read('index.html');
const share = require('../assets/js/demo.js').MODEL.BASE_SHARE;
assert.equal(share, 0.70);
assert.match(home, /shares 70%/);
assert.match(home, /platform-funded 10% launch boost/);
assert.doesNotMatch(home, /50k\/month/);
for (const page of ['index.html', 'agents.html', 'advertisers.html']) {
  assert.match(read(page), /rel="manifest"/);
  assert.match(read(page), /serviceWorker\.register\('sw.js'\)/);
}
function snippet(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert(a >= 0 && b > a, 'inline test anchors must resolve');
  return html.slice(a, b);
}
let pickAll;
const ctx = {
  dayAll: { addEventListener(type, fn) { pickAll = fn; } },
  focusDay: '2026-09-17', blocksPerDay: 6, known: {}, picked: {},
  renderCalendar() {}, renderEditor() {}, renderSum() {}, Date
};
for (let b = 0; b < 6; b++) {
  ctx.known[ctx.focusDay + '#' + b] = { state: b < 2 ? 'past' : 'open', startsAt: Date.now() + (b < 2 ? -60000 : 60000) };
}
vm.runInNewContext(snippet("  dayAll.addEventListener('click'", "  clearBtn.addEventListener"), ctx);
pickAll();
assert.equal(Object.keys(ctx.picked).length, 4, 'pick all skips closed blocks');
pickAll();
assert.equal(Object.keys(ctx.picked).length, 0, 'second pick all clears eligible blocks');
const folding = snippet('        d.slots.forEach(function (s) {', '        render();');
const winner = { d: { slots: [{ id: 'one', topCampaignId: 'new' }] }, known: { one: { mine: true } } };
vm.runInNewContext(folding, winner);
assert.equal(winner.known.one.mine, undefined, 'server refresh clears stale local winning verdict');
/* ---------------------------------------------------------------------------
   Menu-bar component regressions: the shared chip/popover markup exists on the
   public page and the app shell, and demo.js renders it in BOTH shapes (the
   structured two-line chip and the legacy single-line fallback).
   --------------------------------------------------------------------------- */
(function () {
  const menuPages = ['index.html', 'dashboard.html'];
  for (const page of menuPages) {
    const src = read(page);
    for (const id of ['demoMenuBar', 'demoSponsorChip', 'demoBalance', 'demoClock', 'demoSponsorTag']) {
      assert.match(src, new RegExp('id="' + id + '"'), page + ' must ship the ' + id + ' node');
    }
    assert.match(src, /mb-chip-copy/, page + ' must use the structured chip markup');
  }
  assert.match(home, /assets\/js\/demo\.js\?v=\d+/, 'the landing page must load the demo engine');
  assert.match(home, /FreeCoffeeDemo\.initMenuBarDemo\(\)/, 'the landing page must boot the component');

  // --- demo.js renderChip, exercised in a VM with a minimal DOM ------------
  const mk = () => ({
    className: '', value: '', style: {}, dataset: {}, children: [], attrs: {},
    get textContent() { return this.children.map(child => child.textContent).join(''); },
    set textContent(value) {
      this.children = value === '' ? [] : [{ textContent: String(value) }];
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  });

  function run(engine, structured) {
    const chip = mk(), tag = mk(), clock = mk(), balance = mk(), chart = mk(), bar = mk();
    const mark = mk(), head = mk(), small = mk();
    if (structured) {
      chip.querySelector = sel => sel === '.mb-chip-mark' ? mark
        : sel === '.mb-chip-copy strong' ? head
        : sel === '.mb-chip-copy small' ? small : null;
    }
    const byId = {
      demoSponsorChip: chip, demoSponsorTag: tag, demoClock: clock,
      demoBalance: balance, demoChart: chart, demoMenuBar: bar,
      popBalance: null, popAvailable: null, popPending: null
    };
    const document = {
      hidden: false,
      getElementById: id => byId[id] || null,
      createElement: () => mk(),
      createTextNode: text => ({ textContent: String(text) }),
      addEventListener() {}
    };
    const window = {
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      matchMedia: () => ({ matches: false })
    };
    const context = {
      window, self: window, document, console, Date, Math, JSON,
      setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}
    };
    vm.runInNewContext(engine, context);
    const api = window.FreeCoffeeDemo.initMenuBarDemo();
    assert(api, 'initMenuBarDemo must return its control handle');
    return { api, chip, tag, mark, head, small, balance };
  }

  const engine = read('assets/js/demo.js');
  const D = require('../assets/js/demo.js');

  // Structured chip: two-line copy inside the bar, tile monogram, honest status line.
  const s = run(engine, true);
  // The demo chip shows one example advertiser (skipwait.me) with its own icon.
  assert.equal(s.head.textContent, 'skipwait.me', 'chip headline must be the example advertiser');
  assert.equal(s.small.textContent, 'Free job referrals. A warmer way in.', 'chip second line must be the real tagline');
  assert.equal(s.mark.textContent, '', 'tile shows the icon, not a monogram');
  assert.match(String(s.mark.style.backgroundImage), /skipwait-icon\.svg/, 'tile must carry the skipwait.me icon');
  assert.equal(s.chip.textContent, '', 'structured chip must never be flattened by textContent');
  assert.equal(s.tag.textContent,
    'Example advertiser, not a paid campaign — display only, nothing is collected.',
    'the line under the bar must state the demo status, not repeat the tagline');
  assert.equal(s.chip.attrs['data-paused'], undefined, 'chip starts without a paused flag');

  // Live campaign: name/tagline in the bar, validated accent on the tile only.
  s.api.applyLiveCampaigns([{ id: 'camp_x', sponsor: 'Acme Coffee', tagline: 'Beans', cpm: 7.5, logoText: 'ac', accent: '#123456' }]);
  assert.equal(s.head.textContent, 'Acme Coffee');
  assert.equal(s.small.textContent, 'Beans');
  assert.equal(s.mark.textContent, 'AC', 'logoText must drive the tile monogram');
  assert.equal(s.mark.style.backgroundColor, '#123456', 'accent tints the tile');
  assert.equal(s.chip.style.backgroundColor, undefined, 'accent must NOT flood the whole pill');
  assert.match(s.tag.textContent, /LIVE CAMPAIGN · \$7\.50 CPM/);
  assert.doesNotMatch(s.tag.textContent, /Fictional demo sponsor/);
  s.api.applyLiveCampaigns([]);
  assert.equal(s.mark.style.backgroundColor, '', 'returning to demo clears live accent');
  assert.equal(s.tag.textContent,
    'Example advertiser, not a paid campaign — display only, nothing is collected.',
    'returning to demo replaces rather than appends to the live caption');

  // Legacy single-line markup still renders instead of throwing.
  const l = run(engine, false);
  assert(l.chip.textContent.includes(' — '), 'legacy chip must fall back to one text node');
  assert.equal(l.head.textContent, '', 'legacy path must not touch absent inner nodes');

  console.log('PASS menu-bar component regressions: markup on both pages, structured + legacy chip, live accent');
})();


/* ---------------------------------------------------------------------------
   Share composers must open in a new tab: a composer click that navigates the
   share page away throws away the visitor's place (the referral link input,
   the platform card they were on). Download and repository links stay
   same-tab on purpose.
   --------------------------------------------------------------------------- */
(function () {
  const composers = {
    'referrals.html': ['shareXBtn', 'shareWaBtn', 'shareLiBtn'],
    'flywheel.html': ['openX', 'openLinkedin', 'openReddit', 'openHn'],
  };
  for (const [page, ids] of Object.entries(composers)) {
    const src = read(page);
    for (const id of ids) {
      const tag = src.match(new RegExp('<a\\b[^>]*\\bid="' + id + '"[^>]*>'));
      assert(tag, page + ' must ship the ' + id + ' composer link');
      assert.match(tag[0], /\starget="_blank"/, id + ' on ' + page + ' must open the composer in a new tab');
      assert.match(tag[0], /rel="[^"]*noopener/, id + ' on ' + page + ' must keep rel="noopener"');
    }
  }
  const flywheel = read('flywheel.html');
  for (const id of ['openMac', 'openGithub']) {
    const tag = flywheel.match(new RegExp('<a\\b[^>]*\\bid="' + id + '"[^>]*>'));
    assert(tag, 'flywheel.html must ship the ' + id + ' link');
    assert.doesNotMatch(tag[0], /target="_blank"/, id + ' stays same-tab (download/repository navigation)');
  }
  console.log('PASS share composers: 7 composer links open new-tab with noopener; download/repo links stay same-tab');
})();

/* ---------------------------------------------------------------------------
   No-JS fallback: the Email composer's static href is what a visitor with
   scripts off actually opens. It shipped as a bare "mailto:", which opened an
   empty compose window with no recipient, subject, or body, unlike every
   other flywheel fallback.
   --------------------------------------------------------------------------- */
(function () {
  const tag = read('flywheel.html').match(/<a\b[^>]*\bid="openEmail"[^>]*>/);
  assert(tag, 'flywheel.html must ship the openEmail composer link');
  assert.match(tag[0], /href="mailto:\?subject=.*&amp;body=.*https%3A%2F%2Ffreecoffee\.tech%2F"/,
    'openEmail static fallback must prefill a subject and a body carrying the site URL');
  console.log('PASS share fallbacks: the Email static button opens a prefilled compose, like the Reddit and HN ones');
})();

const swContext = { self: { location: { href: 'https://local.test/sw.js' }, addEventListener() {} }, URL };
vm.runInNewContext(read('sw.js'), swContext);
(async () => {
  await swContext.putSafe({ put: () => Promise.reject(new Error('quota')) }, {}, { ok: true });
  console.log('PASS public regressions: share claims, PWA setup, eligible slot selection, winner refresh, cache quota handling');
})().catch(err => { console.error(err); process.exitCode = 1; });
