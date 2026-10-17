// Terminal-log isolation: engine output must update only the log panel, never
// AppContent (and, by extension, unrelated mounted tabs/chats).
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/terminalLogIsolation.ui.cjs
//
// The real App shell is rendered with the heavy children stubbed. The Titlebar
// stub counts invocations, which is a direct proxy for AppContent rendering:
// Titlebar is a plain (non-memoized) child, so any AppContent render re-invokes
// it. Output is delivered through a fake terminalAPI that the store subscribes
// to at module load, exactly as the preload bridge works in production.
const IS_ELECTRON = !!process.versions.electron;
if (!IS_ELECTRON) {
  const test = require('node:test');
  test('terminal-log isolation browser flow requires the electron harness', async (t) => {
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
// Electron quits when the last window closes, which would swallow a late
// rejection from the finally block and exit 0 silently.
app.on('window-all-closed', (event) => event.preventDefault());
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-log-isolation-'));
  const window = new BrowserWindow({ width: 900, height: 800, show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures/terminalLogIsolation.jsx')],
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
      // Stub the heavy App children. TerminalLog is intentionally NOT stubbed:
      // the isolation fixture imports the real one.
      plugins: [{
        name: 'isolate-app-state',
        setup(build) {
          build.onResolve({ filter: /(?:MemorySettings|useAvatarSettings|MemoryPalace|ChatInterface|Titlebar)/ }, args => ({ path: args.path, namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
            export default function Stub() { return { settings: {} }; }
            export const useMemoryPalace = () => ({ limit: null, totalTokens: null });
            export const ChatInterface = () => null;
            export const Titlebar = () => { window.titlebarRenders = (window.titlebarRenders || 0) + 1; return null; };
          ` }));
        },
      }],
    });
    await fs.writeFile(path.join(directory, 'index.html'), `<!doctype html><html><body>
      <div id="app"></div><div id="log"></div>
      <script>
        window.__outputListeners = new Set();
        window.terminalAPI = {
          onStatus: (fn) => { window.__emitStatus = fn; return () => {}; },
          status: async () => ({ running: false, isLoaded: false, modelPath: null, modelName: null }),
          onOutput: (fn) => { window.__outputListeners.add(fn); return () => window.__outputListeners.delete(fn); },
        };
        window.emitTerminal = (data, stream = 'stdout') => { for (const fn of [...window.__outputListeners]) fn({ stream, data }); };
      </script>
      <script src="fixture.js"></script>
    </body></html>`);
    await window.loadFile(path.join(directory, 'index.html'));

    const results = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
      const domLines = () => [...document.querySelectorAll('[aria-label="Terminal output"] > div')].map(node => node.textContent);
      const emptyState = () => document.querySelector('[aria-label="Terminal output"]').textContent;

      window.mountApp();
      for (let i = 0; i < 200 && !window.titlebarRenders; i += 1) await wait();
      // Let mount-time async work (project scan, engine status) settle so any
      // remaining renders are attributable to terminal output.
      await wait(600);
      const appRendersBefore = window.titlebarRenders;
      const storeBefore = window.getLogLines().length;
      const fixtureBeforeMount = window.logFixtureRenders || 0;

      // A burst of output while no log panel is mounted.
      window.emitTerminal('engine booting\\n');
      window.emitTerminal('loading tensors\\n');
      window.emitTerminal('bind failed\\n', 'stderr');
      window.emitTerminal('model loaded\\n');
      await wait(200);

      const afterBurst = {
        appRenders: window.titlebarRenders,
        storeLength: window.getLogLines().length,
        fixtureRenders: window.logFixtureRenders || 0,
      };

      // Opening the panel shows history collected while it was closed.
      window.mountLogPanel();
      await wait(60);
      const openedLines = domLines();
      const logFixtureRendersAtOpen = window.logFixtureRenders;

      // Live output updates the panel without re-rendering its parent.
      window.emitTerminal('live chunk\\n');
      await wait(200);
      const afterLive = { lines: domLines(), fixtureRenders: window.logFixtureRenders, appRenders: window.titlebarRenders };

      // Unmount, collect while closed, remount: no loss and no duplicates.
      window.unmountLogPanel();
      window.emitTerminal('while closed\\n');
      await wait(200);
      window.mountLogPanel();
      await wait(60);
      const reopened = domLines();

      // Clear empties the view and the store.
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Clear logs').click();
      await wait(60);
      const cleared = { lines: domLines(), storeLength: window.getLogLines().length, empty: emptyState() };

      return {
        order: openedLines,
        afterBurst,
        appRendersBefore,
        storeBefore,
        fixtureBeforeMount,
        logFixtureRendersAtOpen,
        afterLive,
        reopened,
        cleared,
      };
    })()`);

    // Output reached the store...
    assert.equal(results.afterBurst.storeLength, results.storeBefore + 4, 'every chunk is retained in order');
    // ...but AppContent did not render because of it.
    assert.equal(results.afterBurst.appRenders, results.appRendersBefore, 'terminal output must not re-render AppContent');
    // No log consumer was mounted yet, so nothing subscribed re-rendered either.
    assert.equal(results.afterBurst.fixtureRenders, results.fixtureBeforeMount);

    // Opening the panel shows the history collected while it was closed.
    assert.deepEqual(results.order, ['engine booting\n', 'loading tensors\n', 'bind failed\n', 'model loaded\n']);

    // Live output updated the DOM but not the log panel's parent.
    assert.deepEqual(results.afterLive.lines, ['engine booting\n', 'loading tensors\n', 'bind failed\n', 'model loaded\n', 'live chunk\n']);
    assert.equal(results.afterLive.fixtureRenders, results.logFixtureRendersAtOpen, 'subscribing component does not re-render on output');
    assert.equal(results.afterLive.appRenders, results.appRendersBefore, 'AppContent stays quiet while the panel is open too');

    // Nothing lost, nothing duplicated across unmount/remount.
    assert.deepEqual(results.reopened, ['engine booting\n', 'loading tensors\n', 'bind failed\n', 'model loaded\n', 'live chunk\n', 'while closed\n']);
    assert.equal(results.reopened.filter(line => line === 'while closed\n').length, 1, 'remount does not duplicate collected lines');

    // Clear works and is reflected in the store.
    assert.deepEqual(results.cleared.lines, []);
    assert.equal(results.cleared.storeLength, 0);
    assert.match(results.cleared.empty, /No output yet/);

    console.log('Terminal-log isolation: AppContent untouched, ordered buffered history, remount without duplicates, and clear all passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
}
