const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-permissions-'));
  const configPath = path.join(directory, 'config.json');
  const clients = [];
  const options = { configPath, createConnection: async definition => {
    const client = {
      command: definition.command, closed: false, setNotificationHandler() {},
      listTools: async () => ({ tools: ['run_command', 'run_script'].map(name => ({ name, inputSchema: { type: 'object' } })) }),
      callTool: async () => ({ content: [] }),
      async close() { this.closed = true; this.onclose?.(); },
    };
    clients.push(client); return client;
  } };
  const manager = new McpManager(options);
  await manager.saveConfig({ extra: 'retained', mcpServers: { terminal: { command: 'terminal', env: { SETTING: 'value' } }, other: { command: 'other' } } });
  return { manager, clients, options, cleanup: async () => { await manager.close(); await fs.rm(directory, { recursive: true }); } };
}

test('tool permissions persist atomically, update declarations and reject execution without reconnecting', async () => {
  const { manager, clients, options, cleanup } = await fixture();
  const changed = [];
  manager.on('changed', () => changed.push(manager.getTools().length));
  try {
    await Promise.all([
      manager.setToolEnabled('run_command', false, 'terminal'),
      manager.setToolEnabled('run_script', false, 'terminal'),
    ]);
    assert.deepEqual((await manager.getConfig()).mcpServers.terminal.disabledTools.sort(), ['run_command', 'run_script']);
    assert.equal(manager.getTools().length, 2);
    assert.equal(clients.length, 2);
    assert.ok(clients.every(c => !c.closed));
    await assert.rejects(manager.callTool('terminal', 'run_command', {}), /disabled/);
    assert.deepEqual(changed, [3, 2]);
    const restarted = new McpManager(options);
    try {
      await restarted.init();
      assert.equal(restarted.getTools().length, 2);
      await assert.rejects(restarted.callTool('terminal', 'run_script', {}), /disabled/);
    } finally { await restarted.close(); }
    await manager.setAllToolsEnabled('terminal', true);
    assert.equal(manager.getTools().length, 4);
    assert.deepEqual((await manager.getConfig()).mcpServers.terminal.disabledTools, []);
    await manager.setAllToolsEnabled('terminal', false);
    assert.equal(manager.getTools().length, 2);
    await manager.setToolEnabled(manager.toolName('terminal', 'run_script'), true);
    assert.equal(manager.getTools().length, 3);
    assert.equal((await manager.getConfig()).extra, 'retained');
    assert.deepEqual((await manager.getConfig()).mcpServers.terminal.env, { SETTING: 'value' });
  } finally { await cleanup(); }
});

test('master switches close only their server, retain tool permissions, and persist legacy enabled alias correctly', async () => {
  const { manager, clients, options, cleanup } = await fixture();
  try {
    await manager.setToolEnabled('run_command', false, 'terminal');
    await manager.setServerEnabled('terminal', false);
    assert.equal(clients[0].closed, true);
    assert.equal(clients[1].closed, false);
    assert.equal(manager.getTools().length, 2);
    assert.equal(manager.getStatus().servers[0].status, 'disabled');
    assert.equal(manager.getStatus().servers[0].tools.length, 2);
    assert.equal((await manager.getConfig()).mcpServers.terminal.disabled, true);
    await assert.rejects(manager.callTool('terminal', 'run_script', {}), /disabled/);
    const restarted = new McpManager(options);
    try {
      await restarted.init();
      assert.equal(restarted.getStatus().servers[0].status, 'disabled');
    } finally { await restarted.close(); }
    await manager.setServerEnabled('terminal', true);
    assert.equal(clients[1].closed, false);
    assert.equal(manager.getTools().length, 3);
    assert.equal(manager.getStatus().servers[0].status, 'connected');
    assert.deepEqual((await manager.getConfig()).mcpServers.terminal.disabledTools, ['run_command']);
    const config = await manager.getConfig();
    config.mcpServers.terminal.enabled = false;
    await manager.saveConfig(config);
    await manager.setServerEnabled('terminal', true);
    assert.equal((await manager.getConfig()).mcpServers.terminal.enabled, undefined);
    assert.equal(manager.getStatus().servers[0].status, 'connected');
  } finally { await cleanup(); }
});

test('failed permission writes leave active permissions and token declarations unchanged', async () => {
  const { manager, cleanup } = await fixture();
  const originalWrite = manager.writeConfig;
  try {
    manager.writeConfig = async () => { throw new Error('Write failed'); };
    await assert.rejects(manager.setAllToolsEnabled('terminal', false), /Write failed/);
    await assert.rejects(manager.setServerEnabled('terminal', false), /Write failed/);
    assert.equal(manager.getTools().length, 4);
    assert.equal(manager.getStatus().servers[0].enabled, true);
    assert.equal((await manager.getConfig()).mcpServers.terminal.disabledTools, undefined);
  } finally { manager.writeConfig = originalWrite; await cleanup(); }
});
