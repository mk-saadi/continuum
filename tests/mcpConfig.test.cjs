const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');

test('saves create directories, preserve options, reload tools and close old clients', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-save-'));
  const clients = [];
  const manager = new McpManager({ configPath: path.join(directory, 'nested', 'mcp_config.json'), createConnection: async definition => {
    const client = {
      closed: false, setNotificationHandler() {},
      listTools: async () => ({ tools: [{ name: definition.command, inputSchema: { type: 'object' } }] }),
      async close() { this.closed = true; this.onclose?.(); },
    };
    clients.push(client);
    return client;
  } });
  try {
    assert.deepEqual(await manager.getConfig(), { mcpServers: {} });
    await manager.init();
    const config = { customOption: 'preserve me', mcpServers: { first: { command: 'echo', args: ['path with spaces'], env: { SETTING: 'value' }, cwd: '/tmp', disabledTools: [] } } };
    assert.deepEqual(await manager.saveConfig(config), config);
    assert.deepEqual(await manager.getConfig(), config);
    assert.equal(manager.getTools().length, 1);
    assert.equal(manager.resolveTool(manager.getTools()[0].function.name).serverName, 'first');
    const old = manager.getTools()[0].function.name;
    await manager.saveConfig({ mcpServers: { second: { command: 'other' } } });
    assert.equal(clients[0].closed, true);
    assert.throws(() => manager.resolveTool(old), /unavailable/);
    assert.equal(manager.getStatus().servers[0].name, 'second');
    const current = await manager.getConfig();
    for (const invalid of [null, [], {}, { mcpServers: [] }, { mcpServers: { bad: { command: 'echo', args: 'invalid' } } }]) {
      await assert.rejects(manager.saveConfig(invalid), TypeError);
      assert.deepEqual(await manager.getConfig(), current);
      assert.equal(clients[1].closed, false);
    }
    await Promise.all([
      manager.saveConfig({ mcpServers: { third: { command: 'third' } } }),
      manager.saveConfig({ mcpServers: {} }),
    ]);
    assert.deepEqual(await manager.getConfig(), { mcpServers: {} });
    assert.deepEqual(manager.getTools(), []);
    assert.ok(clients.every(client => client.closed));
    assert.deepEqual(await fs.readdir(path.dirname(manager.configPath)), ['mcp_config.json']);
  } finally { await manager.close(); await fs.rm(directory, { recursive: true }); }
});

test('save repairs malformed config and write failure preserves active connections', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-repair-'));
  const configPath = path.join(directory, 'mcp_config.json');
  const manager = new McpManager({ configPath });
  try {
    await fs.writeFile(configPath, '{');
    await assert.rejects(manager.getConfig(), SyntaxError);
    await manager.init();
    assert.ok(manager.getStatus().error);
    await manager.saveConfig({ mcpServers: {} });
    assert.equal(manager.getStatus().error, undefined);
    let closed = false;
    manager.servers.set('active', { client: { close: async () => { closed = true; } } });
    manager.configPath = path.join(configPath, 'cannot-create-here.json');
    await assert.rejects(manager.saveConfig({ mcpServers: {} }));
    assert.equal(closed, false);
  } finally { await manager.close(); await fs.rm(directory, { recursive: true }); }
});

test('URL-only klikbase saves and initializes without a command; missing both fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-klikbase-'));
  const configPath = path.join(directory, 'config.json');
  const connected = [];
  const createConnection = async definition => {
    connected.push(definition);
    return { setNotificationHandler() {}, listTools: async () => ({ tools: [] }), close: async () => {} };
  };
  const manager = new McpManager({ configPath, createConnection });
  const restarted = new McpManager({ configPath, createConnection });
  const config = { mcpServers: {
    klikbase: { url: 'https://example.com/sse', headers: { Authorization: 'Bearer fixture-token' } },
    local: { command: 'node', args: ['server.js'] },
  } };
  try {
    await manager.saveConfig(config);
    assert.deepEqual(await manager.getConfig(), config);
    assert.ok(manager.getStatus().servers.every(server => server.status === 'connected'));
    await restarted.init();
    assert.ok(restarted.getStatus().servers.every(server => server.status === 'connected'));
    assert.equal(connected.length, 4);
    await assert.rejects(manager.saveConfig({ mcpServers: { klikbase: { headers: {} } } }), /Invalid configuration for klikbase: missing command or url/);
    assert.deepEqual(await manager.getConfig(), config);
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { missing: {} } }));
    const invalid = new McpManager({ configPath, createConnection });
    await invalid.init();
    assert.match(invalid.getStatus().servers[0].error, /missing command or url/);
    await invalid.close();
  } finally {
    await manager.close(); await restarted.close(); await fs.rm(directory, { recursive: true });
  }
});
