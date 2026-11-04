'use strict';
// Browser compatibility acceptance against a controlled HOST Vite fixture.
// This does not establish Vite acceptance under the owner's RLIMIT_AS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createService } = require('../src/main/developmentPreviews');

test('Chromium cookie handoff, assets, routing, reload and real Vite HMR (controlled host transport)', { skip: !process.env.B2F_BROWSER, timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-b2f-vite-'));
  const context = {}, opened = [], controller = new AbortController();
  let vite, gateway, browser;
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/main.js"></script>');
    fs.writeFileSync(path.join(root, 'style.css'), 'body{color:rgb(1,2,3)}');
    const source = text => `document.querySelector('#app').textContent='${text}';if(import.meta.hot)import.meta.hot.accept();`;
    fs.writeFileSync(path.join(root, 'main.js'), source('before'));
    const { createServer } = await import(pathToFileURL(path.resolve('node_modules/vite/dist/node/index.js')));
    vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0, strictPort: true }, optimizeDeps: { noDiscovery: true, include: [] } });
    await vite.listen(); const port = vite.httpServer.address().port;
    const authority = { expiresAt: Date.now() + 40000, signal: controller.signal,
      validate() { assert.equal(controller.signal.aborted, false); },
      connect() { return new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => resolve(s)); s.once('error', reject); }); } };
    gateway = createService({ readiness: () => ({ available: true }), resolveAuthority(id, actor) { assert.equal(id, 'vite'); assert.equal(actor, context); return authority; }, openExternal: url => opened.push(url) });
    const preview = await gateway.create(context, { background_command_id: 'vite', guest_port: port });
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.B2F_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] });
    const page = await browser.newPage(); const wsUrls = [], frames = [];
    page.on('websocket', ws => { wsUrls.push(ws.url()); ws.on('framereceived', f => frames.push(String(f.payload))); });
    await gateway.open(context, 'vite');
    // Do not attach URL-bearing Playwright errors to diagnostics: the fragment
    // handoff is a secret even though it is short-lived and consumed once.
    try { await page.goto(opened.at(-1)); } catch { throw new Error('Preview browser handoff failed'); }
    await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'before');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
    await page.reload(); await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'before');
    await page.goto(preview.url + 'client/route'); await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'before');
    fs.writeFileSync(path.join(root, 'main.js'), source('after'));
    await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'after');
    assert.ok(frames.some(frame => frame.includes('update')));
    assert.ok(wsUrls.length > 0 && wsUrls.every(url => new URL(url).host === new URL(preview.url).host));
    const cookies = await page.context().cookies(preview.url); assert.ok(cookies.every(c => c.httpOnly && c.sameSite === 'Strict'));
    // A second browser profile has no preview credential.
    const unrelated = await browser.newContext(); const other = await unrelated.newPage();
    assert.equal((await other.goto(preview.url)).status(), 403); await unrelated.close();
    controller.abort(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(gateway.active(), 0);
    await assert.rejects(new Promise((resolve, reject) => http.get(preview.url, resolve).on('error', reject)));
  } finally { await browser?.close(); await gateway?.shutdown(); await vite?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
