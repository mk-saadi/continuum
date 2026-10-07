// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/modelLoadSettings.test.cjs
// Focused coverage for the advanced load settings added to ModelSettingsModal:
// KV cache offload, load mode, MoE expert count, mlock compatibility, and K/V precision precedence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-load-settings-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const { DEFAULT_LOAD_CONFIG, normalizeLoadConfig, getLoadConfig, saveLoadConfig, forgetLoadConfig } = require('../src/main/configManager');
const { buildLlamaServerArgs } = require('../src/main/engineManager');
const { parseModelMetadata } = require('../src/main/modelScanner');

const flagValue = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const model = { modelPath: '/models/gemma4-a4b.gguf', architecture: 'gemma4', isMoe: true, expertCount: 128 };

// Minimal GGUF header (magic, version, tensor count, kv count, key/value pairs).
function writeGguf(file, kvs) {
  const parts = [];
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  const str = value => { const raw = Buffer.from(String(value), 'utf8'); return Buffer.concat([u64(raw.length), raw]); };
  parts.push(Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(kvs.length));
  for (const [key, type, encode] of kvs) parts.push(str(key), u32(type), encode());
  fs.writeFileSync(file, Buffer.concat(parts));
}

(async () => {
try {
  initDatabase();

  // 1. Default config and default command line are unchanged.
  const defaults = normalizeLoadConfig({});
  assert.deepEqual(defaults, DEFAULT_LOAD_CONFIG);
  assert.equal(defaults.loadMode, 'auto');
  assert.equal(defaults.kvCacheOffload, 'gpu');
  assert.equal(defaults.moeExpertCount, null);
  assert.deepEqual(buildLlamaServerArgs(model, { seed: 42 }, 12345), [
    '-m', model.modelPath, '--jinja', '-c', '8192', '-ngl', 'auto', '-t', '4', '-b', '2048',
    '-ub', '512', '-np', '1', '-fa', 'auto', '--cache-type-k', 'f16', '--cache-type-v', 'f16',
    '--reasoning-format', 'auto', '-s', '42', '--port', '12345']);
  // Architecture metadata alone never adds an override.
  assert.equal(buildLlamaServerArgs(model, {}, 8080).includes('--override-kv'), false);

  // 2. Old saved config shapes load with their original behavior.
  const loadModeOnly = normalizeLoadConfig({ loadMode: 'mmap+mlock', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', threads: 8 });
  assert.equal(loadModeOnly.loadMode, 'mmap+mlock');
  assert.equal(loadModeOnly.mlock, true);
  assert.equal(normalizeLoadConfig({ loadMode: 'none' }).mlock, false);
  const mlockOnly = normalizeLoadConfig({ mlock: true, cacheTypeK: 'q4_0' });
  assert.equal(mlockOnly.loadMode, 'auto');
  assert.equal(mlockOnly.mlock, true);
  assert.equal(mlockOnly.cacheTypeK, 'q4_0');
  assert.equal(mlockOnly.kvCacheOffload, 'gpu');
  assert.equal(normalizeLoadConfig({ kvCacheQuantization: 'q8_0' }).cacheTypeV, 'q8_0');
  // A raw row written before the new keys existed still loads and normalizes.
  db.prepare('INSERT INTO model_load_configs(model_id, config_json) VALUES (?, ?) ON CONFLICT(model_id) DO UPDATE SET config_json = excluded.config_json')
    .run('legacy-model', JSON.stringify({ contextLength: 4096, mlock: true, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' }));
  const legacy = getLoadConfig('legacy-model');
  assert.equal(legacy.remembered, true);
  assert.equal(legacy.config.contextLength, 4096);
  assert.equal(legacy.config.mlock, true);
  assert.equal(legacy.config.loadMode, 'auto');
  assert.equal(legacy.config.kvCacheOffload, 'gpu');
  assert.equal(legacy.config.moeExpertCount, null);
  forgetLoadConfig('legacy-model');

  // 3./4. KV cache offload: GPU default omits the flag, CPU emits the supported disable flag.
  assert.equal(buildLlamaServerArgs(model, { kvCacheOffload: 'gpu' }, 8080).includes('--no-kv-offload'), false);
  assert.equal(buildLlamaServerArgs(model, {}, 8080).includes('--no-kv-offload'), false);
  const cpuOffload = buildLlamaServerArgs(model, { kvCacheOffload: 'cpu' }, 8080);
  assert.equal(cpuOffload.includes('--no-kv-offload'), true);
  // Standalone disable flag: it consumes no value argument.
  assert.ok(cpuOffload[cpuOffload.indexOf('--no-kv-offload') + 1].startsWith('--'));
  // Offload stays independent from K/V cache precision.
  const cpuQuantized = buildLlamaServerArgs(model, { kvCacheOffload: 'cpu', cacheTypeK: 'q8_0', cacheTypeV: 'q4_0' }, 8080);
  assert.ok(cpuQuantized.includes('--no-kv-offload'));
  assert.equal(flagValue(cpuQuantized, '--cache-type-k'), 'q8_0');
  assert.equal(flagValue(cpuQuantized, '--cache-type-v'), 'q4_0');

  // 5. Load Mode none reaches the CLI as --load-mode none.
  const none = buildLlamaServerArgs(model, { loadMode: 'none' }, 8080);
  assert.equal(flagValue(none, '--load-mode'), 'none');
  assert.equal(none.includes('-lm'), false);
  assert.equal(none.includes('--no-mmap'), false);

  // 6. Every other supported load mode maps to its value; auto emits nothing.
  for (const mode of ['mmap', 'dio', 'mlock', 'mmap+mlock']) {
    const args = buildLlamaServerArgs(model, { loadMode: mode }, 8080);
    assert.equal(flagValue(args, '--load-mode'), mode);
    assert.equal(args.includes('--no-mmap'), false);
  }
  assert.equal(buildLlamaServerArgs(model, { loadMode: 'auto' }, 8080).includes('--load-mode'), false);
  // mlock modes keep the legacy --mlock flag, with --load-mode last so it decides the mode.
  for (const mode of ['mlock', 'mmap+mlock']) {
    const args = buildLlamaServerArgs(model, { loadMode: mode }, 8080);
    assert.ok(args.includes('--mlock'));
    assert.ok(args.indexOf('--mlock') < args.indexOf('--load-mode'));
  }

  // 7. MoE expert count stays off the command line when Auto/empty.
  for (const value of [null, undefined, '']) {
    assert.equal(buildLlamaServerArgs(model, { moeExpertCount: value }, 8080).includes('--override-kv'), false);
  }
  // Without a usable architecture the override cannot be formed and is skipped.
  assert.equal(buildLlamaServerArgs({ modelPath: 'dense.gguf' }, { moeExpertCount: 64 }, 8080).includes('--override-kv'), false);
  assert.equal(buildLlamaServerArgs({ modelPath: 'dense.gguf', architecture: 'bad arch;$(x)' }, { moeExpertCount: 64 }, 8080).includes('--override-kv'), false);

  // 8. An explicit expert count reaches llama-server through the supported override mechanism.
  const experts = buildLlamaServerArgs(model, { moeExpertCount: 128 }, 8080);
  assert.equal(flagValue(experts, '--override-kv'), 'gemma4.expert_count=int:128');
  assert.equal(buildLlamaServerArgs(model, { moeExpertCount: 128, gpuOffload: 0 }, 8080).includes('--no-kv-offload'), false);

  // 9. Invalid values are rejected, empty values normalize to auto.
  assert.throws(() => normalizeLoadConfig({ loadMode: 'fast' }), /load mode/i);
  assert.throws(() => normalizeLoadConfig({ loadMode: '--no-mmap' }), /load mode/i);
  assert.throws(() => normalizeLoadConfig({ kvCacheOffload: 'ram' }), /KV cache offload/i);
  for (const value of [0, -1, 1.5, '8', NaN, 2147483648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => normalizeLoadConfig({ moeExpertCount: value }), /MoE expert count/, `reject ${String(value)}`);
  }
  assert.equal(normalizeLoadConfig({ moeExpertCount: '' }).moeExpertCount, null);
  assert.equal(normalizeLoadConfig({ moeExpertCount: null }).moeExpertCount, null);

  // 10. Existing mlock behavior is preserved: mlock alone never adds --load-mode.
  const locked = buildLlamaServerArgs(model, { mlock: true }, 8080);
  assert.ok(locked.includes('--mlock'));
  assert.equal(locked.includes('--load-mode'), false);
  assert.equal(locked.includes('--no-kv-offload'), false);

  // 11. Explicit K/V precision is the only source of truth; FP16 KV is represented by f16,
  // so a convenience flag input can never rewrite q8_0/q4_0 selections or persist as a key.
  const precision = normalizeLoadConfig({ cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', useFp16KvCache: 'on' });
  assert.equal(precision.cacheTypeK, 'q8_0');
  assert.equal(precision.cacheTypeV, 'q4_0');
  assert.equal(Object.hasOwn(precision, 'useFp16KvCache'), false);
  const precisionArgs = buildLlamaServerArgs(model, precision, 8080);
  assert.equal(flagValue(precisionArgs, '--cache-type-k'), 'q8_0');
  assert.equal(flagValue(precisionArgs, '--cache-type-v'), 'q4_0');
  assert.equal(normalizeLoadConfig({ useFp16KvCache: 'off' }).cacheTypeK, 'f16');

  // Settings persist across reload: save, reopen the database, rebuild the command line.
  saveLoadConfig('gemma4-a4b', { loadMode: 'none', kvCacheOffload: 'cpu', moeExpertCount: 120, cacheTypeK: 'q8_0', cacheTypeV: 'q4_0' });
  closeDatabase(); initDatabase();
  const reloaded = getLoadConfig('gemma4-a4b');
  assert.equal(reloaded.remembered, true);
  assert.equal(reloaded.config.loadMode, 'none');
  assert.equal(reloaded.config.kvCacheOffload, 'cpu');
  assert.equal(reloaded.config.moeExpertCount, 120);
  assert.equal(reloaded.config.mlock, false);
  const reloadedArgs = buildLlamaServerArgs(model, reloaded.config, 8080);
  assert.equal(flagValue(reloadedArgs, '--load-mode'), 'none');
  assert.ok(reloadedArgs.includes('--no-kv-offload'));
  assert.equal(flagValue(reloadedArgs, '--override-kv'), 'gemma4.expert_count=int:120');
  assert.equal(flagValue(reloadedArgs, '--cache-type-k'), 'q8_0');
  forgetLoadConfig('gemma4-a4b');

  // GGUF header parsing (existing scanner path, no model load) reports MoE metadata.
  const moeFile = path.join(directory, 'Gemma4-A4B-Q4_K.gguf');
  writeGguf(moeFile, [
    ['general.architecture', 8, () => Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('gemma4')])],
    ['gemma4.expert_count', 4, () => { const b = Buffer.alloc(4); b.writeUInt32LE(128); return b; }],
  ]);
  const moeMeta = await parseModelMetadata(moeFile, 'Gemma4-A4B-Q4_K.gguf', fs.statSync(moeFile), []);
  assert.equal(moeMeta.architecture, 'gemma4');
  assert.equal(moeMeta.expertCount, 128);
  assert.equal(moeMeta.isMoe, true);
  const denseFile = path.join(directory, 'dense-1.5B.gguf');
  writeGguf(denseFile, [
    ['general.architecture', 8, () => Buffer.concat([Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('llama')])],
  ]);
  const denseMeta = await parseModelMetadata(denseFile, 'dense-1.5B.gguf', fs.statSync(denseFile), []);
  assert.equal(denseMeta.architecture, 'llama');
  assert.equal(denseMeta.expertCount, null);
  assert.equal(denseMeta.isMoe, false);
  const brokenMeta = await parseModelMetadata(path.join(directory, 'absent.gguf'), 'absent.gguf', { size: 4 }, []);
  assert.equal(brokenMeta.architecture, null);
  assert.equal(brokenMeta.expertCount, null);
  assert.equal(brokenMeta.isMoe, false);

  // Installed binary verification: every emitted flag must exist in our llama-server build.
  const help = spawnSync('llama-server', ['--help'], { encoding: 'utf8', timeout: 30000 });
  const helpText = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  if (help.error || help.status !== 0) {
    console.log('llama-server --help unavailable; skipped installed-binary flag verification.');
  } else {
    assert.match(helpText, /--load-mode MODE/);
    assert.match(helpText, /--no-kv-offload/);
    assert.match(helpText, /--override-kv KEY=TYPE:VALUE/);
    assert.doesNotMatch(helpText, /--expert-count|--n-experts|--num-experts/);
    assert.match(helpText, /- mlock: force system to keep model in RAM/);
    assert.match(helpText, /- mmap\+mlock: mmap \+ force system to keep model in RAM/);
    assert.match(helpText, /- dio: use DirectIO if available/);
    // The fully built command line must parse all the way to model loading.
    const launch = spawnSync('llama-server',
      buildLlamaServerArgs({ modelPath: '/nonexistent-continuum.gguf', architecture: 'gemma4' },
        { loadMode: 'none', kvCacheOffload: 'cpu', moeExpertCount: 128 }, 19999),
      { encoding: 'utf8', timeout: 30000 });
    const launchText = `${launch.stdout ?? ''}${launch.stderr ?? ''}`;
    assert.doesNotMatch(launchText, /invalid argument/i);
    assert.match(launchText, /nonexistent-continuum\.gguf/);
  }

  console.log('Advanced load settings: defaults, legacy configs, validation, persistence, and CLI wiring passed.');
} finally {
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}

})().catch(error => { console.error(error); process.exitCode = 1; });
