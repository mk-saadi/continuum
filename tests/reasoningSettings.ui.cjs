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
      window.api = {
        getConfig: async () => ({ engineIdleTimeoutMinutes: window.idle ?? -1 }),
        setEngineIdleTimeout: async value => { window.idle = value; return { engineIdleTimeoutMinutes: value }; },
        getSessionAgent: async () => null,
        getModelLoadConfig: async () => ({ config: { contextLength: 8192, threads: 4, evalBatch: 2048, physicalBatch: 512, parallel: 1, gpuOffload: 'auto', flashAttention: 'auto', cacheTypeK: 'f16', cacheTypeV: 'f16', mlock: false }, remembered: false }),
        launchEngine: async (_id, config) => { window.launched = config; return { success: true }; },
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
      window.renderChat = (selectedModel = 'model', engineRunning = true) => root.render(<ChatInterface models={models} selectedModel={selectedModel} engineRunning={engineRunning} baseUrl="http://localhost" palace={palace} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'unrelated-chat-children', setup(build) {
        build.onResolve({ filter: /\/(RightSidebar|AssistantAvatar|MessageActions|ChatMessage|ChatHistory)(\.jsx)?$/ }, args => ({ path: args.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Stub() { return null; }' }));
      } }] });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 80));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const change = (element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
      const field = label => { const node = [...document.querySelectorAll('label')].find(node => node.textContent === label); return node?.parentElement.querySelector('select'); };
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
      const effort = () => document.querySelector('[aria-label="Reasoning effort"]');
      check(effort().value === 'medium', 'Supported model shows effort');
      change(effort(), 'low'); await tick();
      const textarea = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Hi');
      textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick();
      document.querySelector('button[title="Send"]').click(); await tick();
      check(window.requests[0]?.reasoningEffort === 'low', 'Selected effort reaches chat IPC');
      window.renderChat('plain'); await tick(); check(!effort(), 'Unsupported model hides effort');
      window.renderChat('model'); await tick(); check(effort().value === 'low', 'Model choice is retained across switches');
      window.renderChat('model', false); await tick(); check(!effort(), 'Stopped engine hides effort');
    })()`);
    console.log('Load controls, global idle setting, model-specific effort selection, and chat submission passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
