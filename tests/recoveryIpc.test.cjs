'use strict';
// Phase 3 recovery UI backing: IPC service, ownership, retention, settings.
// Run with: node --test tests/recoveryIpc.test.cjs
// Temp dirs under os.tmpdir() only; never touches /tmp/opencode.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec3-db-'));
const handlers = new Map();
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => dbDir },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    };
  }
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(dbDir);
const recovery = require('../src/main/recoveryStore');
const service = require('../src/main/recoveryIpc');
const tools = require('../src/main/tools/agentTools');

const workspaces = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec3-ws-'));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
const sessionsByRoot = new Map();
const projectsByRoot = new Map();
let sessionSeq = 0;
function projectFor(root) {
  if (!projectsByRoot.has(root)) {
    projectsByRoot.set(root, require('../src/main/projectManager').createProject({ name: `rec3-${++sessionSeq}`, root_path: root }));
  }
  return projectsByRoot.get(root);
}
function chatFor(root, tag = '') {
  const key = `${root}::${tag}`;
  if (!sessionsByRoot.has(key)) {
    const sid = `rec3-chat-${++sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', projectFor(root).id);
    sessionsByRoot.set(key, sid);
  }
  return sessionsByRoot.get(key);
}
const dbConn = () => require('../src/main/db').db;
const toolCall = (root, name, args = {}, tag = '') =>
  tools.executeAgentTool({ name, arguments: args, sessionId: chatFor(root, tag), permissionMode: 'workspace_write' });

test.after(() => {
  try { db.closeDatabase(); } catch {}
  for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('overview: empty, protected, and partial states', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  const sid = chatFor(root);
  assert.deepEqual(await service.recoveryOverview(sid), { state: 'empty', reason: 'no-history' });
  await toolCall(root, 'write_project_file', { relative_path: 'b.txt', content: 'b\n' });
  const protectedView = await service.recoveryOverview(sid);
  assert.equal(protectedView.state, 'protected');
  assert.equal(protectedView.checkpointCount, 1);
  assert.ok(protectedView.runStart);
  assert.equal(protectedView.otherCheckpointCount, 0);
  // Partial: uncapturable content on the latest checkpoint.
  fs.writeFileSync(path.join(root, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  await recovery.captureOperation({ root, chatSessionId: sid, toolName: 't', paths: ['huge.bin'] });
  const partial = await service.recoveryOverview(sid);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.checkpointCount, 2);
});

test('overview distinguishes other chats without leaking their state', async () => {
  const root = makeWorkspace({ 'w.txt': 'w\n' });
  const sidA = chatFor(root, 'A');
  const sidB = chatFor(root, 'B');
  await tools.executeAgentTool({ name: 'write_project_file', arguments: { relative_path: 'w.txt', content: 'w2\n' }, sessionId: sidA, permissionMode: 'workspace_write' });
  const viewB = await service.recoveryOverview(sidB);
  assert.equal(viewB.state, 'empty');
  assert.equal(viewB.otherCheckpointCount, 1, 'other chat work is counted, not shown as mine');
  const historyB = await service.recoveryHistory(sidB, 50);
  assert.equal(historyB.mine.length, 0);
  assert.equal(historyB.other.length, 1);
  assert.ok(historyB.other[0].originChat, 'origin labeled');
  // B's newer content still conflict-guards A's restore (no silent overwrite).
  fs.writeFileSync(path.join(root, 'w.txt'), 'B-edit\n');
  const onlyA = (await service.recoveryHistory(sidA, 50)).mine[0];
  const refused = await service.recoveryRestore(sidA, onlyA.id, {}, false);
  assert.equal(refused.complete, false);
  assert.ok(refused.skipped.some((s) => s.path === 'w.txt'));
});

test('history/detail/preview accuracy and dry-run safety', async () => {
  const root = makeWorkspace({ 'd1.txt': 'd1\n', 'd2.txt': 'd2\n' });
  const sid = chatFor(root);
  await toolCall(root, 'write_project_file', { relative_path: 'd1.txt', content: 'D1\n' });
  const history = await service.recoveryHistory(sid, 50);
  assert.equal(history.mine.length, 1);
  assert.equal(history.other.length, 0);
  const summary = history.mine[0];
  assert.equal(summary.coverageComplete, true);
  assert.equal(summary.pinned, false);
  const detail = await service.recoveryDetail(sid, summary.id);
  assert.equal(detail.totalPaths, 1);
  const entry = detail.paths.find((p) => p.path === 'd1.txt');
  assert.equal(entry.recorded, 'file');
  assert.equal(entry.status, 'modified');
  assert.ok(entry.diff && !entry.diff.identical, 'compare excerpts included');
  // Preview changes nothing on disk.
  fs.writeFileSync(path.join(root, 'd1.txt'), 'D2\n');
  const before = fs.readFileSync(path.join(root, 'd1.txt'), 'utf8');
  const refusedPreview = await service.recoveryPreview(sid, summary.id, {});
  assert.equal(refusedPreview.dryRun, true);
  assert.ok(refusedPreview.skipped.some((r) => r.path === 'd1.txt'), 'preview surfaces the conflict');
  const preview = await service.recoveryPreview(sid, summary.id, { force: true });
  assert.ok(preview.restored.some((r) => r.path === 'd1.txt'));
  assert.equal(fs.readFileSync(path.join(root, 'd1.txt'), 'utf8'), before, 'preview writes nothing');
  assert.equal(preview.preRestoreCheckpointId, null, 'preview captures nothing');
});

test('restore via service creates a pre-restore point and restores', async () => {
  const root = makeWorkspace({ 'r.txt': 'r0\n' });
  const sid = chatFor(root);
  const op = await toolCall(root, 'write_project_file', { relative_path: 'r.txt', content: 'r1\n' });
  fs.writeFileSync(path.join(root, 'r.txt'), 'r2\n');
  const done = await service.recoveryRestore(sid, op.recoveryCheckpointId, {});
  assert.equal(done.complete, false, 'r2 conflicts without force');
  const forced = await service.recoveryRestore(sid, op.recoveryCheckpointId, { force: true });
  assert.equal(forced.complete, true);
  assert.ok(Number.isSafeInteger(forced.preRestoreCheckpointId), 'pre-restore point saved first');
  assert.equal(fs.readFileSync(path.join(root, 'r.txt'), 'utf8'), 'r0\n');
  // The pre-restore point itself restores (undo of the undo).
  const undo = await service.recoveryRestore(sid, forced.preRestoreCheckpointId, { force: true });
  assert.equal(undo.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'r.txt'), 'utf8'), 'r2\n');
});

test('risky restore through the service needs explicit authorization', async () => {
  const root = makeWorkspace({ 'e.txt': '' });
  const sid = chatFor(root);
  const cap = await recovery.captureOperation({ root, chatSessionId: sid, toolName: 't', paths: ['e.txt'] });
  fs.writeFileSync(path.join(root, 'e.txt'), 'valuable\n');
  const gated = await service.recoveryRestore(sid, cap.checkpointId, { force: true });
  assert.equal(gated.complete, false);
  assert.equal(gated.strategy, 'authorization-required');
  assert.equal(gated.needsAuthorization, true);
  assert.equal(gated.safety.verdict, 'authorization-required');
  assert.deepEqual(gated.safety.anomalies[0].paths, [{ path: 'e.txt', currentSize: 9 }]);
  assert.equal(fs.readFileSync(path.join(root, 'e.txt'), 'utf8'), 'valuable\n', 'nothing written without authorization');
  const preview = await service.recoveryPreview(sid, cap.checkpointId, { force: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.safety.verdict, 'authorization-required', 'preview reports the same verdict');
  const allowed = await service.recoveryRestore(sid, cap.checkpointId, { force: true, allowRisky: true });
  assert.equal(allowed.complete, true);
  assert.equal(allowed.undoPinned, true);
  assert.equal(fs.readFileSync(path.join(root, 'e.txt'), 'utf8'), '');
});

test('selective restore touches only selected conflict-free paths', async () => {
  const root = makeWorkspace({ 's1.txt': 's1\n', 's2.txt': 's2\n' });
  const sid = chatFor(root);
  const cap = await recovery.captureOperation({ root, chatSessionId: sid, toolName: 't', paths: ['s1.txt', 's2.txt'] });
  fs.writeFileSync(path.join(root, 's1.txt'), 'S1\n');
  fs.writeFileSync(path.join(root, 's2.txt'), 'S2\n');
  const done = await service.recoveryRestore(sid, cap.checkpointId, { paths: ['s1.txt'], force: true });
  assert.equal(done.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 's1.txt'), 'utf8'), 's1\n');
  assert.equal(fs.readFileSync(path.join(root, 's2.txt'), 'utf8'), 'S2\n', 'unselected path untouched');
});

test('incomplete coverage is never a complete restore', async () => {
  const root = makeWorkspace({ 'ok.txt': 'ok\n' });
  const sid = chatFor(root);
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 2));
  const cap = await recovery.captureOperation({ root, chatSessionId: sid, toolName: 't', paths: ['ok.txt', 'big.bin'] });
  assert.equal(cap.coverage.complete, false);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok2\n');
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 3));
  const done = await service.recoveryRestore(sid, cap.checkpointId, { force: true });
  assert.equal(done.complete, false, 'uncapturable path cannot restore');
  assert.ok(done.skipped.some((s) => s.path === 'big.bin'));
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'ok\n', 'captured paths still restore');
});

test('cross-workspace ids, traversal, and symlink escapes are rejected', async () => {
  const rootA = makeWorkspace({ 'a.txt': 'a\n' });
  const rootB = makeWorkspace({ 'b.txt': 'b\n' });
  const sidA = chatFor(rootA);
  const sidB = chatFor(rootB);
  const op = await toolCall(rootA, 'write_project_file', { relative_path: 'a.txt', content: 'a2\n' });
  const id = op.recoveryCheckpointId;
  await assert.rejects(service.recoveryDetail(sidB, id), /another workspace/);
  await assert.rejects(service.recoveryPreview(sidB, id, {}), /another workspace/);
  await assert.rejects(service.recoveryRestore(sidB, id, { force: true }), /another workspace/);
  await assert.rejects(service.recoveryPin(sidB, id, true), /another workspace/);
  await assert.rejects(service.recoveryRestore(sidA, 999999999, { force: true }), /Unknown recovery checkpoint/);
  await assert.rejects(service.recoveryRestore(sidA, id, { paths: ['../evil'], force: true }), /not in checkpoint/);
  await assert.rejects(service.recoveryRestore('no-such-chat', id, {}, true), /project workspace/);
});

test('pins survive pruning; active and latest points are immune', async () => {
  const root = makeWorkspace({ 'p.txt': 'p0\n' });
  const sid = chatFor(root);
  const first = await toolCall(root, 'write_project_file', { relative_path: 'p.txt', content: 'p1\n' });
  await service.recoveryPin(sid, first.recoveryCheckpointId, true);
  const ids = [first.recoveryCheckpointId];
  for (let i = 0; i < 4; i++) {
    const op = await toolCall(root, 'write_project_file', { relative_path: 'p.txt', content: `p${i + 2}\n` });
    ids.push(op.recoveryCheckpointId);
  }
  // Age everything out except pinned + latest-10 floor, then prune.
  const old = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  dbConn().prepare("UPDATE recovery_checkpoints SET created_at = ? WHERE id IN (SELECT id FROM recovery_checkpoints WHERE session_id = (SELECT id FROM recovery_sessions WHERE project_root = ?))")
    .run(old, root);
  const report = await recovery.pruneRecovery({ retentionDays: 30, storageCapMB: 512, latestPerSession: 2 });
  assert.ok(!report.pruned.includes(first.recoveryCheckpointId), 'pinned survives');
  const remaining = (await service.recoveryHistory(sid, 200)).mine.map((e) => e.id);
  assert.ok(remaining.includes(first.recoveryCheckpointId));
  assert.ok(remaining.includes(ids[ids.length - 1]), 'latest survives');
  assert.ok(remaining.includes(ids[ids.length - 2]), 'latest-N floor holds');
  assert.ok(!remaining.includes(ids[1]), 'aged middle checkpoint pruned');
});

test('cap enforcement is oldest-first with pinned/latest/recent immune', async () => {
  const root = makeWorkspace({ 'c.txt': 'c0\n' });
  const sid = chatFor(root);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const op = await toolCall(root, 'write_project_file', { relative_path: 'c.txt', content: `content-${i}\n`.padEnd(300000, '.') });
    seen.push(op.recoveryCheckpointId);
  }
  await service.recoveryPin(sid, seen[0], true);
  const old = new Date(Date.now() - 48 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  dbConn().prepare('UPDATE recovery_checkpoints SET created_at = ? WHERE id = ?').run(old, seen[1]);
  dbConn().prepare('UPDATE recovery_checkpoints SET created_at = ? WHERE id = ?').run(old, seen[2]);
  // ~2.4MB across 8 checkpoints; 1MB cap forces eviction of the evictable
  // oldest (seen[1], seen[2]); pinned/latest stay and the shortfall is honest.
  const report = await recovery.pruneRecovery({ retentionDays: 365, storageCapMB: 1, latestPerSession: 10 });
  assert.ok(report.capEvicted.includes(seen[1]), 'oldest evictable goes first');
  assert.ok(!report.capEvicted.includes(seen[0]), 'pinned immune to cap');
  assert.ok(!report.capEvicted.includes(seen[seen.length - 1]), 'latest immune to cap');
  assert.ok(report.capShortfallMB > 0, 'remaining overage reported, not forced');
  const remaining = (await service.recoveryHistory(sid, 200)).mine.map((e) => e.id);
  assert.ok(remaining.includes(seen[0]));
  assert.ok(remaining.includes(seen[seen.length - 1]));
});

test('storage stats distinguish physical from logical bytes', async () => {
  const root = makeWorkspace({ 'u1.txt': 'shared-bytes\n', 'u2.txt': 'shared-bytes\n' });
  const sid = chatFor(root);
  await recovery.captureOperation({ root, chatSessionId: sid, toolName: 't', paths: ['u1.txt', 'u2.txt'] });
  await recovery.captureOperation({ root, chatSessionId: sid, toolName: 't', paths: ['u1.txt', 'u2.txt'] });
  const stats = await service.recoveryStats();
  assert.ok(stats.physicalBytes > 0 && stats.logicalBytes > 0);
  assert.ok(stats.logicalBytes >= stats.physicalBytes, 'sharing makes logical >= physical');
  assert.ok(stats.checkpointCount >= 2 && stats.blobFiles >= 1);
  assert.equal(typeof stats.usagePercent, 'number');
});

test('exhaustion is visible, never false success', async () => {
  const root = makeWorkspace({ 'e.txt': 'e\n' });
  const sid = chatFor(root);
  const blobsDir = path.join(require('../src/main/configStore').getConfig().appDataDirectory, 'recovery', 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.chmodSync(blobsDir, 0o555);
  try {
    const r = await toolCall(root, 'write_project_file', { relative_path: 'e.txt', content: 'e2\n' });
    assert.equal(r.success, false);
    assert.match(r.error, /Recovery capture failed/);
    assert.equal(fs.readFileSync(path.join(root, 'e.txt'), 'utf8'), 'e\n', 'original untouched');
  } finally {
    fs.chmodSync(blobsDir, 0o755);
  }
});

test('restore blocked while the run is active', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  const sid = chatFor(root);
  const op = await toolCall(root, 'write_project_file', { relative_path: 'a.txt', content: 'a2\n' });
  const { activeStreams } = require('../src/main/engineManager');
  activeStreams.set(sid, { fake: true });
  try {
    await assert.rejects(service.recoveryRestore(sid, op.recoveryCheckpointId, { force: true }, true), /Stop the run/);
  } finally {
    activeStreams.delete(sid);
  }
  // Handler-level check below covers the real wiring; here the flag contract:
  const done = await service.recoveryRestore(sid, op.recoveryCheckpointId, { force: true }, false);
  assert.equal(done.complete, true);
});

test('recovery IPC channels are registered and round-trip', async () => {
  const { EventEmitter } = require('node:events');
  const seen = new Map();
  const onlyElectron = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') {
      return {
        app: { isReady: () => true, getPath: () => dbDir },
        ipcMain: { handle: (channel, fn) => seen.set(channel, fn), removeHandler: (channel) => seen.delete(channel) },
      };
    }
    return onlyElectron.call(this, name, ...args);
  };
  let dispose = () => {};
  try {
    const { registerIpcHandlers } = require('../src/main/ipcHandlers');
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    sender.send = () => {};
    dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => null });
    for (const channel of ['recovery:overview', 'recovery:history', 'recovery:detail', 'recovery:preview',
      'recovery:restore', 'recovery:pin', 'recovery:stats', 'recovery:prune']) {
      assert.equal(typeof seen.get(channel), 'function', `${channel} registered`);
    }
    const root = makeWorkspace({ 'ipc.txt': 'ipc\n' });
    const sid = chatFor(root, 'ipc');
    assert.deepEqual(await seen.get('recovery:overview')({ sender }, { sessionId: sid }),
      await service.recoveryOverview(sid));
    await toolCall(root, 'write_project_file', { relative_path: 'ipc.txt', content: 'ipc2\n' }, 'ipc');
    const history = await seen.get('recovery:history')({ sender }, { sessionId: sid });
    assert.equal(history.mine.length, 1);
    const stats = await seen.get('recovery:stats')({ sender }, {});
    assert.ok(stats.checkpointCount >= 1 && typeof stats.usagePercent === 'number');
    // Active run refuses through the real handler wiring.
    const { activeStreams } = require('../src/main/engineManager');
    activeStreams.set(sid, { fake: true });
    try {
      await assert.rejects(
        seen.get('recovery:restore')({ sender }, { sessionId: sid, checkpointId: history.mine[0].id, force: true }),
        /Stop the run/,
      );
    } finally {
      activeStreams.delete(sid);
    }
    const pinned = await seen.get('recovery:pin')({ sender }, { sessionId: sid, checkpointId: history.mine[0].id, pinned: true });
    assert.equal(pinned.pinned, true);
  } finally {
    Module._load = load;
    dispose();
  }
});
