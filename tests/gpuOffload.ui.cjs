// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/gpuOffload.ui.cjs
// Covers the VRAM preflight confirmation flow in ModelSettingsModal: warning,
// continue-anyway, cancel, and that the user's K/V precision is never altered.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-offload-ui-'));
  const window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ModelSettingsModal from './src/components/ModelSettingsModal';
      const root = createRoot(document.getElementById('root'));
      const baseConfig = { contextLength: 100000, threads: 4, evalBatch: 1024, physicalBatch: 1024, parallel: 1, gpuOffload: 'auto', flashAttention: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', mlock: false, chatTemplate: 'auto', reasoningFormat: 'auto' };
      const model = { id: 'big', name: 'Big', modelPath: '/models/big.gguf', fileIdentity: { size: 10 * 1024 ** 3 }, layerCount: 64, attentionHeads: 32, kvHeads: 8, embeddingLength: 4096 };
      const assessment = { status: 'insufficient', message: 'Estimated ~21,115 MiB of GPU memory needed for full GPU offload, but only ~2,000 MiB is free on RTX 5060 Ti.', estimatedMiB: 21115, freeMiB: 2000, device: { name: 'RTX 5060 Ti' } };
      window.launches = []; window.closeCount = 0; window.loaded = [];
      window.api = {
        getModelLoadConfig: async () => ({ config: baseConfig, remembered: true }),
        launchEngine: async (_id, config) => {
          window.launches.push(config);
          if (!config.allowPartialOffload) return { success: false, requiresConfirmation: true, assessment };
          return { success: true, modelPath: '/models/big.gguf' };
        },
      };
      window.renderLoad = () => root.render(<ModelSettingsModal model={model} onClose={() => { window.closeCount += 1; }} onLoaded={(result) => window.loaded.push(result)} />);
      window.renderEmpty = () => root.render(<React.Fragment />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(process.cwd(), 'dist/assets');
    const css = (await fs.readdir(assets)).find(name => name.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 100));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const submit = () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const byText = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);

      window.renderLoad(); await tick();
      check(![...document.querySelectorAll('[role=alert]')].some(node => node.textContent.includes('free on')), 'no VRAM warning before submitting');

      submit(); await tick();
      check(window.launches.length === 1, 'first submit reaches the engine');
      check(window.launches[0].allowPartialOffload === false, 'first launch does not pre-acknowledge partial offload');
      check(window.launches[0].cacheTypeK === 'q8_0' && window.launches[0].cacheTypeV === 'q4_0', 'K/V precision is not altered by the preflight');
      check(window.loaded.length === 0, 'engine is not reported loaded while awaiting confirmation');
      check([...document.querySelectorAll('[role=alert]')].some(node => node.textContent.includes('only ~2,000 MiB is free on RTX 5060 Ti')), 'VRAM warning is shown before loading');
      check(byText('Continue anyway'), 'continue option is offered');
      check(byText('Cancel load'), 'cancel option is offered');

      byText('Continue anyway').click(); await tick();
      check(window.launches.length === 2, 'continue retries the launch');
      check(window.launches[1].allowPartialOffload === true, 'continue acknowledges partial offload');
      check(window.loaded.length === 1 && window.closeCount === 1, 'engine loads and the modal closes after acknowledgement');

      window.renderEmpty(); await tick(); window.renderLoad(); await tick();
      submit(); await tick();
      check(window.launches.length === 3, 'a fresh load reaches the engine again');
      byText('Cancel load').click(); await tick();
      check(window.launches.length === 3, 'cancel does not launch again');
      check(window.closeCount === 2, 'cancel closes the modal so GPU memory can be freed');
      check([...document.querySelectorAll('[role=alert]')].every(node => !node.textContent.includes('free on')), 'warning is dismissed after cancelling');
    })()`);
    console.log('GPU offload preflight: warning, continue, cancel, and unchanged K/V precision passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
