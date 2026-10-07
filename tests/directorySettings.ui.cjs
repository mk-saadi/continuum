// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/directorySettings.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'directory-settings-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import DirectorySettings from './src/components/DirectorySettings';
        window.picked = null;
        window.api = {
          getConfig: async () => ({ modelDirectory: '/models', appDataDirectory: '/data' }),
          pickDirectory: async () => window.picked,
          setModelDirectory: async directory => directory,
          migrateAppData: () => new Promise((resolve, reject) => { window.failMigration = reject; }),
        };
        window.scans = 0;
        window.addEventListener('model-directory-changed', () => window.scans++);
        createRoot(document.getElementById('root')).render(<DirectorySettings />);
      `, loader: 'jsx', resolveDir: process.cwd() },
      bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 40 && !document.querySelector('button'); i++) await tick();
      await tick();
      const buttons = document.querySelectorAll('section button');
      check(document.body.textContent.includes('/models') && document.body.textContent.includes('/data'), 'Shows configured directories');
      buttons[0].click(); await tick();
      check(document.body.textContent.includes('/models'), 'Cancel leaves model path unchanged');
      window.picked = '/new-models'; buttons[0].click(); await tick();
      check(document.body.textContent.includes('/new-models') && window.scans === 1, 'Model change saves and requests rescan');
      window.picked = '/new-data'; buttons[1].click(); await tick();
      check(document.querySelector('dialog').open, 'Migration overlay is modal');
      check(document.querySelector('[role=status]').textContent.includes('Do not close'), 'Migration warning visible');
      check(buttons[0].disabled && buttons[1].disabled, 'Changes blocked while migrating');
      const cancel = new Event('cancel', { cancelable: true }); document.querySelector('dialog').dispatchEvent(cancel);
      check(cancel.defaultPrevented, 'Escape cannot dismiss migration');
      window.failMigration(new Error('Copy verification failed')); await tick();
      check(!document.querySelector('dialog').open && !buttons[1].disabled, 'Failure restores controls');
      check(document.querySelector('[role=alert]').textContent.includes('Copy verification failed'), 'Failure displayed');
      check(document.body.textContent.includes('/data'), 'Failure preserves displayed source path');
    })()`);
    console.log('Directory settings display, picker cancellation, model rescan, migration overlay, and failure recovery passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
