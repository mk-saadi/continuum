const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for hot reload');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('external writes and atomic replacements reconcile servers and preserve valid state on errors', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-watch-'));
  const configPath = path.join(directory, 'mcp_config.json');
  const launches = [];
  const manager = new McpManager({ configPath, createConnection: async definition => {
    const client = { closed: false, setNotificationHandler() {},
      listTools: async () => ({ tools: [{ name: definition.command }] }),
      async close() { this.closed = true; this.onclose?.(); } };
    launches.push(client);
    return client;
  } });
  let events = 0;
  manager.on('changed', () => events++);
  const write = config => fs.writeFile(configPath, JSON.stringify({ mcpServers: config }));
  try {
    await manager.init();
    assert.deepEqual(await manager.getConfig(), { mcpServers: {} });
    await write({ first: { command: 'first' } });
    await until(() => manager.getTools().length === 1);
    await fs.writeFile(configPath, '{');
    await until(() => !!manager.getStatus().error);
    assert.equal(launches[0].closed, false);
    await fs.writeFile(configPath + '.tmp', JSON.stringify({ mcpServers: {
      first: { command: 'first' }, second: { command: 'second', enabled: true },
    } }));
    await fs.rename(configPath + '.tmp', configPath);
    await until(() => manager.getTools().length === 2);
    assert.equal(launches.length, 2);
    assert.equal(manager.getStatus().error, undefined);
    await write({ first: { command: 'first', disabledTools: ['first'] }, second: { command: 'second', enabled: false } });
    await until(() => manager.getTools().length === 0);
    assert.equal(launches[0].closed, false);
    assert.equal(launches[1].closed, true);
    await write({ first: { command: 'replacement' } });
    await until(() => manager.getTools().length === 1 && launches.length === 3);
    assert.equal(launches[0].closed, true);
    await write({});
    await until(() => manager.servers.size === 0);
    assert.ok(events > 0);
  } finally {
    await manager.close();
    assert.equal(manager.watcher, undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a running agent can discover and call a tool registered by its preceding step', async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
  let registered = false, requests = 0;
  const executed = [];
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'test',
    messages: [{ role: 'system', content: 'Build and use a server.' }],
    getChatTools: async () => [tool('register'), ...(registered ? [tool('new_tool')] : [])],
    executeTool: async call => { executed.push(call.name); registered = true; return 'OK'; },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests++;
      if (requests === 2) assert.ok(payload.tools.some(t => t.function.name === 'new_tool'));
      const message = requests < 3
        ? { tool_calls: [{ id: `call_${requests}`, type: 'function', function: { name: requests === 1 ? 'register' : 'new_tool', arguments: '{}' } }] }
        : { content: 'Done. [TASK COMPLETE]' };
      return Response.json({ choices: [{ message, finish_reason: requests < 3 ? 'tool_calls' : 'stop' }] });
    },
  });
  assert.deepEqual(executed, ['register', 'new_tool']);
});
