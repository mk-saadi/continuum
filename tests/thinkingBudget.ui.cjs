const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'thinking-budget-ui-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ThinkingBudgetControl } from './src/components/RightSidebar';
      const root = createRoot(document.getElementById('root'));
      const saved = new Map();
      window.writes = [];
      window.api = {
        getEffectiveSettings: async (session, model) => ({ effective: { thinkingBudget: saved.get(session || model) ?? -1 } }),
        saveSamplingParams: async (session, model, params) => { saved.set(session, params.thinking_budget); window.writes.push([session, params.thinking_budget]); },
        saveProfileSettings: async (model, patch) => { saved.set(model, patch.thinkingBudget); window.writes.push([model, patch.thinkingBudget]); },
      };
      window.render = (context = null, session = 'chat', model = 'model') => root.render(
        <ThinkingBudgetControl key={session + model} activeModel={context === null ? null : { contextSize: context }}
          sessionId={session} modelId={model} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await browser.loadFile(path.join(directory, 'index.html'));
    await browser.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 60));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const mode = () => document.querySelector('select');
      const slider = () => document.querySelector('input[type=range]');
      const changeMode = async value => { mode().value = value; mode().dispatchEvent(new Event('change', { bubbles: true })); await tick(); };
      window.render(); await tick();
      check(mode().disabled && slider().disabled, 'No loaded model disables controls');
      check(document.querySelector('section').title === 'Load a model to configure thinking budget.', 'Disabled tooltip');
      window.render(8192); await tick();
      check(!mode().disabled && mode().value === 'default', 'Loaded model defaults to unlimited');
      await changeMode('custom');
      check(slider().min === '256' && slider().max === '6144' && slider().step === '256', 'Context-derived bounds');
      check(document.querySelector('output').textContent === '4,096 tokens', 'Live formatted value');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider(), '5120');
      slider().dispatchEvent(new Event('input', { bubbles: true })); await tick();
      check(window.writes.at(-1)[1] === 5120, 'Slider persists chat budget');
      window.render(4096); await tick();
      check(slider().max === '2048' && slider().value === '2048', 'Smaller loaded context clamps display');
      window.render(2048); await tick();
      check(slider().disabled && mode().querySelector('[value=custom]').disabled, 'Tiny contexts disable custom slider');
      await changeMode('default');
      check(window.writes.at(-1)[1] === -1, 'Unlimited persists sentinel');
      window.render(16384, null, 'other'); await tick(); await changeMode('custom');
      check(window.writes.at(-1)[0] === 'other', 'No session saves model default');
      window.render(8192, 'chat'); await tick();
      check(mode().value === 'default', 'Session selection restores saved budget');
      window.render(null, 'chat'); await tick();
      check(slider().disabled, 'Unload disables slider again');
    })()`);
    console.log('Thinking budget disabled state, context bounds, live values, persistence, and model switching passed.');
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
