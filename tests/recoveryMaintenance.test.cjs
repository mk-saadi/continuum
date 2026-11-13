'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-policy-'));
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return original.call(this, name, ...args);
};
const database = require('../src/main/db');
database.initDatabase(directory);
const recovery = require('../src/main/recoveryStore');
const gate = require('../src/main/recoveryMaintenanceGate');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test.after(() => {
  database.closeDatabase();
  Module._load = original;
  fs.rmSync(directory, { recursive: true, force: true });
});
test('metadata alone triggers oldest-first cap eviction and byte totals follow updates/deletes', async () => {
  const root = path.join(directory, 'workspace'); fs.mkdirSync(root);
  const first = await recovery.captureOperation({ root, paths: [], op: { padding: 'é'.repeat(700000) } });
  const second = await recovery.captureOperation({ root, paths: [] });
  const stats = await recovery.getRecoveryStats();
  assert.equal(stats.blobBytes, 0);
  assert.ok(stats.metadataBytes > 1400000, 'count UTF-8 bytes, not characters');
  const report = await recovery.pruneRecovery({ storageCapMB: 1 });
  assert.deepEqual(report.capEvicted, [first.checkpointId]);
  assert.ok(recovery.getCheckpoint(second.checkpointId));
  assert.ok(report.storage.physicalBytes <= 1048576);
  await recovery.recordOpPostState(second.checkpointId, { padding: 'x'.repeat(1500000) });
  const next = await recovery.pruneRecovery({ storageCapMB: 1 });
  assert.deepEqual(next.capEvicted, [second.checkpointId], 'even latest oversized checkpoint must go');
  assert.equal(next.storage.checkpointCount, 0);
  assert.equal(next.capShortfallMB, 0);
});
test('automatic cleanup after capture honors configured cap without pressing cleanup', async () => {
  const root = path.join(directory, 'automatic'); fs.mkdirSync(root);
  require('../src/main/configManager').saveAppSettings({ recoveryStorageCapMB: 64 });
  await recovery.captureOperation({ root, paths: [], op: { padding: 'x'.repeat(65 * 1048576) } });
  const deadline = Date.now() + 10000;
  let stats;
  do {
    await delay(100);
    stats = await recovery.getRecoveryStats();
  } while (stats.checkpointCount && Date.now() < deadline);
  assert.equal(stats.checkpointCount, 0);
  assert.ok(stats.physicalBytes <= 64 * 1048576);
});
test('complete post-state stores only differences and restores unchanged-path conflict checks', async () => {
  const root = path.join(directory, 'delta'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'unchanged.txt'), 'original');
  fs.writeFileSync(path.join(root, 'changed.txt'), 'before');
  const scan = await recovery.scanWorkspaceState(root);
  const pre = await recovery.commitScanResult({ root, scan });
  fs.writeFileSync(path.join(root, 'changed.txt'), 'after');
  const post = await recovery.scanWorkspaceState(root);
  await recovery.finalizeBoundaryCheckpoint(pre.checkpointId, {
    postPaths: post.manifest.paths, changed: recovery.diffStates(pre.manifest.paths, post.manifest.paths),
  });
  const raw = JSON.parse(database.db.prepare('SELECT op_json FROM recovery_checkpoints WHERE id = ?').get(pre.checkpointId).op_json);
  assert.equal(raw.postStateBase, 'manifest');
  assert.deepEqual(Object.keys(raw.postState), ['changed.txt']);
  fs.writeFileSync(path.join(root, 'unchanged.txt'), 'later user edit');
  const restored = await recovery.restoreCheckpoint(pre.checkpointId, { preRestore: false });
  assert.equal(fs.readFileSync(path.join(root, 'changed.txt'), 'utf8'), 'before');
  assert.equal(fs.readFileSync(path.join(root, 'unchanged.txt'), 'utf8'), 'later user edit');
  assert.ok(restored.skipped.some(entry => entry.path === 'unchanged.txt'));
});
test('cleanup waits for concurrent workflows and nested capture calls do not deadlock', async () => {
  const events = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const workflow = gate.run(async () => {
    events.push('capture');
    await held;
    await gate.run(async () => events.push('post-state'));
  });
  await delay(0);
  const cleanup = gate.exclusive(async () => events.push('cleanup'));
  const later = gate.run(async () => events.push('next'));
  await delay(10);
  assert.deepEqual(events, ['capture']);
  release();
  await Promise.all([workflow, cleanup, later]);
  assert.deepEqual(events, ['capture', 'post-state', 'cleanup', 'next']);
});

test('real shell boundary stays alive through cleanup and never repeats completed effects', async () => {
  const root = path.join(directory, 'boundary-race'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'value.txt'), 'before');
  const boundary = require('../src/main/recoveryBoundary');
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let effects = 0;
  const operation = boundary.withShellRecovery({ root, toolName: 'execute_command' }, async () => {
    effects++; fs.writeFileSync(path.join(root, 'value.txt'), 'after'); entered(); await wait;
    return { output: 'command completed', exitCode: 0 };
  });
  await started;
  let cleaned = false;
  const cleanup = recovery.pruneRecovery({ storageCapMB: 0 }).then(result => { cleaned = true; return result; });
  await delay(300);
  assert.equal(cleaned, false, 'cleanup cannot delete the in-flight boundary');
  release();
  const result = await operation; await cleanup;
  assert.equal(effects, 1); assert.equal(result.exitCode, 0);
  assert.equal(result.recoveryPostFailed, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'value.txt'), 'utf8'), 'after');
});
test('post-operation checkpoint loss is a recovery warning, not a failed or repeated command', async () => {
  const root = path.join(directory, 'post-failure'); fs.mkdirSync(root);
  const finalize = recovery.finalizeBoundaryCheckpoint;
  recovery.finalizeBoundaryCheckpoint = async () => { throw new Error('Unknown recovery checkpoint: 1.'); };
  let effects = 0;
  try {
    const result = await require('../src/main/recoveryBoundary').withShellRecovery({ root, toolName: 'execute_command' }, async () => {
      effects++; return { output: 'actual command output', exitCode: 0 };
    });
    assert.equal(result.exitCode, 0); assert.equal(result.output, 'actual command output');
    assert.equal(result.recoveryComplete, false); assert.equal(result.recoveryPostFailed, true);
    assert.match(result.recoveryWarning, /operation ran.*Unknown recovery checkpoint.*Do not rerun/);
    assert.equal(effects, 1);
  } finally { recovery.finalizeBoundaryCheckpoint = finalize; }
});

test('automatic maintenance timer cannot inherit a capture workflow and bypass its lock', async () => {
  await delay(350); // Drain the preceding completed workflow's coalesced timer.
  const root = path.join(directory, 'inherited-timer'); fs.mkdirSync(root);
  const enforce = recovery.enforceRecoveryPolicy;
  let cleanupStarted = false, release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  recovery.enforceRecoveryPolicy = () => gate.exclusive(async () => { cleanupStarted = true; return { pruned: [] }; });
  try {
    const running = require('../src/main/recoveryBoundary').withShellRecovery({ root, toolName: 'execute_command' }, async () => {
      entered(); await held; return { exitCode: 0, output: 'done once' };
    });
    await started; await delay(400);
    assert.equal(cleanupStarted, false, 'timer must wait even though capture scheduled it');
    release(); const result = await running;
    assert.equal(result.exitCode, 0);
    const deadline = Date.now() + 2000;
    while (!cleanupStarted && Date.now() < deadline) await delay(20);
    assert.equal(cleanupStarted, true);
  } finally { release?.(); recovery.enforceRecoveryPolicy = enforce; }
});

test('a background recovery lease protects its checkpoint without blocking independent tools behind maintenance', async () => {
  const events = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const job = gate.background(async () => {
    events.push('background-start');
    await held;
    await gate.run(async () => events.push('background-post-state'));
  });
  await delay(0);
  const cleanup = gate.exclusive(async () => events.push('cleanup'));
  await gate.run(async () => events.push('independent-tool'));
  assert.deepEqual(events, ['background-start', 'independent-tool']);
  release(); await Promise.all([job, cleanup]);
  assert.deepEqual(events, ['background-start', 'independent-tool', 'background-post-state', 'cleanup']);
});
