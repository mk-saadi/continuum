const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const manager = require('../src/main/mcpManager');
const { getToolContext } = require('../src/main/promptBuilder');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
Module._load = originalLoad;

test('IPC executes MCP tools, emits cards, and re-prompts with JSON output', async () => {
  const fs = require('node:fs/promises');
  const directory = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'mcp-ipc-'));
  const originalPath = manager.configPath;
  manager.configPath = require('node:path').join(directory, 'config.json');
  await fs.writeFile(manager.configPath, JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }));
  const originalInit = manager.init;
  manager.init = async () => {};
  const executions = [];
  manager.servers.set('fixture', { name: 'fixture', enabled: true, status: 'connected', disabledTools: new Set(), tools: [
    { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ], client: { callTool: async input => { executions.push(input); return { content: [{ type: 'text', text: input.arguments.text }] }; } } });
  const sender = new EventEmitter();
  const events = [];
  sender.isDestroyed = () => false;
  sender.send = (channel, event) => events.push({ channel, ...event });
  const event = { sender };
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => ({ port: 12345 }) });
  const originalFetch = global.fetch;
  const requests = [];
  const name = manager.getTools()[0].function.name;
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/v1/chat/completions');
    const body = JSON.parse(options.body);
    requests.push(body);
    return Response.json({ usage: requests.length === 1 ? null : { prompt_tokens: 12, completion_tokens: 3 }, choices: [{ finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', message: requests.length === 1
      ? { content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name, arguments: '{"text":"hello"}' } }] }
      : { content: 'Final answer', reasoning_content: 'Final thought' } }] });
  };
  try {
    const context = await handlers.get('mcp:get-tools')(event);
    assert.equal(context.pluginTokens, Math.ceil(JSON.stringify(manager.getTools()).length / 4));
    const result = await handlers.get('engine:chat')(event, { requestId: 'request1', modelId: 'model', messages: [{ role: 'system', content: 'test' }] });
    assert.equal(result.text, 'Final answer');
    assert.equal(result.stats.totalTokens, 15);
    assert.equal(result.stats.scope, 'final');
    assert.deepEqual(result.stats, events.filter(e => e.type === 'stats').at(-1).stats);
    assert.equal(events.filter(e => e.type === 'thinking').at(-1).thinking.text, 'Final thought');
    assert.equal(executions.length, 1);
    assert.equal(requests[0].tools.length, 3);
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
