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

test('IPC executes MCP tools, emits cards, and re-prompts with JSON output', async () => {
  const fs = require('node:fs/promises');
  const directory = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'mcp-ipc-'));
  const database = require('../src/main/db');
  database.initDatabase(directory);
  const originalPath = manager.configPath;
  manager.configPath = require('node:path').join(directory, 'config.json');
  await fs.writeFile(manager.configPath, JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }));
  const originalInit = manager.init;
  manager.init = async () => {};
  const executions = [];
  manager.servers.set('fixture', { name: 'fixture', definition: { command: 'fixture' }, enabled: true, status: 'connected', disabledTools: new Set(), tools: [
    { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ], client: { callTool: async input => { executions.push(input); return { content: [{ type: 'text', text: input.arguments.text }] }; } } });
  const sender = new EventEmitter();
  const events = [];
  sender.isDestroyed = () => false;
  sender.send = (channel, event) => events.push({ channel, ...event });
  const event = { sender };
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345 }), getReasoningEfforts: () => ['low', 'high'] });
  const originalFetch = global.fetch;
  const requests = [];
  const name = manager.getTools()[0].function.name;
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/v1/chat/completions');
    const body = JSON.parse(options.body);
    requests.push(body);
    return Response.json({ usage: requests.length === 1 ? null : { prompt_tokens: 12, completion_tokens: 3 }, choices: [{ finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', message: requests.length === 1
      ? { content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name, arguments: '{"text":"hello"}' } }] }
      : { content: 'Final answer [TASK COMPLETE]', reasoning_content: 'Final thought' } }] });
  };
  try {
    const context = await handlers.get('mcp:get-tools')(event);
    assert.equal(context.pluginTokens, Math.ceil(JSON.stringify(manager.getTools()).length / 4));
    await assert.rejects(handlers.get('engine:chat')(event, { reasoningEffort: 'unsupported' }), /Unsupported reasoning effort/);
    const result = await handlers.get('engine:chat')(event, { requestId: 'request1', modelId: 'model', reasoningEffort: 'low', messages: [{ role: 'system', content: 'test' }] });
    assert.ok(requests.every(request => request.chat_template_kwargs.reasoning_effort === 'low'));
    assert.equal(result.text, 'Final answer [TASK COMPLETE]');
    const usage = database.db.prepare('SELECT * FROM token_usage').all();
    assert.equal(usage.length, 1);
    assert.equal(usage[0].prompt_tokens, 12);
    assert.equal(usage[0].completion_tokens, 3);
    assert.equal(result.message.id, 'request1');
    assert.equal(result.message.content, 'Final answer [TASK COMPLETE]');
    assert.deepEqual(result.executionSteps.map(step => step.type), ['tool_call', 'thought']);
    assert.deepEqual(result.executionSteps[0].args, { text: 'hello' });
    assert.equal(result.executionSteps[0].serverName, 'fixture');
    const updates = events.filter(event => event.channel === 'stream:step-update');
    assert.ok(updates.some(event => event.executionSteps[0]?.status === 'running'));
    assert.equal(updates.at(-1).messageId, 'request1');
    assert.deepEqual(updates.at(-1).executionSteps, result.executionSteps);
    assert.equal(updates.at(-1).content, 'Final answer [TASK COMPLETE]');
    assert.equal(result.stats.totalTokens, 15);
    assert.equal(result.stats.scope, 'final');
    assert.deepEqual(result.stats, events.filter(e => e.type === 'stats').at(-1).stats);
    assert.equal(events.filter(e => e.type === 'thinking').at(-1).thinking.text, 'Final thought');
    assert.equal(executions.length, 1);
    assert.equal(requests[0].tools.length, 3);
    assert.ok(!requests[0].tools.some(tool => tool.function.name === 'search_chat_history'));
    assert.equal(requests[1].messages.at(-1).role, 'tool');
    assert.equal(requests[1].messages.at(-1).tool_call_id, 'call1');
    assert.equal(JSON.parse(requests[1].messages.at(-1).content).content[0].text, 'hello');
    assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.status), ['pending', 'complete']);
    await handlers.get('mcp:set-tool-enabled')(event, { name, enabled: false });
    assert.equal(events.at(-1).channel, 'mcp:changed');
    assert.equal(events.at(-1).pluginTokens, 0);
    assert.ok(getToolContext([]).toolTokens > 0);
    global.fetch = async () => Response.json({ choices: [{ message: { content: 'Next turn' }, finish_reason: 'stop' }] });
    const nextTurn = await handlers.get('engine:chat')(event, { requestId: 'request2', modelId: 'model', messages: [{ role: 'system', content: 'test' }] });
    assert.equal(nextTurn.stats.totalTokens, null);
    const historyRequests = [];
    global.fetch = async (_url, options) => {
      historyRequests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ finish_reason: historyRequests.length === 1 ? 'tool_calls' : 'stop',
        message: historyRequests.length === 1
          ? { content: null, tool_calls: [{ id: 'history1', type: 'function', function: {
            name: 'search_memory', arguments: '{"query":""}',
          } }] }
          : { content: 'No earlier discussion found. [TASK COMPLETE]' } }] });
    };
    await handlers.get('engine:chat')(event, { requestId: 'history', modelId: 'model', messages: [
      { role: 'system', content: 'test' }, { role: 'user', content: 'What did we talk about?' },
    ] });
    assert.equal(historyRequests[1].messages.at(-1).content, 'Facts found:\nNone.\n\nPast Chat Context found:\nNone.');
    assert.equal(events.filter(e => e.type === 'tool').at(-1).status, 'complete');
    memoryEnabled = false;
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(!body.tools.some(tool => ['search_memory', 'save_memory'].includes(tool.function.name)));
      assert.ok(!body.messages.some(message => /Saved fact|BACKGROUND KNOWLEDGE/.test(message.content)));
      assert.match(body.messages[0].content, /Memory Palace is disabled/);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Fresh reply' } }] });
    };
    await handlers.get('engine:chat')(event, { requestId: 'isolated', modelId: 'model', memoryEnabled: true,
      messages: [{ role: 'system', memoryContext: true, content: '[BACKGROUND KNOWLEDGE & USER PREFERENCES]\nSaved fact' }, { role: 'user', content: 'Hi' }] });
    memoryEnabled = true;
    // Real IPC pause/resume preserves the pending invocation and completed tool results.
    await handlers.get('mcp:set-tool-enabled')(event, { name, enabled: true });
    let xmlRounds = 0;
    global.fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: ++xmlRounds === 1
      ? `<tool_call><function=${name}><parameter=text>Streaming arguments</parameter></function></tool_call>`
      : '[TASK COMPLETE]' } }] });
    const xmlResult = await handlers.get('engine:chat')(event, { requestId: 'xml-stream', modelId: 'model', messages: [{ role: 'system', content: 'test' }] });
    const liveEvents = events.filter(value => value.requestId === 'xml-stream');
    const start = liveEvents.find(value => value.type === 'tool_start');
    assert.equal(start.functionName, name);
    assert.equal(liveEvents.find(value => value.type === 'tool_chunk').content, 'Streaming arguments');
    assert.equal(xmlResult.executionSteps[0].id, start.id);
    assert.equal(xmlResult.executionSteps[0].status, 'complete');
    assert.ok(!xmlResult.text.includes('<tool_call>'));
    for (const action of ['continue', 'stop', 'cancel']) {
      let rounds = 0, pauses = 0;
      const send = sender.send;
      sender.send = (channel, value) => {
        send(channel, value);
        if (channel === 'loop:paused' && value.executionState === 'paused_turn_limit') {
          pauses++;
          assert.equal(rounds, 30);
          assert.equal(value.reason, 'turn_limit');
          queueMicrotask(() => {
            const handler = action === 'cancel' ? 'engine:cancel-chat' : 'loop:respond';
            handlers.get(handler)(event, { requestId: value.requestId, action });
          });
        }
      };
      global.fetch = async (_url, options) => {
        rounds++;
        const messages = JSON.parse(options.body).messages;
        if (rounds > 1) assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'pause-tool'));
        return Response.json({ choices: [{ finish_reason: rounds === 1 ? 'tool_calls' : 'stop', message: rounds === 1
          ? { tool_calls: [{ id: 'pause-tool', type: 'function', function: { name, arguments: '{"text":"pause test"}' } }] }
          : { content: rounds > 30 ? '[TASK COMPLETE]' : 'Working.' } }] });
      };
      const pendingChat = handlers.get('engine:chat')(event, { requestId: `pause-${action}`, modelId: 'model', messages: [{ role: 'system', content: 'test' }] });
      if (action === 'cancel') await assert.rejects(pendingChat, { name: 'AbortError' });
      else await pendingChat;
      assert.equal(pauses, 1);
      assert.equal(rounds, action === 'continue' ? 31 : 30);
      assert.equal(sender.listenerCount('destroyed'), 0);
      sender.send = send;
    }

    let started;
    const pending = new Promise(resolve => { started = resolve; });
    global.fetch = async (_url, { signal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const chat = handlers.get('engine:chat')(event, { requestId: 'cancel-me', modelId: 'model', messages: [{ role: 'system', content: 'test' }] });
    await pending;
    await handlers.get('engine:cancel-chat')(event, { requestId: 'cancel-me' });
    await assert.rejects(chat, { name: 'AbortError' });
    assert.equal(sender.listenerCount('destroyed'), 0);

  } finally {
    database.closeDatabase();
    dispose(); global.fetch = originalFetch; manager.init = originalInit; manager.servers.clear(); manager.configPath = originalPath;
    await fs.rm(directory, { recursive: true });
  }
});

test('preload config methods invoke trusted config handlers', async () => {
  const exposed = {};
  const sender = { isDestroyed: () => false, send() {} };
  const event = { sender, trusted: true };
  const config = { mcpServers: { example: { command: 'node', args: ['server.js'] } } };
  const originalGet = manager.getConfig, originalSave = manager.saveConfig;
  manager.getConfig = async () => config;
  let saved;
  manager.saveConfig = async input => { saved = input; return input; };
  const dispose = registerIpcHandlers({ isTrustedSender: event => event.trusted });
  const load = Module._load;
  try {
    Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => global.fetch(...params) };
      if (name === 'electron') return {
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)(event, payload) },
      };
      return load.call(this, name, ...args);
    };
    delete require.cache[require.resolve('../src/preload')];
    require('../src/preload');
    assert.deepEqual(await exposed.api.getMcpConfig(), config);
    assert.deepEqual(await exposed.api.saveMcpConfig(config), config);
    assert.equal(saved, config);
    await assert.rejects(handlers.get('mcp:save-config')({ sender, trusted: false }, config), /Unauthorized/);
  } finally {
    Module._load = load;
    manager.getConfig = originalGet; manager.saveConfig = originalSave;
    dispose();
  }
});
