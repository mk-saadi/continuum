const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');
const { createHash } = require('node:crypto');
const { approvedMutations } = require('../src/main/safetyGuards');

test('MCP mutation approvals intercept, match payloads and permit only one dispatch', async () => {
  const manager = new McpManager();
  const calls = [];
  let fail = false;
  manager.servers.set('database', {
    enabled: true, status: 'connected', disabledTools: new Set(), tools: [{ name: 'query' }],
    client: { callTool: async call => {
      calls.push(call);
      if (fail) throw new Error('Server failed');
      return { content: [{ type: 'text', text: 'ok' }] };
    } },
  });
  const args = { nested: { query: 'DELETE FROM records' } };
  const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  const intercept = `SAFETY GUARD INTERCEPT: Mutation payload flagged. Ask the user for permission. If approved, first use the native tool 'approve_mcp_mutation' with hash ${hash}, then re-run this MCP tool.`;
  const invoke = (payload = args) => manager.callTool('database', 'query', payload);
  try {
    await invoke({ query: 'SELECT * FROM records' });
    assert.equal(calls.length, 1);
    await assert.rejects(invoke(), { message: intercept });
    assert.equal(calls.length, 1);
    approvedMutations.add(hash);
    await assert.rejects(invoke({ nested: { query: 'DELETE FROM other_records' } }), /SAFETY GUARD INTERCEPT/);
    assert.ok(approvedMutations.has(hash));
    const results = await Promise.allSettled([invoke(), invoke()]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    assert.equal(results[1].reason.message, intercept);
    assert.deepEqual(calls[1].arguments, args);
    assert.equal(calls.length, 2);
    assert.equal(approvedMutations.has(hash), false);
    await assert.rejects(invoke(), { message: intercept });
    approvedMutations.add(hash);
    fail = true;
    await assert.rejects(invoke(), /Server failed/);
    assert.equal(approvedMutations.has(hash), false, 'Failed attempts also consume approval');
    await assert.rejects(invoke(), { message: intercept });
    assert.equal(calls.length, 3);
  } finally { approvedMutations.clear(); }
});

test('real stdio discovery, pagination, namespacing, execution and disable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
  const configPath = path.join(directory, 'mcp_config.json');
  const definition = { command: process.execPath, args: [path.join(__dirname, 'fixtures/mcpServer.cjs')] };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { first: definition, second: definition, disabled: { ...definition, disabled: true }, broken: { command: '/no/such/executable' } } }));
  const manager = new McpManager({ configPath });
  try {
    await manager.init();
    const tools = manager.getTools();
    assert.equal(tools.length, 4, JSON.stringify(manager.getStatus()));
    assert.equal(new Set(tools.map(t => t.function.name)).size, 4);
    assert.ok(tools.every(t => /^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name)));
    const name = tools[0].function.name;
    const target = manager.resolveTool(name);
    assert.deepEqual(target, { serverName: 'first', toolName: 'echo' });
    assert.equal(JSON.parse(await manager.callTool('first', 'echo', { text: 'hello' })).content[0].text, 'hello');
    assert.equal(JSON.parse(await manager.callTool('first', 'fail', {})).isError, true);
    await manager.setToolEnabled(name, false);
    assert.equal(manager.getTools().length, 3);
    assert.throws(() => manager.resolveTool(name), /disabled/);
    await assert.rejects(manager.callTool('first', 'echo', {}), /disabled/);
    await manager.setToolEnabled(name, true);
    assert.equal(manager.getTools().length, 4);
    assert.equal(manager.getStatus().servers.find(s => s.name === 'broken').status, 'error');
    await assert.rejects(manager.callTool('first', 'echo', []), /JSON object/);
    await manager.saveConfig({ mcpServers: { replacement: definition } });
    assert.deepEqual(manager.getStatus().servers.map(s => s.name), ['replacement']);
    assert.equal(manager.getTools().length, 2);
    assert.equal(JSON.parse(await manager.callTool('replacement', 'echo', { text: 'reloaded' })).content[0].text, 'reloaded');
    await manager.saveConfig({ mcpServers: {} });
    assert.deepEqual(manager.getTools(), []);
  } finally { await manager.close(); await fs.rm(directory, { recursive: true }); }
});

test('missing and malformed configs leave an empty tool catalog', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  try {
    const missing = new McpManager({ configPath });
    await missing.init(); assert.deepEqual(missing.getTools(), []); assert.equal(missing.getStatus().error, undefined);
    await fs.writeFile(configPath, '{');
    const invalid = new McpManager({ configPath });
    await invalid.init(); assert.ok(invalid.getStatus().error);
  } finally { await fs.rm(directory, { recursive: true }); }
});

test('lazy MCP activation is scoped to a chat and UI opt-in survives restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-lazy-'));
  const configPath = path.join(directory, 'mcp_config.json');
  const clients = [];
  const createConnection = async definition => {
    const client = { closed: false, setNotificationHandler() {},
      listTools: async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      async close() { this.closed = true; this.onclose?.(); } };
    clients.push({ definition, client });
    return client;
  };
  const manager = new McpManager({ configPath, createConnection, lazyByDefault: true });
  try {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {
      first: { command: 'first' }, second: { command: 'second', enabled: true },
    } }));
    await manager.init();
    assert.equal(clients.length, 0);
    assert.deepEqual(manager.getTools('casual-a'), []);
    const enabled = await manager.manageServers('enable', ['first'], 'casual-a');
    assert.equal(enabled.success, true);
    assert.match(enabled.servers[0].message, /tools are now available/);
    assert.equal(manager.getTools('casual-a').length, 1);
    assert.equal(manager.getTools('casual-b').length, 0);
    assert.equal(clients.length, 1);
    await manager.manageServers('enable', ['first'], 'casual-b');
    assert.equal(clients.length, 1);
    await manager.manageServers('restart', ['first'], 'casual-a');
    assert.equal(clients.length, 2);
    assert.equal(clients[0].client.closed, true);
    await manager.manageServers('disable', ['first'], 'casual-a');
    assert.equal(manager.getTools('casual-a').length, 0);
    assert.equal(manager.getTools('casual-b').length, 1);
    await manager.manageServers('disable', ['first'], 'casual-b');
    assert.equal(clients[1].client.closed, true);
    assert.equal(manager.getTools().length, 0);
    await assert.rejects(manager.manageServers('enable', ['first', 'missing'], 'casual-a'), /Unknown MCP server/);
    assert.equal(manager.getTools('casual-a').length, 0);
    await manager.setServerEnabled('second', true);
    assert.equal(manager.getTools('casual-a').length, 1);
    assert.equal((await manager.getConfig()).mcpServers.second.uiEnabled, true);
    await manager.close();
    const restarted = new McpManager({ configPath, createConnection, lazyByDefault: true });
    try {
      await restarted.init();
      assert.equal(restarted.getTools('new-chat').length, 1);
      assert.equal(restarted.getStatus().servers.find(server => server.name === 'first').status, 'disabled');
    } finally { await restarted.close(); }
  } finally {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('manual mode exposes only UI-enabled servers and blocks dynamic activation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manual-'));
  const configPath = path.join(directory, 'mcp_config.json');
  let mode = 'auto';
  const manager = new McpManager({ configPath, lazyByDefault: true, getMcpMode: () => mode,
    createConnection: async () => ({ setNotificationHandler() {}, listTools: async () => ({ tools: [{ name: 'echo' }] }),
      callTool: async () => ({ content: [] }), close: async () => {} }) });
  try {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {
      selected: { command: 'selected', uiEnabled: true }, dynamic: { command: 'dynamic' },
    } }));
    await manager.init();
    await manager.manageServers('enable', ['dynamic'], 'chat');
    assert.equal(manager.getTools('chat').length, 2);
    mode = 'manual';
    assert.equal(manager.getTools('chat').length, 1);
    assert.equal(manager.getTools('chat')[0].function.name, manager.toolName('selected', 'echo'));
    assert.throws(() => manager.resolveTool(manager.toolName('dynamic', 'echo'), 'chat'), /unavailable/);
    await assert.rejects(manager.callTool('dynamic', 'echo', {}, { sessionId: 'chat' }), /not enabled/);
    await assert.rejects(manager.manageServers('enable', ['dynamic'], 'chat'), /Manual Mode/);
  } finally {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
