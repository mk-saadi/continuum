// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/reasoningSettings.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'reasoning-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ModelSettingsModal from './src/components/ModelSettingsModal';
      import EngineIdleSettings from './src/components/EngineIdleSettings';
      import { ChatInterface } from './src/components/main-app/ChatInterface';
      const root = createRoot(document.getElementById('root'));
      window.requests = [];
      window.capReads = [];
      window.reasoningWrites = [];
      window.savedReasoning = new Map();
      window.api = {
        getConfig: async () => ({ engineIdleTimeoutMinutes: window.idle ?? -1 }),
        setEngineIdleTimeout: async value => { window.idle = value; return { engineIdleTimeoutMinutes: value }; },
        getSessionAgent: async () => null,
        getModelLoadConfig: async () => ({ config: { contextLength: 8192, threads: 4, evalBatch: 2048, physicalBatch: 512, parallel: 1, gpuOffload: 'auto', flashAttention: 'auto', cacheTypeK: 'f16', cacheTypeV: 'f16', mlock: false }, remembered: false }),
        launchEngine: async (_id, config) => { window.launched = config; return { success: true }; },
        getReasoningCapabilities: async ({ sessionId, modelId, activeChatProvider }) => {
          window.capReads.push({ sessionId, modelId, activeChatProvider });
          const cloud = activeChatProvider?.type === 'cloud';
          let caps;
          if (modelId === 'plain') {
            caps = { family: 'local', source: 'local-metadata', reasoning: false, efforts: [], canDisable: false,
              budget: { supported: false, min: null, max: null } };
          } else if (cloud) {
            caps = { family: 'openrouter', source: 'provider-metadata', reasoning: true, efforts: ['low', 'high'],
              canDisable: false, budget: { supported: true, min: 1024, max: 8192 } };
          } else {
            caps = { family: 'local', source: 'local-metadata', reasoning: true, efforts: ['low', 'medium', 'high'],
              canDisable: true, budget: { supported: false, min: 0, max: null } };
          }
          const saved = window.savedReasoning.get(sessionId || modelId) || { thinkingBudget: -1, reasoningEffort: null };
          let effective = { mode: 'auto', effort: null, budget: null };
          if (saved.thinkingBudget === 0) effective = { mode: 'off', effort: null, budget: null };
          else if (saved.thinkingBudget > 0) effective = { mode: 'budget', effort: null, budget: saved.thinkingBudget };
          else if (saved.reasoningEffort) effective = { mode: 'effort', effort: saved.reasoningEffort, budget: null };
          return { ...caps, effective, unsupported: false, warnings: [], settings: saved };
        },
        saveSamplingParams: async (sessionId, modelId, params) => {
          window.savedReasoning.set(sessionId, { thinkingBudget: params.thinking_budget, reasoningEffort: params.reasoning_effort });
          window.reasoningWrites.push({ sessionId, modelId, ...params });
        },
        saveProfileSettings: async (modelId, params) => {
          window.savedReasoning.set(modelId, { thinkingBudget: params.thinkingBudget, reasoningEffort: params.reasoningEffort });
          window.reasoningWrites.push({ modelId, ...params });
        },
      };
      window.chatAPI = { onEvent: () => () => {}, run: async request => { window.requests.push(request); return { text: 'OK' }; } };
      const palace = { sessionId: 'chat', setDraftTokens() {}, schedule() {}, refresh: async () => {},
        prepareMessages: async () => [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Hi' }],
        finishMessage: async () => null,
        api: { getAllSessions: async () => [], loadSession: async () => ({ messages: [] }) },
      };
      window.renderLoad = () => root.render(<ModelSettingsModal model={{ id: 'model', name: 'Model' }} onClose={() => {}} onLoaded={() => {}} />);
      window.renderIdle = () => root.render(<EngineIdleSettings />);
      const models = [{ id: 'model', reasoningEfforts: ['low', 'medium', 'high'] }, { id: 'plain' }];
      window.renderChat = (selectedModel = 'model', engineRunning = true, activeChatProvider = { type: 'local' }) =>
        root.render(<ChatInterface models={models} selectedModel={selectedModel} engineRunning={engineRunning}
          activeChatProvider={activeChatProvider} baseUrl="http://localhost" palace={palace} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'unrelated-chat-children', setup(build) {
        build.onResolve({ filter: /\/(RightSidebar|AssistantAvatar|MessageActions|ChatMessage|ChatHistory)(\.jsx)?$/ }, args => ({ path: args.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Stub() { return null; } export function MessageContextStatus() { return null; }' }));
      } }] });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const change = (element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
      const field = label => { const node = [...document.querySelectorAll('label')].find(node => node.textContent === label); return node?.parentElement.querySelector('select'); };
      const settingsButton = () => [...document.querySelectorAll('button')].find(node => node.title === 'Agent Run Settings');
      const reasoningButton = () => [...document.querySelectorAll('button')].find(node => node.textContent.includes('Reasoning:'));
      const openReasoning = async () => {
        settingsButton().click(); await tick();
        check(reasoningButton(), 'Reasoning control is missing');
        return reasoningButton();
      };
      const choose = async text => {
        reasoningButton().click(); await tick();
        const option = [...document.querySelectorAll('[role=listbox] button[role=option]')]
          .find(node => node.textContent.includes(text));
        check(option, 'Missing reasoning option: ' + text);
        option.click(); await tick();
      };

      window.renderLoad(); await tick();
      check(field('K-Cache Precision') && field('V-Cache Precision'), 'Separate K/V controls');
      check(!field('Keep In Memory') && !field('Memory load mode'), 'Old load controls removed');
      change(field('K-Cache Precision'), 'q8_0'); await tick();
      change(field('V-Cache Precision'), 'q4_0'); await tick();
      const lock = [...document.querySelectorAll('label')].find(node => node.textContent.includes('Lock in System RAM'));
      lock.querySelector('input').click(); await tick();
      document.querySelector('button[type=submit]').click(); await tick();
      check(window.launched.cacheTypeK === 'q8_0' && window.launched.cacheTypeV === 'q4_0' && window.launched.mlock, 'Load payload matches controls');
      window.renderIdle(); await tick();
      const idle = field('Engine Idle Timeout (Keep in Memory)');
      check(idle.value === '-1', 'Idle default is never');
      change(idle, '15'); await tick();
      check(window.idle === 15, 'Idle saves globally');

      window.renderChat(); await tick();
      const localReasoning = await openReasoning();
      check(localReasoning.textContent.includes('Reasoning: Automatic'), 'Supported model starts Automatic');
      check(window.capReads.at(-1).sessionId === 'chat' && window.capReads.at(-1).modelId === 'model',
        'Capabilities resolve for chat and model');
      check(window.capReads.at(-1).activeChatProvider.type === 'local', 'Local target is explicit');
      await choose('Low');
      check(window.reasoningWrites.at(-1).thinking_budget === -1 && window.reasoningWrites.at(-1).reasoning_effort === 'low',
        'Effort persists as normalized intent');
      check(reasoningButton().textContent.includes('Reasoning: low'), 'Effort badge updates');
      settingsButton().click(); await tick();

      const textarea = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Hi');
      textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick();
      document.querySelector('button[title="Send"]').click(); await tick();
      check(window.requests.length === 1, 'Chat request sent');
      check(!('reasoningEffort' in window.requests[0]) && !('thinkingBudget' in window.requests[0]),
        'Renderer never sends reasoning wire fields');
      check(window.requests[0].sessionId === 'chat' && window.requests[0].modelId === 'model',
        'Main process receives the session/model identity it resolves against');

      window.renderChat('plain'); await tick();
      settingsButton().click(); await tick();
      check(document.body.textContent.includes('Reasoning: Unavailable'), 'Unsupported model is labelled unavailable');
      check(!reasoningButton(), 'Unsupported model offers no selector');
      settingsButton().click(); await tick();

      window.renderChat('model'); await tick();
      const restored = await openReasoning();
      check(restored.textContent.includes('Reasoning: low'), 'Model choice is retained across switches');
      settingsButton().click(); await tick();

      window.renderChat('model', true, { type: 'cloud', provider: 'router', model: 'foo/bar' }); await tick();
      const cloudReasoning = await openReasoning();
      check(window.capReads.at(-1).activeChatProvider.type === 'cloud', 'Cloud target reaches capability lookup');
      check(window.capReads.at(-1).activeChatProvider.provider === 'router', 'Cloud provider identity is preserved');
      check(cloudReasoning.textContent.includes('Reasoning: Off') === false, 'Cloud capabilities replace local controls');
      await choose('High');
      check(window.reasoningWrites.at(-1).reasoning_effort === 'high', 'Cloud effort persists as intent');
      settingsButton().click(); await tick();

      window.renderChat('model', false); await tick();
      check(settingsButton().disabled, 'Stopped engine disables run settings');
    })()`);
    console.log('Load controls, idle setting, capability-gated reasoning, persistence, and request payload passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
