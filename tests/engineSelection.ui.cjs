const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-selection-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/engineSelection.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'isolate-app-state', setup(build) {
        build.onResolve({ filter: /(?:MemorySettings|TerminalLog|useAvatarSettings|MemoryPalace|ChatInterface|Titlebar)/ }, args => ({ path: args.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
          export default function Stub() { return { settings: {} }; }
          export const useTerminalLog = () => ({});
          export const useMemoryPalace = () => ({ limit: null, totalTokens: null });
          export const ChatInterface = ({selectedModel, activeChatProvider}) => { window.chatModel = selectedModel; window.chatProvider = activeChatProvider; return null; };
          export const Titlebar = () => null;
        ` }));
      } }],
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const results = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 60));
      const label = () => document.querySelector('[aria-label="Select or load model"]').textContent;
      const scanned = [{id: '/first.gguf', name: 'First'}, {id: '/last.gguf', name: 'Last'}];
      const stopped = { running: false, isLoaded: false, modelPath: null, modelName: null };
      localStorage.removeItem('lastSelectedModelPath');
      mountApp({status: stopped, scanned}); await wait(); const empty = label();
      localStorage.setItem('lastSelectedModelPath', '/last.gguf');
      mountApp({status: stopped, scanned}); await wait(); const remembered = label();
      const loaded = {running: true, isLoaded: true, contextStatus: 'ready', modelPath: '/active-outside-scan.gguf', modelName: 'Active', pid: 7};
      mountApp({status: loaded, scanned}); await wait();
      const active = {label: label(), model: chatModel, stored: localStorage.getItem('lastSelectedModelPath')};
      mountApp({status: loaded, scanned: scanned.slice().reverse()}); await wait(); const refreshed = label();
      mountApp({status: stopped, delayed: true, scanned}); await wait();
      emitStatus(loaded); await wait(); resolveInitialStatus(stopped); await wait(); const raced = label();
      emitStatus(stopped); await wait(); const unloaded = label();
      document.querySelector('[aria-label="Select or load model"]').click(); await wait();
      [...document.querySelectorAll('dialog button')].find(button => button.textContent.includes('OpenAI')).click(); await wait();
      emitStatus(loaded); await wait();
      const cloudAfterEngineStatus = { label: label(), provider: chatProvider.type, model: chatModel };
      emitStatus(stopped); await wait();
      const cloudAfterUnload = { label: label(), provider: chatProvider.type, model: chatModel };
      return {empty, remembered, active, refreshed, raced, unloaded, cloudAfterEngineStatus, cloudAfterUnload};
    })()`);
    assert.match(results.empty, /Select Model/);
    assert.doesNotMatch(results.empty, /First/);
    assert.match(results.remembered, /Last.*Not loaded/);
    assert.match(results.active.label, /Active.*Ready/);
    assert.equal(results.active.model, '/active-outside-scan.gguf');
    assert.equal(results.active.stored, '/active-outside-scan.gguf');
    assert.match(results.refreshed, /Active.*Ready/);
    assert.match(results.raced, /Active.*Ready/);
    assert.match(results.unloaded, /Not loaded/);
    assert.doesNotMatch(results.unloaded, /Ready/);
    for (const state of [results.cloudAfterEngineStatus, results.cloudAfterUnload]) {
      assert.equal(state.provider, 'cloud');
      assert.equal(state.model, 'cloud:openai:test-cloud');
      assert.match(state.label, /openai.*Cloud/);
      assert.doesNotMatch(state.label, /Not loaded/);
    }
    console.log('Engine selection: empty startup, saved preference, active model outside scan, remount, stale response, and unload passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
