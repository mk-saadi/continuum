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
      import { ThinkingBudgetSelector } from './src/components/ChatInputBar';
      const root = createRoot(document.getElementById('root'));
      const saved = new Map();
      window.writes = [];
      window.api = {
        getEffectiveSettings: async (session, model) => ({ effective: { thinkingBudget: saved.get(session || model) ?? -1 } }),
        saveSamplingParams: async (session, model, params) => { saved.set(session, params.thinking_budget); window.writes.push([session, params.thinking_budget]); },
        saveProfileSettings: async (model, patch) => { saved.set(model, patch.thinkingBudget); window.writes.push([model, patch.thinkingBudget]); },
      };
      window.render = (session = 'chat', model = 'model') => root.render(
        <ThinkingBudgetSelector key={session + model} sessionId={session} modelId={model} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await browser.loadFile(path.join(directory, 'index.html'));
    await browser.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 60));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const button = () => document.querySelector('[aria-label^="Thinking Budget:"]');
      const open = async () => { button().click(); await tick(); };
      const choose = async text => { [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent.includes(text)).click(); await tick(); };
      window.render(); await tick();
      check(button().textContent.includes('Unlimited'), 'Defaults to unlimited');
      await open(); await choose('Light');
      check(window.writes.at(-1)[1] === 1024, 'Preset persists to chat');
      await open();
      const input = document.querySelector('input[type=number]');
      check(input.min === '0' && input.max === '65536' && input.step === '256', 'Custom input bounds');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2500');
      input.dispatchEvent(new Event('input', { bubbles: true })); await tick();
      document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
      check(window.writes.at(-1)[1] === 2500, 'Exact custom integer persists');
      check(button().textContent.includes('2,500 t'), 'Custom badge is formatted');
      await open(); await choose('Off / Fast');
      check(window.writes.at(-1)[1] === 0, 'Off persists zero');
      window.render(null, 'other'); await tick(); await open(); await choose('Deep');
      check(window.writes.at(-1)[0] === 'other', 'No session saves model default');
      window.render('chat', 'model'); await tick();
      check(button().textContent.includes('Off'), 'Chat budget restores on session switch');
    })()`);
    console.log('Thinking budget presets, exact custom input, persistence and session switching passed.');
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
