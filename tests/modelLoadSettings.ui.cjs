// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/modelLoadSettings.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'model-load-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ModelSettingsModal from './src/components/ModelSettingsModal';
      const root = createRoot(document.getElementById('root'));
      const baseConfig = { contextLength: 8192, threads: 4, evalBatch: 2048, physicalBatch: 512, parallel: 1, gpuOffload: 'auto', flashAttention: 'auto', cacheTypeK: 'f16', cacheTypeV: 'f16', mlock: false, chatTemplate: 'auto', reasoningFormat: 'auto' };
      window.savedConfig = {};
      window.api = {
        getModelLoadConfig: async () => ({ config: { ...baseConfig, ...window.savedConfig }, remembered: Object.keys(window.savedConfig).length > 0 }),
        launchEngine: async (_id, config) => { window.launched = config; window.savedConfig = config; return { success: true }; },
      };
      const moeModel = { id: 'model', name: 'Gemma4 A4B', architecture: 'gemma4', isMoe: true, expertCount: 128 };
      window.renderLoad = (model = moeModel) => root.render(<ModelSettingsModal model={model} onClose={() => {}} onLoaded={() => {}} />);
      window.renderEmpty = () => root.render(<React.Fragment />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 80));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const change = (element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
      const field = label => { const node = [...document.querySelectorAll('label')].find(node => node.textContent === label); return node?.parentElement.querySelector('select'); };
      const numberField = label => { const node = [...document.querySelectorAll('label')].find(node => node.textContent === label); return node?.parentElement.querySelector('input[type=number]'); };
      const toggle = label => { const node = [...document.querySelectorAll('label')].find(node => node.textContent.includes(label)); return node?.querySelector('input'); };
      const setNumber = (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const submit = () => { document.querySelector('button[type=submit]').click(); };
      const remount = async () => { window.renderEmpty(); await tick(); window.renderLoad(); await tick(); };

      // New controls render with safe defaults.
      window.renderLoad(); await tick();
      check(field('KV Cache Offload'), 'KV cache offload control exists');
      check(field('Load Mode'), 'Load mode control exists');
      check(numberField('MoE Expert Count'), 'MoE expert count control exists');
      check(field('KV Cache Offload').value === 'gpu', 'KV offload defaults to GPU');
      check(field('Load Mode').value === 'auto', 'Load mode defaults to auto');
      check(numberField('MoE Expert Count').value === '', 'MoE expert count defaults to auto');
      check(toggle('Lock in System RAM').disabled === false, 'mlock stays editable while load mode is auto');
      check(numberField('MoE Expert Count').disabled === false, 'MoE expert count enabled when architecture is known');
      check([...document.querySelectorAll('p')].some(node => node.textContent.includes('this model reports 128')), 'Detected expert count surfaced in the hint');

      // Change the new settings and verify they reach the launch payload.
      change(field('Load Mode'), 'none'); await tick();
      check(toggle('Lock in System RAM').disabled === true, 'mlock follows the load mode selection');
      check(toggle('Lock in System RAM').checked === false, 'Load mode none implies mlock off');
      change(field('KV Cache Offload'), 'cpu'); await tick();
      change(field('K-Cache Precision'), 'q8_0'); await tick();
      setNumber(numberField('MoE Expert Count'), '120'); await tick();
      submit(); await tick();
      check(window.launched.loadMode === 'none', 'Load mode none reaches the launch payload');
      check(window.launched.kvCacheOffload === 'cpu', 'KV offload reaches the launch payload');
      check(window.launched.moeExpertCount === 120, 'MoE expert count reaches the launch payload');
      check(window.launched.cacheTypeK === 'q8_0' && window.launched.cacheTypeV === 'f16', 'Explicit K/V precision is not overwritten');
      check(window.launched.mlock === false, 'mlock off for load mode none');

      // Values persist across a reload of the modal.
      await remount();
      check(field('Load Mode').value === 'none', 'Load mode persisted');
      check(field('KV Cache Offload').value === 'cpu', 'KV offload persisted');
      check(numberField('MoE Expert Count').value === '120', 'MoE expert count persisted');
      check(field('K-Cache Precision').value === 'q8_0', 'K precision persisted');
      check(field('V-Cache Precision').value === 'f16', 'V precision persisted');

      // mlock-style load modes imply and pin the mlock option.
      change(field('Load Mode'), 'mmap+mlock'); await tick();
      check(toggle('Lock in System RAM').checked === true && toggle('Lock in System RAM').disabled === true, 'mmap+mlock implies locked mlock');
      submit(); await tick();
      check(window.launched.loadMode === 'mmap+mlock' && window.launched.mlock === true, 'mmap+mlock payload keeps mlock');

      // A saved config from before these settings existed still loads unchanged.
      window.savedConfig = { contextLength: 8192, threads: 4, evalBatch: 2048, physicalBatch: 512, parallel: 1,
        gpuOffload: 'auto', mlock: true, flashAttention: 'auto', cacheTypeK: 'q4_0', cacheTypeV: 'q4_0',
        chatTemplate: 'auto', reasoningFormat: 'auto' };
      await remount();
      check(field('Load Mode').value === 'auto', 'Old config loads with load mode auto');
      check(field('KV Cache Offload').value === 'gpu', 'Old config loads with GPU KV offload');
      check(numberField('MoE Expert Count').value === '', 'Old config loads with auto expert count');
      check(toggle('Lock in System RAM').checked === true && toggle('Lock in System RAM').disabled === false, 'Old mlock config preserved and editable');
      check(field('K-Cache Precision').value === 'q4_0' && field('V-Cache Precision').value === 'q4_0', 'Old precision preserved');
      submit(); await tick();
      check(window.launched.mlock === true && window.launched.loadMode === 'auto', 'Old config launch payload unchanged');
      check(window.launched.kvCacheOffload === 'gpu' && window.launched.moeExpertCount === null, 'New defaults attach to old configs');

      // Without architecture metadata the expert count cannot be forwarded, so it is disabled.
      window.renderLoad({ id: 'dense', name: 'Dense' }); await tick();
      check(numberField('MoE Expert Count').disabled === true, 'Unknown architecture disables the expert count input');
    })()`);
    console.log('Advanced load settings modal: controls, launch payload, persistence, and legacy config loading passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
