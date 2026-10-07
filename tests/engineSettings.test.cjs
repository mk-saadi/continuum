// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/engineSettings.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-settings-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const { DEFAULT_LOAD_CONFIG, normalizeLoadConfig, getLoadConfig, saveLoadConfig, forgetLoadConfig, getAppSettings, saveAppSettings, saveNotificationPrefs } = require('../src/main/configManager');
const { buildLlamaServerArgs } = require('../src/main/engineManager');
const { scanDirectoryForModels } = require('../src/main/modelScanner');
(async () => {
try {
  initDatabase();
  const store = require('../src/main/configStore');
  assert.equal(store.getConfig().engineIdleTimeoutMinutes, -1);
  store.saveConfig({ engineIdleTimeoutMinutes: 15 });
  assert.equal(store.getConfig().engineIdleTimeoutMinutes, 15);
  assert.throws(() => store.saveConfig({ engineIdleTimeoutMinutes: 3 }), /idle timeout/);
  assert.equal(store.getConfig().engineIdleTimeoutMinutes, 15);
  assert.equal(getAppSettings().apiServerPort, 8080);
  assert.equal(getAppSettings().mcpMode, 'auto');
  saveAppSettings({ apiServerPort: 9090 });
  saveAppSettings({ mcpMode: 'manual' });
  assert.deepEqual(getAppSettings(), { apiServerPort: 9090, mcpMode: 'manual',
    maxConsecutiveToolFailures: 5, maxTotalToolFailures: 10,
    notificationsEnabled: true, notifyOnlyWhenBackgrounded: true,
    notificationEvents: { completion: true, error: true, contextOverflow: true, action_required: true }, disabledSkills: [] });
  saveNotificationPrefs({ notificationsEnabled: false, notificationEvents: { completion: false } });
  assert.equal(getAppSettings().notificationsEnabled, false);
  assert.deepEqual(getAppSettings().notificationEvents,
    { completion: false, error: true, contextOverflow: true, action_required: true });
  assert.throws(() => saveNotificationPrefs({ notificationEvents: { completion: 'yes' } }), /notification events/);
  closeDatabase(); initDatabase();
  assert.equal(getAppSettings().apiServerPort, 9090);
  assert.equal(getAppSettings().mcpMode, 'manual');
  saveAppSettings({ maxConsecutiveToolFailures: 7, maxTotalToolFailures: 12 });
  closeDatabase(); initDatabase();
  assert.equal(getAppSettings().maxConsecutiveToolFailures, 7);
  assert.equal(getAppSettings().maxTotalToolFailures, 12);
  for (const value of [2, 11, 3.5, '5'])
    assert.throws(() => saveAppSettings({ maxConsecutiveToolFailures: value }), /Max Consecutive Tool Failures/);
  for (const value of [4, 26, 6.5, '10'])
    assert.throws(() => saveAppSettings({ maxTotalToolFailures: value }), /Max Total Tool Failures/);
  assert.throws(() => saveAppSettings({ mcpMode: 'invalid' }), /MCP mode/);
  for (const apiServerPort of [0, -1, 65536, 2.5, '8080']) {
    assert.throws(() => saveAppSettings({ apiServerPort }), /Local API Server Port/);
  }
  assert.equal(getAppSettings().apiServerPort, 9090);
  saveAppSettings({ apiServerPort: null });
  assert.equal(getAppSettings().apiServerPort, null);
  assert.equal(getAppSettings().mcpMode, 'manual');

  assert.deepEqual(getLoadConfig('a'), { config: DEFAULT_LOAD_CONFIG, remembered: false });
  saveLoadConfig('a', { threads: 8, seed: 42, loadMode: 'mmap+mlock', kvCacheQuantization: 'q8_0', chatTemplate: 'chatml', reasoningFormat: 'none', keepAliveMinutes: 15 });
  closeDatabase(); initDatabase();
  assert.equal(getLoadConfig('a').config.threads, 8);
  assert.equal(getLoadConfig('a').config.seed, 42);
  assert.equal(getLoadConfig('a').config.cacheTypeK, 'q8_0');
  assert.equal(getLoadConfig('a').config.chatTemplate, 'chatml');
  assert.equal(getLoadConfig('a').config.reasoningFormat, 'none');
  assert.equal(getLoadConfig('a').config.cacheTypeV, 'q8_0');
  assert.equal(getLoadConfig('a').config.mlock, true);
  assert.equal(getLoadConfig('a').config.keepAliveMinutes, undefined);
  assert.equal(getLoadConfig('b').remembered, false);
  forgetLoadConfig('a');
  assert.deepEqual(getLoadConfig('a').config, DEFAULT_LOAD_CONFIG);
  assert.throws(() => normalizeLoadConfig({ loadMode: '--no-mmap' }), /load mode/);
  assert.throws(() => normalizeLoadConfig({ threads: '4; echo bad' }), /positive integer/);
  assert.throws(() => normalizeLoadConfig({ physicalBatch: 4096 }), /exceed/);
  assert.throws(() => normalizeLoadConfig({ gpuOffload: -1 }), /GPU/);
  assert.throws(() => normalizeLoadConfig({ seed: 1.5 }), /Seed/);
  const model = { modelPath: '/models/a b;$(echo nope).gguf', isVision: true, mmprojPath: '/models/mmproj a.gguf' };
  const args = buildLlamaServerArgs(model, { seed: 42 }, 12345);
  assert.deepEqual(args, ['-m', model.modelPath, '--jinja', '-c', '8192', '-ngl', 'auto', '-t', '4', '-b', '2048', '-ub', '512', '-np', '1', '-fa', 'auto', '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--reasoning-format', 'auto', '-s', '42', '--port', '12345', '--mmproj', model.mmprojPath]);
  for (const loadMode of ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']) {
    const result = buildLlamaServerArgs({ modelPath: 'test.gguf' }, { loadMode, gpuOffload: 0 }, 8080);
    assert.equal(result.includes('-lm'), false);
    assert.equal(result.includes('--mlock'), ['mlock', 'mmap+mlock'].includes(loadMode));
    assert.equal(result.includes('--mmproj'), false);
    assert.equal(result.includes('--no-mmap'), false);
  }
  fs.writeFileSync(path.join(directory, 'vision.gguf'), '');
  fs.writeFileSync(path.join(directory, 'mmproj-vision.gguf'), '');
  let scanned = await scanDirectoryForModels(directory);
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].isVision, true);
  fs.writeFileSync(path.join(directory, 'other.gguf'), '');
  scanned = await scanDirectoryForModels(directory);
  assert.equal(scanned.find(m => m.name.endsWith('/other.gguf')).isVision, true);
  assert.equal(scanned.find(m => m.name.endsWith('/vision.gguf')).isVision, true);
  console.log('Settings persistence, defaults, validation, CLI arguments, and projector scanning passed.');
} finally {
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}

})().catch(error => { console.error(error); process.exitCode = 1; });
