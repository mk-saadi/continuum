const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

// The reasoning control is capability-driven: only controls the selected model
// actually reports are offered. This fixture exercises the normalized intent
// (Automatic / Off / effort / numeric budget) and proves the renderer persists
// intent fields, never provider wire fields.
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'reasoning-control-ui-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ReasoningSelector, ThinkingBudgetSelector } from './src/components/AgentSettingsPopover';
      const root = createRoot(document.getElementById('root'));
      window.caps = {
        default: { family: 'local', source: 'local-metadata', reasoning: false, efforts: [], canDisable: false,
          budget: { supported: false, min: null, max: null } },
        model: { family: 'local', source: 'local-metadata', reasoning: true, efforts: ['low', 'medium', 'high'],
          canDisable: true, budget: { supported: true, min: 0, max: 8192 } },
        unknown: { family: 'local', source: 'unknown', reasoning: null, efforts: [], canDisable: null,
          budget: { supported: null, min: null, max: null } },
      };
      window.state = new Map();
      window.writes = [];
      window.reads = [];
      window.api = {
        getReasoningCapabilities: async ({ sessionId, modelId, activeChatProvider }) => {
          window.reads.push({ sessionId, modelId, activeChatProvider });
          const caps = window.caps[modelId] || window.caps.default;
          const saved = window.state.get(sessionId || modelId) || { thinkingBudget: -1, reasoningEffort: null };
          let effective = { mode: 'auto', effort: null, budget: null };
          if (saved.thinkingBudget === 0) effective = { mode: 'off', effort: null, budget: null };
          else if (saved.thinkingBudget > 0) effective = { mode: 'budget', effort: null, budget: saved.thinkingBudget };
          else if (saved.reasoningEffort) effective = { mode: 'effort', effort: saved.reasoningEffort, budget: null };
          return { ...caps, intent: effective, effective, unsupported: false, warnings: [], settings: saved };
        },
        saveSamplingParams: async (sessionId, modelId, params) => {
          const saved = { thinkingBudget: params.thinking_budget, reasoningEffort: params.reasoning_effort };
          window.state.set(sessionId, saved);
          window.writes.push({ scope: sessionId, modelId, ...params });
        },
        saveProfileSettings: async (modelId, params) => {
          const saved = { thinkingBudget: params.thinkingBudget, reasoningEffort: params.reasoningEffort };
          window.state.set(modelId, saved);
          window.writes.push({ scope: null, modelId, thinking_budget: params.thinkingBudget, reasoning_effort: params.reasoningEffort });
        },
      };
      window.aliasMatches = ThinkingBudgetSelector === ReasoningSelector;
      window.render = (session = 'chat', model = 'model') => root.render(
        <ReasoningSelector key={session + model} sessionId={session} modelId={model} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await browser.loadFile(path.join(directory, 'index.html'));
    await browser.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const trigger = () => [...document.querySelectorAll('button')].find(node => node.textContent.includes('Reasoning:'));
      const open = async () => { trigger().click(); await tick(); };
      const choose = async text => {
        const option = [...document.querySelectorAll('[role=listbox] button[role=option]')]
          .find(node => node.textContent.includes(text));
        check(option, 'Missing option: ' + text);
        option.click(); await tick();
      };
      const lastWrite = () => window.writes.at(-1);

      window.render(); await tick();
      check(window.aliasMatches, 'ThinkingBudgetSelector remains a compatible alias');
      check(trigger().textContent.includes('Reasoning: Automatic'), 'Defaults to Automatic');

      await open(); await choose('Off');
      check(lastWrite().thinking_budget === 0 && lastWrite().reasoning_effort === null, 'Off persists zero budget');
      check(trigger().textContent.includes('Reasoning: Off'), 'Off badge');

      await open(); await choose('High');
      check(lastWrite().thinking_budget === -1 && lastWrite().reasoning_effort === 'high', 'Effort persists separately');
      check(trigger().textContent.includes('Reasoning: high'), 'Effort badge');

      await open(); await choose('Custom budget');
      check(lastWrite().thinking_budget === 4096 && lastWrite().reasoning_effort === null, 'Budget starts at the supported default');
      check(trigger().textContent.includes('4,096 tokens'), 'Budget badge is formatted');

      await open();
      const input = document.querySelector('input[aria-label="Custom thinking tokens"]');
      check(input && input.min === '0' && input.max === '8192' && input.step === '256', 'Budget bounds come from capabilities');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2500');
      input.dispatchEvent(new Event('input', { bubbles: true })); await tick();
      document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
      check(lastWrite().thinking_budget === 2500, 'Exact custom integer persists');
      check(trigger().textContent.includes('2,500 tokens'), 'Custom budget badge');

      window.render('chat', 'plain'); await tick();
      check(document.body.textContent.includes('Reasoning: Unavailable'), 'Unsupported model is labelled unavailable');
      check(!trigger(), 'Unsupported model offers no selector');

      window.render('chat', 'unknown'); await tick();
      check(document.body.textContent.includes('Reasoning: Unknown'), 'Missing metadata is labelled unknown');

      window.render(null, 'other'); await tick();
      check(trigger().textContent.includes('Reasoning: Automatic'), 'Model default starts Automatic');
      await open(); await choose('Medium');
      check(lastWrite().scope === null && lastWrite().modelId === 'other' && lastWrite().reasoning_effort === 'medium',
        'No session saves a model default');
      check(window.reads.at(-1).modelId === 'other', 'Capabilities resolve for the selected model');
      check(window.reads.at(-1).activeChatProvider.type === 'local', 'Local target is explicit');

      window.render('chat', 'model'); await tick();
      check(trigger().textContent.includes('2,500 tokens'), 'Chat budget restores on session switch');
    })()`);
    console.log('Reasoning selector modes, capability gating, exact budget, and persistence passed.');
  } finally { browser.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
