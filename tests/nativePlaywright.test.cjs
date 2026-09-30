const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');
const { nativePlaywrightConfig, resolveNativePlaywright, prepareNativePlaywright } = require('../src/main/nativePlaywright');

test('native config uses the installed CLI, the internal runtime and headless Chromium', async () => {
  const config = nativePlaywrightConfig();
  assert.equal(config.command, process.execPath);
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(config.enabled, true);
  assert.ok(path.isAbsolute(config.args[0]));
  await fs.access(config.args[0]);
  assert.equal(path.basename(config.args[0]), 'cli.js');
  assert.ok(config.args.includes('--headless'));
  assert.ok(path.isAbsolute(config.args[3]));
  assert.equal(nativePlaywrightConfig(os.tmpdir()).cwd, os.tmpdir());
  await prepareNativePlaywright('custom', {});
  await prepareNativePlaywright('playwright-native', { command: 'custom', args: [] });
});

test('startup seeds native Playwright once, preserves user config and disabled state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-playwright-'));
  const configPath = path.join(directory, 'mcp_config.json');
  const prepared = [];
  const launches = [];
  const options = { configPath,
    getNativeServers: () => ({ 'playwright-native': nativePlaywrightConfig() }),
    prepareServer: async name => prepared.push(name),
    createConnection: async definition => {
      launches.push(definition);
      return { setNotificationHandler() {}, listTools: async () => ({ tools: [] }), close: async () => {} };
    },
  };
  let manager = new McpManager(options);
  try {
    await fs.writeFile(configPath, JSON.stringify({ customOption: 'keep', mcpServers: { custom: { command: 'custom' } } }));
    await manager.init();
    let config = await manager.getConfig();
    assert.equal(config.customOption, 'keep');
    assert.equal(config.mcpServers.custom.command, 'custom');
    assert.deepEqual(config.mcpServers['playwright-native'], nativePlaywrightConfig());
    assert.ok(prepared.includes('playwright-native'));
    await manager.reload();
    assert.equal(launches.length, 2, 'unchanged native server is not restarted');
    await manager.setServerEnabled('playwright-native', false);
    config = await manager.getConfig();
    await manager.close();
    prepared.length = 0;
    manager = new McpManager(options);
    await manager.init();
    assert.deepEqual(await manager.getConfig(), config);
    assert.ok(!prepared.includes('playwright-native'), 'disabled browser is neither installed nor launched');
    await manager.close();
    const invalid = '{ unfinished';
    await fs.writeFile(configPath, invalid);
    manager = new McpManager(options);
    await manager.init();
    assert.ok(manager.getStatus().error);
    assert.equal(await fs.readFile(configPath, 'utf8'), invalid);
  } finally {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fresh startup creates the central config with Playwright enabled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-playwright-new-'));
  const manager = new McpManager({
    configPath: path.join(directory, 'nested', 'mcp_config.json'),
    getNativeServers: () => ({ 'playwright-native': nativePlaywrightConfig() }),
    createConnection: async () => ({ setNotificationHandler() {}, listTools: async () => ({ tools: [] }), close: async () => {} }),
  });
  try {
    await manager.init();
    assert.equal((await manager.getConfig()).mcpServers['playwright-native'].enabled, true);
    assert.equal(manager.getStatus().servers[0].status, 'connected');
  } finally {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native launches resolve legacy Node and stale AppImage paths without changing saved options', () => {
  const native = nativePlaywrightConfig();
  for (const command of ['node', '/tmp/.mount_old/assistant']) {
    const saved = { ...native, command, args: ['/tmp/.mount_old/resources/app.asar.unpacked/node_modules/@playwright/mcp/cli.js', ...native.args.slice(1)],
      env: { CUSTOM: 'keep', ...(command === 'node' ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }, disabledTools: ['browser_click'] };
    const snapshot = structuredClone(saved);
    const launch = resolveNativePlaywright('playwright-native', saved);
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.args[0], native.args[0]);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(launch.env.CUSTOM, 'keep');
    assert.deepEqual(launch.disabledTools, saved.disabledTools);
    assert.deepEqual(saved, snapshot);
  }
  const custom = { command: 'node', args: ['/custom/server.js'] };
  assert.equal(resolveNativePlaywright('playwright-native', custom), custom);
  assert.equal(resolveNativePlaywright('custom', native), native);
});
