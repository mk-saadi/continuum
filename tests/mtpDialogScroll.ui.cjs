// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/mtpDialogScroll.ui.cjs
//
// Regression test: toggling a checkbox (e.g. Multi-token prediction / MTP) in
// the Model load settings dialog used to scroll the dialog element itself
// (overflow:hidden is still programmatically scrollable), clipping the header
// off the top. The sr-only checkbox input is position:absolute and used to
// escape the inner scroll container to the fixed dialog; focus-reveal then
// scrolled the dialog to "reveal" it. The label is now the containing block
// (relative) and the dialog uses overflow:clip, so this must stay at 0.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mtp-scroll-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ModelSelectorModal from './src/components/main-app/ModelSelectorModal';
      const mmproj = { path: '/models/1-mmproj.gguf', name: 'mmproj-f16', fileIdentity: { size: 419430400 } };
      const models = ['Gemma 4 26B A4B', 'Qwen 3.8 27B'].map((name, index) => ({ id: '/models/' + index + '.gguf', modelPath: '/models/' + index + '.gguf', generalName: name, name, architecture: 'qwen3moe', paramSize: '27B', quantization: 'Q4_K_M', sizeFormatted: '15.76 GB', hasVision: !!index, hasTools: true, hasReasoning: true, layerCount: 48, isMoe: true, expertCount: 256, activeExpertCount: 8, attentionHeads: 64, kvHeads: 8, embeddingLength: 4096, keyLength: 128, valueLength: 128, contextLength: 262144, mtpLayers: 1, fileIdentity: { size: 18035507424 }, projectorCandidates: index ? [mmproj] : [], mmprojPath: index ? mmproj.path : null, declaredCapabilities: { image: !!index } }));
      window.savedOverrides = {};
      window.api = { fetchCloudModels: async () => ({ models: [] }), getCapabilityOverrides: async () => window.savedOverrides, saveCapabilityOverrides: async (target, overrides) => { window.savedOverrides = { ...window.savedOverrides, ...overrides }; return { ...window.savedOverrides }; }, getCloudModelMetadata: async () => [], getModelLoadConfig: async () => ({ config: {}, remembered: false }), launchEngine: async () => ({ success: true }) };
      window.terminalAPI = { kill: async () => ({ success: true }) };
      const root = createRoot(document.getElementById('root'));
      root.render(<ModelSelectorModal models={models} cloudProviders={[]} loadedLocalModel={{modelPath: models[0].id, name: models[0].generalName, capabilities: { image: false, audio: false }}} activeChatProvider={{type: 'local'}} selectedModel={models[0].id} engineRunning onSelectProvider={() => {}} onSelectModel={() => {}} onClose={() => {}} onScan={() => {}} onLoaded={() => {}} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find(name => name.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), `<link rel="stylesheet" href="fixture.css"><style>body{background:#10131c;--surface:#191e2e;--border:#343c53;--text-primary:#e6e8f0;--text-secondary:#b4bdce;--text-muted:#8290aa;--input:#141925;--accent:#eba074;--active-chat:#3c3048;--surface-hover:#252b3d}</style><div id="root"></div><script src="fixture.js"></script>`);
    await window.loadFile(path.join(directory, 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 200));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 60));
      const settingsDialog = () => [...document.querySelectorAll('dialog')].find(d => d.open && d.querySelector('#load-settings-title'));
      const rows = [...document.querySelectorAll('ul[aria-label="Available models"] > li')];
      rows.find(r => r.textContent.includes('Qwen 3.8 27B')).querySelector('button').click(); await tick();
      const dialog = settingsDialog();
      if (!dialog) throw new Error('Load settings dialog did not open');
      if (dialog.scrollTop !== 0) throw new Error('Dialog scrolled on open: ' + dialog.scrollTop);
      const overflow = getComputedStyle(dialog).overflow;
      if (overflow !== 'clip' && overflow !== 'clip visible') throw new Error('Dialog overflow is not clip: ' + overflow);
      const blur = () => { const a = document.activeElement; if (a && a.blur) a.blur(); };
      const labels = [...dialog.querySelectorAll('label')];
      const toggleLabels = labels.filter(l => l.querySelector('input[type=checkbox]'));
      if (!toggleLabels.some(l => l.textContent.includes('Multi-token prediction'))) throw new Error('MTP checkbox missing');
      for (const label of toggleLabels) {
        label.click(); await tick(); blur();
        if (dialog.scrollTop !== 0) throw new Error('Dialog scrolled to ' + dialog.scrollTop + ' after clicking: ' + label.textContent.slice(0, 40));
        const title = dialog.querySelector('#load-settings-title');
        const titleRect = title.getBoundingClientRect();
        const dialogRect = dialog.getBoundingClientRect();
        if (titleRect.top < dialogRect.top) throw new Error('Header clipped after clicking: ' + label.textContent.slice(0, 40));
      }
      const footer = dialog.querySelector('footer');
      if (footer.getBoundingClientRect().bottom > dialog.getBoundingClientRect().bottom + 1) throw new Error('Footer pushed out of the dialog');
      return { toggled: toggleLabels.length, scrollTop: dialog.scrollTop };
    })()`);
    assert.ok(result.toggled >= 2, 'Expected at least two checkboxes to exercise');
    assert.equal(result.scrollTop, 0);
    console.log('Checkbox toggles keep the load dialog unscrolled (MTP layout bug regression) passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
