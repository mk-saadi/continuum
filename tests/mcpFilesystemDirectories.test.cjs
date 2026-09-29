const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');

function fixture(getGlobalConfig) {
  const launches = [];
  const manager = new McpManager({ getGlobalConfig, createConnection: async definition => {
    launches.push(definition);
    return { setNotificationHandler() {}, listTools: async () => ({ tools: [] }), close: async () => {} };
  } });
  return { manager, launches };
}

test('injects current absolute directories once per launch without mutating saved config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-directories-'));
  const appDataDirectory = path.join(root, 'App Data');
  let modelDirectory = path.join(root, 'Models');
  const { manager, launches } = fixture(() => ({ appDataDirectory, modelDirectory }));
  manager.configPath = path.join(root, 'mcp.json');
  const definition = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', appDataDirectory + path.sep] };
  const config = { mcpServers: { files: definition } };
  try {
    await manager.saveConfig(config);
    assert.deepEqual(launches[0].args, [...definition.args, modelDirectory]);
    assert.deepEqual(await manager.getConfig(), config);
    assert.equal(definition.args.length, 3);
    modelDirectory = path.join(root, 'New Models');
    await manager.setServerEnabled('files', false);
    await manager.setServerEnabled('files', true);
    assert.deepEqual(launches[1].args, [...definition.args, modelDirectory]);
    assert.deepEqual((await manager.getConfig()).mcpServers.files.args, definition.args);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('detects filesystem names and versioned packages, handles missing args and identical paths', async () => {
  const directory = path.resolve(os.tmpdir(), 'MCP Files');
  const { manager, launches } = fixture(() => ({ appDataDirectory: directory, modelDirectory: directory + path.sep }));
  try {
    await manager.connectServer('filesystem', { command: 'custom-filesystem' });
    await manager.connectServer('renamed', { command: 'npx', args: ['@modelcontextprotocol/server-filesystem@2026.1.1'] });
    assert.deepEqual(launches[0].args, [directory]);
    assert.deepEqual(launches[1].args, ['@modelcontextprotocol/server-filesystem@2026.1.1', directory]);
  } finally { await manager.close(); }
});

test('leaves unrelated, remote and disabled servers alone', async () => {
  const { manager, launches } = fixture(() => { throw new Error('Must not read global config'); });
  const unrelated = { command: 'node', args: ['other-server.js'] };
  const remote = { url: 'http://localhost:3000/sse' };
  try {
    await manager.connectServer('other', unrelated);
    await manager.connectServer('filesystem', remote);
    await manager.connectServer('disabled', { command: 'npx', args: ['@modelcontextprotocol/server-filesystem'], disabled: true });
    assert.deepEqual(launches, [unrelated, remote]);
    assert.equal(manager.servers.get('disabled').status, 'disabled');
  } finally { await manager.close(); }
});

test('invalid injected paths fail before spawning', async () => {
  for (const invalid of ['relative/path', 'https://example.com/path', '/tmp/bad\0path', 42]) {
    const { manager, launches } = fixture(() => ({ appDataDirectory: invalid }));
    try {
      await manager.connectServer('filesystem', { command: 'npx' });
      assert.equal(launches.length, 0);
      assert.equal(manager.servers.get('filesystem').status, 'error');
      assert.match(manager.servers.get('filesystem').error, /absolute paths/);
    } finally { await manager.close(); }
  }
});
