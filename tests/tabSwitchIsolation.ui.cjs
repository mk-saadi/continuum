// Phase 6 tab-switch isolation suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/tabSwitchIsolation.ui.cjs
//
// Reuses the Phase 4 render-isolation harness (real App shell, heavy leaves
// stubbed to counters) and adds tab-switch specific checks: the correct
// conversation activates, only the two tabs involved in the transition render,
// the untouched tab keeps its state, streaming/status routing stays per-tab,
// redundant per-tab updates are collapsed, and Phase 4 modal/sidebar isolation
// still holds. `RESULTS {...}` is always printed for baseline comparison.
const IS_ELECTRON = !!process.versions.electron;
if (!IS_ELECTRON) {
  const test = require('node:test');
  test('tab-switch isolation requires the electron harness', async (t) => {
    t.skip('run under xvfb-run electron');
  });
} else {
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-switch-isolation-'));
  const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures/renderIsolation.jsx')],
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [require('./fixtures/renderIsolationStubs.cjs')],
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));

    const results = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (fn, tries = 400) => { for (let i = 0; i < tries; i += 1) { if (fn()) return; await wait(); } throw new Error('timeout'); };
      const snap = () => ({ i: window.chatRenderLog.length, t: window.titlebarRenders, ms: window.memorySettingsRenders });
      const delta = (m) => {
        const slice = window.chatRenderLog.slice(m.i);
        return {
          chatTotal: slice.length,
          sessions: slice,
          tabsRendered: new Set(slice).size,
          app: window.titlebarRenders - m.t,
          memorySettings: window.memorySettingsRenders - m.ms,
        };
      };
      const header = () => document.querySelector('header');
      const tabEls = () => [...document.querySelectorAll('[data-tab-id]')];
      const activeIndex = () => tabEls().findIndex((el) => el.querySelector('button[aria-current="page"]'));
      // Each TabPane renders a real Header; inactive panes carry aria-hidden.
      const paneHidden = (index) => document.querySelectorAll('header')[index].parentElement.getAttribute('aria-hidden') === 'true';
      const visibleIndexes = () => tabEls().map((_, index) => index).filter((index) => !paneHidden(index));
      const clickTab = (index) => { const el = tabEls()[index].querySelector('button'); el.click(); };

      window.mountApp();
      await until(() => window.titlebarRenders > 0);
      await wait(700);
      await window.addTabs(2);
      await wait(400);
      const tabCount = tabEls().length;
      // First render order maps tab index -> session id.
      const sessions = [...new Set(window.chatRenderLog)];

      const out = { tabCount, sessions, initialActive: activeIndex(), initialVisible: visibleIndexes() };

      // --- Switch to the first tab: only the previous and next tabs render ---
      let m = snap();
      clickTab(0);
      await wait(120);
      out.switchToFirst = { ...delta(m), active: activeIndex(), visible: visibleIndexes() };

      // --- Switch to the third tab ---
      m = snap();
      clickTab(2);
      await wait(120);
      out.switchToThird = { ...delta(m), active: activeIndex(), visible: visibleIndexes() };

      // --- Rapid switch: the final selection wins, no stale pane ---
      m = snap();
      clickTab(0);
      clickTab(1);
      await wait(160);
      out.rapidSwitch = { ...delta(m), active: activeIndex(), visible: visibleIndexes() };

      // --- Streaming stays bound to its own tab (inactive here) ---
      m = snap();
      window.__emitStreamStatus({ sessionId: sessions[0], status: 'generating' });
      await wait(140);
      out.streamInactive = { ...delta(m), routedSession: sessions[0] };

      // --- A redundant status update for the same value is not propagated ---
      m = snap();
      window.__emitStreamStatus({ sessionId: sessions[0], status: 'generating' });
      await wait(140);
      out.statusDuplicate = delta(m);

      // --- A genuine status change still propagates to that tab ---
      m = snap();
      window.__emitStreamStatus({ sessionId: sessions[0], status: 'idle' });
      await wait(140);
      out.statusChanged = delta(m);

      // --- Phase 4 isolation still holds for chrome actions ---
      m = snap();
      header().querySelector('[aria-label="Toggle chat history"]').click();
      await wait(120);
      out.sidebarToggle = delta(m);

      m = snap();
      header().querySelector('[aria-label="Open settings"]').click();
      await until(() => document.querySelector('[data-testid="memory-settings"]'));
      await wait(80);
      out.modalOpen = delta(m);
      document.querySelector('[data-testid="close-settings"]').click();
      await wait(80);

      return out;
    })()`);

    process.stderr.write('RESULTS ' + JSON.stringify(results) + '\n');

    assert.equal(results.tabCount, 3, 'three tabs mounted');
    assert.equal(results.initialActive, 2, 'the most recently opened tab is active');
    assert.deepEqual(results.initialVisible, [2], 'only the active pane is visible');

    // Switching selects the right conversation and shows only that pane.
    assert.equal(results.switchToFirst.active, 0, 'first tab activated');
    assert.deepEqual(results.switchToFirst.visible, [0], 'only the first pane is visible');
    assert.equal(results.switchToFirst.tabsRendered, 2, 'only the two tabs in the transition render');
    assert.ok(!results.switchToFirst.sessions.includes(results.sessions[1]), 'the untouched tab does not re-render');
    assert.equal(results.switchToFirst.app, 1, 'AppContent renders once for the legitimate active-tab change');

    assert.equal(results.switchToThird.active, 2, 'third tab activated');
    assert.deepEqual(results.switchToThird.visible, [2], 'only the third pane is visible');
    assert.equal(results.switchToThird.tabsRendered, 2, 'only two tabs render');
    assert.ok(!results.switchToThird.sessions.includes(results.sessions[1]), 'the untouched tab does not re-render');

    // Rapid switching settles on the latest selection with the matching pane.
    assert.equal(results.rapidSwitch.active, 1, 'the last selected tab wins');
    assert.deepEqual(results.rapidSwitch.visible, [1], 'the shown pane matches the selection');

    // Streaming is associated with its own tab.
    assert.equal(results.streamInactive.tabsRendered, 1, 'a status change renders only its tab');
    assert.ok(results.streamInactive.sessions.every((id) => id === results.streamInactive.routedSession), 'the rendered tab is the one the status belongs to');
    assert.equal(results.streamInactive.app, 1, 'AppContent re-renders for a real per-tab change');

    // Redundant per-tab updates collapse.
    assert.equal(results.statusDuplicate.tabsRendered, 0, 'an identical status update renders no tab');
    assert.equal(results.statusDuplicate.app, 0, 'an identical status update does not re-render AppContent');

    // A genuine status change still propagates.
    assert.equal(results.statusChanged.tabsRendered, 1, 'a real status change renders its tab');

    // Phase 4 chrome isolation is intact.
    assert.equal(results.sidebarToggle.tabsRendered, 0, 'sidebar toggle renders no tab');
    assert.equal(results.sidebarToggle.app, 0, 'sidebar toggle does not re-render AppContent');
    assert.equal(results.modalOpen.tabsRendered, 0, 'opening settings renders no tab');
    assert.equal(results.modalOpen.app, 0, 'opening settings does not re-render AppContent');
    assert.equal(results.modalOpen.memorySettings, 1, 'opening settings mounts one panel');

    console.log('Tab-switch isolation: correct pane activates, only the transition renders, redundant per-tab updates collapse, chrome isolation intact.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
}
