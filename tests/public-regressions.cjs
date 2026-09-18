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
  const names = D.SPONSORS.map(x => x.name);
  assert(names.includes(s.head.textContent), 'chip headline must be a demo sponsor');
  const match = D.SPONSORS.find(x => x.name === s.head.textContent);
  assert.equal(s.small.textContent, match.tag, 'chip second line must be THAT sponsor tagline');
  assert.match(s.mark.textContent, /^[A-Z0-9]{1,2}$/, 'tile must show a short monogram');
  assert.equal(s.chip.textContent, '', 'structured chip must never be flattened by textContent');
  assert.equal(s.tag.textContent,
    'Fictional demo sponsor (simulated) — display only, nothing is collected.',
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
    'Fictional demo sponsor (simulated) — display only, nothing is collected.',
    'returning to demo replaces rather than appends to the live caption');

  // Legacy single-line markup still renders instead of throwing.
  const l = run(engine, false);
  assert(l.chip.textContent.includes(' — '), 'legacy chip must fall back to one text node');
  assert.equal(l.head.textContent, '', 'legacy path must not touch absent inner nodes');

  console.log('PASS menu-bar component regressions: markup on both pages, structured + legacy chip, live accent');
})();

const swContext = { self: { location: { href: 'https://local.test/sw.js' }, addEventListener() {} }, URL };
vm.runInNewContext(read('sw.js'), swContext);
(async () => {
  await swContext.putSafe({ put: () => Promise.reject(new Error('quota')) }, {}, { ok: true });
  console.log('PASS public regressions: share claims, PWA setup, eligible slot selection, winner refresh, cache quota handling');
})().catch(err => { console.error(err); process.exitCode = 1; });
