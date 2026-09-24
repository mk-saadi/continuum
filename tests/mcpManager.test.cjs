const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');

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
