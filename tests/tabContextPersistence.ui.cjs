// Phase 6 tab-context persistence suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/tabContextPersistence.ui.cjs
//
// Mounts the REAL TabProvider against an instrumented localStorage, so the
// counts below are the actual setItem / JSON.stringify operations the provider
// performs for tab state. `RESULTS {...}` is always printed so the same suite
// can establish a baseline on an unmodified tree before the phase's changes.
const IS_ELECTRON = !!process.versions.electron;
if (!IS_ELECTRON) {
  const test = require('node:test');
  test('tab-context persistence requires the electron harness', async (t) => {
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

const TAB_KEY = 'continuum_open_tabs';
const seed = {
  tabs: [
    { id: 'tab_a', sessionId: 'sa', title: 'First', modelId: 'm1', projectId: null, permissionMode: 'ask_approval', view: 'chat', saved: true },
    { id: 'tab_b', sessionId: 'sb', title: 'Second', modelId: 'm1', projectId: null, permissionMode: 'ask_approval', view: 'chat', saved: true },
  ],
  activeTabId: 'tab_a',
};

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-ctx-persistence-'));
  const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures/tabContextPersistence.jsx')],
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));

    const results = await window.webContents.executeJavaScript(`(async () => {
      const KEY = ${JSON.stringify(TAB_KEY)};
      const SEED = ${JSON.stringify(seed)};
      const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (fn, tries = 200) => { for (let i = 0; i < tries; i += 1) { if (fn()) return; await wait(); } throw new Error('timeout'); };
      const readStored = () => JSON.parse(localStorage.getItem(KEY));
      const storedTab = (id) => readStored().tabs.find((tab) => tab.id === id);
      // Keep the hydration validation from dropping the seeded tabs.
      window.memoryPalace = { getAllSessions: async () => [{ folder_name: 'General', sessions: [{ id: 'sa' }, { id: 'sb' }] }] };
      window.chatAPI = {};

      const seedStorage = () => { localStorage.setItem(KEY, JSON.stringify(SEED)); };

      const out = {};

      // --- Startup: restored state must not be immediately rewritten ---
      localStorage.clear();
      seedStorage();
      window.resetPersistenceCounters();
      window.mountProvider({ strict: false });
      await until(() => window.tabsApi);
      await wait(200);
      out.startup = { writes: window.tabWrites.length, serializes: window.tabSerializeCount };

      // --- Rapid functional updates in the same tick coalesce ---
      window.resetPersistenceCounters();
      window.tabsApi.updateTab('tab_a', { title: 'A1' });
      window.tabsApi.updateTab('tab_a', { title: 'A2' });
      window.tabsApi.updateTab('tab_a', { title: 'A3' });
      await wait(80);
      out.rapidUpdates = {
        writes: window.tabWrites.length,
        serializes: window.tabSerializeCount,
        finalTitle: storedTab('tab_a').title,
      };

      // --- A status-only change is not a persistent change ---
      window.resetPersistenceCounters();
      window.tabsApi.updateTab('tab_a', { status: 'generating' });
      await wait(80);
      out.statusOnly = {
        writes: window.tabWrites.length,
        inMemoryStatus: window.tabsApi.tabs.find((tab) => tab.id === 'tab_a').status,
      };

      // --- A persistent metadata change is written ---
      window.resetPersistenceCounters();
      window.tabsApi.updateTab('tab_a', { modelId: 'm2' });
      await wait(80);
      out.modelChange = { writes: window.tabWrites.length, persistedModelId: storedTab('tab_a').modelId };

      // --- Create then close a tab ---
      window.resetPersistenceCounters();
      const newId = window.tabsApi.openTab('m');
      await until(() => storedTab(newId));
      const afterOpen = readStored();
      window.tabsApi.closeTab(newId);
      await wait(80);
      const afterClose = readStored();
      out.createClose = {
        writes: window.tabWrites.length,
        openCount: afterOpen.tabs.length,
        closeCount: afterClose.tabs.length,
        closedPurged: !afterClose.tabs.some((tab) => tab.id === newId),
      };

      // --- Active-tab selection is persisted; re-selecting is a no-op ---
      window.resetPersistenceCounters();
      window.tabsApi.activateTab('tab_a');
      await wait(80);
      out.activate = { writes: window.tabWrites.length, persistedActive: readStored().activeTabId };
      window.resetPersistenceCounters();
      window.tabsApi.activateTab('tab_a');
      await wait(80);
      out.reactivate = { writes: window.tabWrites.length, persistedActive: readStored().activeTabId };

      // --- A failed write is not marked as persisted; a later change retries ---
      window.resetPersistenceCounters();
      const titleBefore = storedTab('tab_a').title;
      window.failTabWrites = true;
      window.tabsApi.updateTab('tab_a', { title: 'Retry me' });
      await wait(80);
      const afterFailure = storedTab('tab_a').title;
      window.failTabWrites = false;
      // Same persistent payload (status is stripped) — a successful write must
      // still happen because the previous attempt failed.
      window.tabsApi.updateTab('tab_a', { status: 'idle' });
      await wait(80);
      out.failedWrite = {
        titleBefore,
        afterFailure,
        afterRetry: storedTab('tab_a').title,
      };

      // --- StrictMode: the updater runs twice but persists once ---
      localStorage.clear();
      seedStorage();
      window.mountProvider({ strict: true });
      await until(() => window.tabsApi);
      await wait(200);
      window.resetPersistenceCounters();
      window.tabsApi.updateTab('tab_a', { title: 'Strict' });
      await wait(80);
      out.strictMode = { writes: window.tabWrites.length, title: storedTab('tab_a').title };

      return out;
    })()`);

    process.stderr.write('RESULTS ' + JSON.stringify(results) + '\n');

    // Startup must not rewrite the restored representation.
    assert.equal(results.startup.writes, 0, 'restored state is not rewritten on startup');
    // Three same-tick updates coalesce into one write holding the final value.
    assert.equal(results.rapidUpdates.writes, 1, 'rapid updates coalesce to one write');
    assert.equal(results.rapidUpdates.finalTitle, 'A3', 'the latest update wins');
    assert.equal(results.rapidUpdates.serializes, 1, 'one serialization for the batch');
    // A status-only change is not persisted (status is runtime-only).
    assert.equal(results.statusOnly.writes, 0, 'status-only change is not written');
    assert.equal(results.statusOnly.inMemoryStatus, 'generating', 'status still updates in memory');
    // A persistent metadata change is written exactly once.
    assert.equal(results.modelChange.writes, 1, 'model change is written');
    assert.equal(results.modelChange.persistedModelId, 'm2', 'model change is durable');
    // Create + close.
    assert.equal(results.createClose.writes, 2, 'open and close each write once');
    assert.equal(results.createClose.openCount, 3, 'open adds a tab');
    assert.equal(results.createClose.closeCount, 2, 'close removes the tab');
    assert.equal(results.createClose.closedPurged, true, 'the closed tab is purged from storage');
    // Active-tab selection is persisted; re-selecting the active tab is a no-op.
    assert.equal(results.activate.writes, 1, 'activation is written');
    assert.equal(results.activate.persistedActive, 'tab_a', 'active tab is persisted');
    assert.equal(results.reactivate.writes, 0, 're-selecting the active tab writes nothing');
    // A failed write is retried on the next change and never lost.
    assert.equal(results.failedWrite.afterFailure, results.failedWrite.titleBefore, 'a failed write stored nothing');
    assert.equal(results.failedWrite.afterRetry, 'Retry me', 'the failed change is persisted on retry');
    // StrictMode double-invokes the updater but persists once.
    assert.equal(results.strictMode.writes, 1, 'StrictMode persists once');
    assert.equal(results.strictMode.title, 'Strict', 'StrictMode persists the right value');

    console.log('Tab-context persistence: pure updaters, coalesced writes, unchanged payloads skipped, failures retried.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
}
