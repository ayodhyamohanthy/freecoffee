'use strict';
// Node 22+ and Chrome; no npm dependencies. CHROME_BIN overrides discovery.
// REQUIRE_BROWSER=1 makes missing prerequisites a failure (useful in CI).
// SCREENSHOT_DIR optionally saves fresh mobile/desktop dashboard screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(file => fs.existsSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (!chrome || typeof WebSocket === 'undefined') {
    const message = 'browser regressions require Chrome and Node 22+ (set CHROME_BIN)';
    if (process.env.REQUIRE_BROWSER === '1') throw new Error(message);
    console.log('SKIP ' + message);
    process.exitCode = 77;
    return;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'freecoffee-browser-'));
  const server = http.createServer((req, res) => {
    const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(filename, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  let child, socket;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'],
    { stdio: 'ignore' });
    let launchError;
    child.on('error', err => { launchError = err; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile); i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || i >= 150) throw new Error('Chrome failed to start');
      await delay(100);
    }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setBypassServiceWorker', { bypass: true });
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/dashboard.html' });
    for (let i = 0; ; i++) {
      if (await evaluate("document.readyState === 'complete' && !!document.querySelector('#ledgerBody tr') && !!document.querySelector('#sponsorList li')")) break;
      if (i >= 100) throw new Error('Dashboard failed to render ledger and sponsors');
      await delay(100);
    }
    await evaluate('document.fonts.ready.then(() => true)');
    for (const width of [390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const layout = await evaluate(`(() => {
        const ledger = document.querySelector('.ledger-scroll');
        const bounds = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { left: r.left, right: r.right };
        };
        ledger.scrollLeft = 100;
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          main: bounds('.dash-main'), side: bounds('.dash-side'),
          ledgerWidth: ledger.clientWidth, ledgerContent: ledger.scrollWidth,
          ledgerScroll: ledger.scrollLeft, overflow: getComputedStyle(ledger).overflowX };
      })()`);
      assert.equal(layout.viewport, width);
      assert(layout.page <= width, JSON.stringify(layout));
      for (const region of ['main', 'side']) {
        assert(layout[region].left >= 0 && layout[region].right <= width, region + ' must stay inside viewport');
      }
      if (width === 390) {
        assert(layout.ledgerContent > layout.ledgerWidth, 'mobile ledger keeps its wide columns');
        assert(layout.ledgerScroll > 0, 'mobile ledger scrolls internally');
        assert(['auto', 'scroll'].includes(layout.overflow));
      }
      await evaluate("document.querySelector('.ledger-scroll').scrollLeft = 0");
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, 'dashboard-' + width + '.png'), Buffer.from(shot.data, 'base64'));
      }
      console.log('PASS dashboard ' + width + 'px: page fits, panels contained' + (width === 390 ? ', ledger scrolls internally' : ''));
      if (width === 390) {
        // Negative control: restoring the old grid sizing must reproduce the bug.
        const oldWidth = await evaluate(`(() => {
          const style = document.createElement('style');
          style.textContent = '.dash-main,.dash-side{grid-template-columns:none!important;min-width:auto!important}';
          document.head.appendChild(style);
          const width = document.documentElement.scrollWidth;
          style.remove();
          return width;
        })()`);
        assert(oldWidth > width, 'negative control must catch the original grid overflow');
        console.log('PASS negative control: old grid sizing overflows to ' + oldWidth + 'px');
      }
      for (const paused of [true, false]) {
        const state = await evaluate(`(() => {
          document.getElementById('pauseToggle').click();
          return {
            pressed: document.getElementById('pauseToggle').getAttribute('aria-pressed'),
            chip: document.getElementById('demoSponsorChip').getAttribute('data-paused'),
            label: document.getElementById('pauseToggleLabel').textContent,
            status: document.getElementById('dashStatus').textContent,
            hint: document.getElementById('mbPreviewHint').textContent,
            name: document.querySelector('#demoSponsorChip .mb-chip-copy strong').textContent,
            page: document.documentElement.scrollWidth
          };
        })()`);
        assert.equal(state.pressed, String(paused));
        assert.equal(state.chip, String(paused));
        assert.equal(state.label, paused ? 'Resume ads' : 'Pause ads');
        assert.match(state.status, paused ? /Ads paused/ : /Ads running/);
        assert.match(state.hint, paused ? /chip is frozen/ : /rotates every few seconds/);
        assert(state.name.trim(), 'sponsor name remains visible');
        assert(state.page <= width, 'pause/resume must not introduce overflow');
      }
      console.log('PASS dashboard ' + width + 'px: pause/resume updates chip and status');
    }
  } finally {
    if (socket) socket.close();
    if (child && child.exitCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
