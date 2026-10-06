// Regression: restored tabs must keep their `saved` flag across a restart, or
// ChatInterface skips the transcript load and every tab reopens empty while its
// title still shows. The flag is set through markTabSaved(sessionId) exactly as
// App.jsx wires it — unbound, session id only. Mirrors sessionDraft.ui.cjs: one
// executeJavaScript per phase (checks throw on failure), reload on the Node side.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-saved-flag-'));
  app.setPath('userData', directory);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let exitCode = 0;
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures', 'tabSavedFlag.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));

    // Phase 1 — the send/sidebar/branch paths all call markTabSaved(sessionId)
    // with no tab id bound; each must flag its matching tab in persisted state.
    const firstLoad = await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      for (let i = 0; i < 150 && !window.tabsApi; i++) await tick(20);
      check(window.tabsApi, 'TabProvider mounted');

      // A call without a session id must not corrupt state — no tab may be
      // marked saved by it.
      window.tabsApi.markTabSaved();
      const before = JSON.parse(localStorage.getItem('continuum_open_tabs')).tabs;
      check(before.every(tab => !tab.saved), 'undefined session marks nothing');

      // The send path: markTabSaved(sessionId) with no tab id bound must flag
      // the matching tab in persisted state.
      window.tabsApi.markTabSaved('s1');
      await tick(30);
      const persisted = JSON.parse(localStorage.getItem('continuum_open_tabs')).tabs;
      check(persisted.find(tab => tab.sessionId === 's1').saved === true, 'send path persists saved flag by session id');
      check(persisted.find(tab => tab.sessionId === 's2').saved !== true, 'unrelated tabs stay unsaved');

      // The sidebar-load and branch paths call it the same way; a second
      // session must be flagged independently.
      window.tabsApi.markTabSaved('s2');
      await tick(30);
      const both = JSON.parse(localStorage.getItem('continuum_open_tabs')).tabs;
      check(both.every(tab => tab.saved === true), 'every known session can be flagged by its id');
      return true;
    })()`);
    assert.equal(firstLoad, true);

    // Phase 2 — simulate the restart from the main process: a fresh window must
    // restore both tabs with the flag intact so ChatInterface loads transcripts.
    await window.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    const restored = await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 150 && !window.tabsApi; i++) await new Promise(r => setTimeout(r, 20));
      if (!window.tabsApi) throw new Error('TabProvider did not remount after reload');
      const tabs = JSON.parse(localStorage.getItem('continuum_open_tabs')).tabs;
      if (tabs.length !== 2) throw new Error('both tabs must survive the restart');
      if (tabs.find(tab => tab.sessionId === 's1').saved !== true) throw new Error('restored tab must keep saved flag');
      return true;
    })()`);
    assert.equal(restored, true);
    console.log('Saved-flag wiring survives an unbound call and a full restart.');
  } catch (error) {
    exitCode = 1;
    console.error('FAIL: ' + (error && error.message));
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(exitCode);
}).catch(error => { console.error(error); app.exit(1); });
