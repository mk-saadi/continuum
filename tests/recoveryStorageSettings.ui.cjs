// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/recoveryStorageSettings.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'recovery-settings-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import RecoveryStorageSettings from './src/components/settings/RecoveryStorageSettings';
        window.saved = null;
        window.pruned = 0;
        window.api = {
          getAppSettings: async () => ({ recoveryRetentionDays: 30, recoveryStorageCapMB: 512 }),
          saveAppSettings: async (patch) => {
            if (patch.recoveryRetentionDays !== undefined && (patch.recoveryRetentionDays < 1 || patch.recoveryRetentionDays > 365)) throw new Error('Recovery retention must be an integer from 1 to 365 days.');
            if (patch.recoveryStorageCapMB !== undefined && (patch.recoveryStorageCapMB < 64 || patch.recoveryStorageCapMB > 8192)) throw new Error('Recovery storage cap must be an integer from 64 to 8192 MB.');
            window.saved = patch;
            return { recoveryRetentionDays: 30, recoveryStorageCapMB: 512, ...patch };
          },
          getRecoveryStats: async () => ({ physicalBytes: 1572864, logicalBytes: 2097152, blobFiles: 12, referencedBlobs: 10, checkpointCount: 4, sessionCount: 1 }),
          pruneRecoveryStore: async () => { window.pruned++; return { pruned: [1], capEvicted: [], kept: 3, capShortfallMB: 0, storage: {} }; },
        };
        createRoot(document.getElementById('root')).render(<RecoveryStorageSettings />);
      `, loader: 'jsx', resolveDir: process.cwd() },
      bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      for (let i = 0; i < 80 && !text().includes('Workspace recovery storage'); i++) await tick();
      check(text().includes('1.5 MB on disk'), 'physical usage shown separately');
      check(text().includes('2.0 MB of history'), 'logical history shown separately');
      check(text().includes('never forced out') || text().includes('pinned'), 'pin guarantee stated');
      const setNative = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const commit = (element) => element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      const inputs = document.querySelectorAll('input[type=number]');
      check(inputs.length === 2, 'retention + cap fields only, small surface');
      setNative(inputs[0], '7');
      commit(inputs[0]); await tick(); await tick();
      check((await (async () => window.saved)()).recoveryRetentionDays === 7, 'retention saves on blur');
      setNative(inputs[1], '8');
      commit(inputs[1]); await tick(); await tick();
      check(text().includes('64 to 8192'), 'invalid cap rejected with the real message');
      const prune = [...document.querySelectorAll('button')].find(b => b.textContent === 'Clean up now');
      check(prune && !prune.disabled, 'manual cleanup offered');
      prune.click(); await tick(); await tick();
      check((await (async () => window.pruned)()) === 1, 'cleanup dispatches once');
      check(text().includes('removed 1'), 'cleanup report shown');
    })()`);
    console.log('Recovery storage settings fields, validation, usage split, and cleanup passed.');
    await fs.writeFile(process.env.RECOVERY_UI_MARKER, 'ok');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
