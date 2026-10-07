const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const handlers = new Map();
const originalLoad = Module._load;
let memoryEnabled = true;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => global.fetch(...params) };
  if (name === './promptBuilder') return { ...originalLoad.call(this, name, ...args), buildSessionSystemPrompt: () => ({ role: 'system', content: memoryEnabled ? '[BACKGROUND KNOWLEDGE & USER PREFERENCES]\nSaved fact' : '', memoryContext: true }) };
  if (name === './profileSettings') return { getSessionSettings: () => ({ effective: { memoryEnabled }, params: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 } }) };
  if (name === './samplingManager') return { getGlobalSamplingParams: () => ({ temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 }) };
  if (name === 'electron') return { app: { isReady: () => true }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const manager = require('../src/main/mcpManager');
const { getToolContext } = require('../src/main/promptBuilder');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
Module._load = originalLoad;


test('cloud settings persist privately and cloud chat works without a local engine', async () => {
  const fs = require('node:fs/promises');
  const directory = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'cloud-ipc-'));
  const database = require('../src/main/db');
  database.initDatabase(directory);
  const originalInit = manager.init, originalReload = manager.reload, originalFetch = global.fetch;
  manager.init = manager.reload = async () => {};
  const sender = new EventEmitter(); sender.isDestroyed = () => false; sender.send = () => {};
  const event = { sender };
  let localRequests = 0;
  let engineConfig = null;
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => engineConfig, beginEngineRequest: () => { localRequests++; } });
  try {
    for (const provider of ['openai', 'anthropic', 'deepseek']) {
      let settings = await handlers.get('cloud:save')(event, { id: provider, name: provider, modelId: 'test-model', apiKey: 'test-secret', apiType: provider === 'anthropic' ? 'anthropic' : 'openai' });
      assert.equal(settings.find(row => row.id === provider).configured, true);
      assert.ok(!JSON.stringify(settings).includes('test-secret'));
      await handlers.get('cloud:save')(event, { id: provider, name: provider, modelId: 'test-model', apiKey: '', apiType: provider === 'anthropic' ? 'anthropic' : 'openai' });
      global.fetch = async (url, options) => {
        assert.ok(url.startsWith('https://'));
        assert.equal(JSON.parse(options.body).model, 'test-model');
        assert.equal(options.headers.Authorization || options.headers['x-api-key'], provider === 'anthropic' ? 'test-secret' : 'Bearer test-secret');
        return provider === 'anthropic' ? Response.json({ content: [{ type: 'text', text: 'Cloud answer [TASK COMPLETE]' }], usage: { input_tokens: 5, output_tokens: 3 } })
          : Response.json({ choices: [{ message: { content: 'Cloud answer [TASK COMPLETE]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
      };
      const result = await handlers.get('engine:chat')(event, { requestId: provider, modelId: `cloud:${provider}:test-model`, activeChatProvider: { type: 'cloud', provider, model: 'test-model' }, messages: [{ role: 'user', content: 'Hi' }] });
      assert.equal(result.text, 'Cloud answer [TASK COMPLETE]');
      assert.equal(result.stats.totalTokens, 8);
    }
    // A loaded GPU engine must not become the cloud request's destination.
    engineConfig = { port: 12345, modelPath: '/loaded.gguf', activeModelConfig: { contextLength: 8192 } };
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(JSON.parse(options.body).model, 'test-model');
      return Response.json({ choices: [{ message: { content: 'Still cloud [TASK COMPLETE]' }, finish_reason: 'stop' }] });
    };
    await handlers.get('engine:chat')(event, { requestId: 'cloud-with-vram', modelId: 'cloud:openai:test-model', activeChatProvider: { type: 'cloud', provider: 'openai', model: 'test-model' }, messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(engineConfig.modelPath, '/loaded.gguf');
    assert.equal(localRequests, 0, 'cloud chat never touches local idle/request lifecycle');
    engineConfig = null;
    await handlers.get('cloud:delete')(event, 'openai');
    await assert.rejects(handlers.get('engine:chat')(event, { activeChatProvider: { type: 'cloud', provider: 'openai', model: 'test-model' } }), /Invalid chat provider/);
    await assert.rejects(handlers.get('engine:chat')(event, { requestId: 'local', modelId: '/model.gguf', messages: [] }), /Start the local model/);
  } finally {
    dispose(); manager.init = originalInit; manager.reload = originalReload; global.fetch = originalFetch;
    database.closeDatabase(); await fs.rm(directory, { recursive: true, force: true });
  }
});
