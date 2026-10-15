'use strict';
// Phase 1 (perf) recovery-scan regressions: the scan-path optimizations must
// preserve every recovery guarantee. Deterministic fixtures only — no timing
// assertions (performance is proven by /tmp/rec-bench, not by unit tests).
// Run with: node --test tests/recoveryScanPerf.test.cjs
// Uses temp dirs under os.tmpdir() only; never touches /tmp/opencode.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recperf-db-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => dbDir } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(dbDir);
const recovery = require('../src/main/recoveryStore');
const boundary = require('../src/main/recoveryBoundary');

const workspaces = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recperf-ws-'));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
test.after(() => {
  try { db.closeDatabase(); } catch {}
  for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});
const fileHash = (manifest, rel) => manifest.paths[rel]?.hash;
async function commit(root, scan, toolName = 'test') {
  return recovery.commitScanResult({ root, chatSessionId: 'perf', toolName, kind: 'shell', op: { kind: 'shell' }, scan });
}

test('1. warm scan reuses the index; manifests stay byte-correct', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n', 'sub/b.txt': 'b\n' });
  const cold = await recovery.scanWorkspaceState(root);
  const before = recovery.loadWorkspaceIndex(root);
  assert.ok(before.size >= 2);
  const warm = await recovery.scanWorkspaceState(root);
  const after = recovery.loadWorkspaceIndex(root);
  assert.deepEqual([...after.entries()], [...before.entries()], 'unchanged warm scan leaves index rows identical');
  assert.deepEqual(warm.manifest.paths, cold.manifest.paths);
  assert.equal(warm.coverage.complete, true);
});

test('2. indexRecordsEqual unit cases', async () => {
  const eq = recovery.indexRecordsEqual;
  const idx = new Map([['f', { hash: 'h', size: 3, mtime_ms: 10, ctime_ms: 12 }]]);
  const rec = [{ kind: 'file', hash: 'h', size: 3, mode: 0o644, mtimeMs: 10, ctimeMs: 12 }];
  assert.equal(eq(idx, [['f', rec[0]]]), true);
  assert.equal(eq(idx, []), false, 'keyset shrink mismatches');
  assert.equal(eq(idx, [['f', rec[0]], ['g', rec[0]]]), false, 'keyset growth mismatches');
  assert.equal(eq(idx, [['f', { ...rec[0], size: 4 }]]), false);
  assert.equal(eq(idx, [['f', { ...rec[0], mtimeMs: 11 }]]), false);
  assert.equal(eq(idx, [['f', { ...rec[0], ctimeMs: 13 }]]), false);
  assert.equal(eq(idx, [['f', { ...rec[0], hash: 'x' }]]), false);
  assert.equal(eq(new Map([['f', { hash: 'h', size: 3, mtime_ms: 10, ctime_ms: null }]]), [['f', rec[0]]]), false,
    'pre-migration NULL ctime rows always miss (safe direction)');
});

test('3. same-size content change is detected and prior bytes restore', async () => {
  const root = makeWorkspace({ 'v.txt': 'AAAA\n' });
  const cp1 = await commit(root, await recovery.scanWorkspaceState(root));
  fs.writeFileSync(path.join(root, 'v.txt'), 'BBBB\n');
  const scan2 = await recovery.scanWorkspaceState(root);
  assert.notEqual(fileHash(scan2.manifest, 'v.txt'), fileHash(cp1.manifest, 'v.txt'));
  const changed = recovery.diffStates(cp1.manifest.paths, scan2.manifest.paths);
  assert.ok(changed.some((e) => e.path === 'v.txt' && e.change === 'modified'));
  const back = await recovery.restoreCheckpoint(cp1.checkpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'v.txt'), 'utf8'), 'AAAA\n');
});

test('4. mtime-preserved content change is detected via ctime and both states restore', async () => {
  const root = makeWorkspace({ 'v.txt': 'AAAA\n' });
  const abs = path.join(root, 'v.txt');
  const before = fs.statSync(abs);
  const cp1 = await commit(root, await recovery.scanWorkspaceState(root));
  fs.writeFileSync(abs, 'BBBB\n');
  // Preserve the original mtime exactly (size also unchanged): the old
  // (size, mtime) fast path would trust a stale entry here.
  fs.utimesSync(abs, before.atimeMs / 1000, before.mtimeMs / 1000);
  const after = fs.statSync(abs);
  assert.equal(Math.floor(after.mtimeMs), Math.floor(before.mtimeMs), 'test premise: mtime preserved');
  assert.notEqual(Math.floor(after.ctimeMs), Math.floor(before.ctimeMs), 'test premise: ctime bumped by the write');
  const scan2 = await recovery.scanWorkspaceState(root);
  assert.notEqual(fileHash(scan2.manifest, 'v.txt'), fileHash(cp1.manifest, 'v.txt'), 'ctime invalidates the stale index entry');
  const cp2 = await commit(root, scan2);
  const back1 = await recovery.restoreCheckpoint(cp1.checkpointId, { force: true, preRestore: false });
  assert.equal(back1.complete, true);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'AAAA\n');
  const back2 = await recovery.restoreCheckpoint(cp2.checkpointId, { force: true, preRestore: false });
  assert.equal(back2.complete, true);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'BBBB\n');
});

test('5. created/deleted files and dir create/rename/remove diff honestly', async () => {
  const root = makeWorkspace({ 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'dir/a.txt': 'a\n' });
  const pre = await recovery.scanWorkspaceState(root);
  fs.writeFileSync(path.join(root, 'new.txt'), 'n\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  fs.mkdirSync(path.join(root, 'newdir'));
  fs.writeFileSync(path.join(root, 'newdir', 'x.txt'), 'x\n');
  fs.renameSync(path.join(root, 'dir'), path.join(root, 'dir2'));
  const post = await recovery.scanWorkspaceState(root);
  const kinds = Object.fromEntries(recovery.diffStates(pre.manifest.paths, post.manifest.paths).map((e) => [e.path, e.change]));
  assert.equal(kinds['new.txt'], 'created');
  assert.equal(kinds['gone.txt'], 'deleted');
  assert.equal(kinds['newdir/x.txt'], 'created');
  assert.ok(kinds['dir2/a.txt'] === 'created' || kinds['dir2/a.txt'] === 'renamed');
  const cp = await commit(root, pre);
  await recovery.finalizeBoundaryCheckpoint(cp.checkpointId, {
    postPaths: post.manifest.paths, postSkipped: post.coverage.skipped,
    changed: recovery.diffStates(pre.manifest.paths, post.manifest.paths), truncated: post.truncated,
  });
  const stored = recovery.getCheckpoint(cp.checkpointId);
  assert.equal(stored.manifest.paths['new.txt']?.kind, 'absent', 'created paths gain absent records');
  const back = await recovery.restoreCheckpoint(cp.checkpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'g\n');
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'k\n');
});

test('6. finalize without creations leaves the stored manifest byte-identical', async () => {
  const root = makeWorkspace({ 'v.txt': 'v1\n' });
  const pre = await recovery.scanWorkspaceState(root);
  const cp = await commit(root, pre);
  const beforeRow = db.db.prepare('SELECT manifest_json FROM recovery_checkpoints WHERE id = ?').get(cp.checkpointId);
  fs.writeFileSync(path.join(root, 'v.txt'), 'v2\n');
  const post = await recovery.scanWorkspaceState(root);
  await recovery.finalizeBoundaryCheckpoint(cp.checkpointId, {
    postPaths: post.manifest.paths, postSkipped: post.coverage.skipped,
    changed: recovery.diffStates(pre.manifest.paths, post.manifest.paths), truncated: post.truncated,
  });
  const afterRow = db.db.prepare('SELECT manifest_json, op_json FROM recovery_checkpoints WHERE id = ?').get(cp.checkpointId);
  assert.equal(afterRow.manifest_json, beforeRow.manifest_json, 'modify-only boundary must not rewrite the manifest column');
  assert.ok(JSON.parse(afterRow.op_json).changed.some((e) => e.path === 'v.txt' && e.change === 'modified'));
});

test('7. unreadable, oversized, excluded, and changing files stay explicit', async () => {
  const root = makeWorkspace({ 'ok.txt': 'ok\n' });
  fs.writeFileSync(path.join(root, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'h.txt'), 'h\n');
  fs.chmodSync(locked, 0o000);
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'i.js'), 'i\n');
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh\n'); // young -> volatile
  let scan;
  try {
    scan = await recovery.scanWorkspaceState(root);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  const reasons = Object.fromEntries(scan.coverage.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons['huge.bin'], 'too_large');
  assert.equal(scan.manifest.paths['huge.bin']?.kind, 'uncaptured', 'oversized is uncaptured, never absent');
  assert.ok(scan.coverage.skipped.some((s) => s.reason === 'unreadable'));
  assert.ok(scan.coverage.excluded.some((e) => e.path === 'node_modules'));
  assert.equal(scan.manifest.paths['fresh.txt']?.volatile, true, 'changing/young files flagged volatile');
  assert.equal(scan.coverage.complete, false);
});

test('8. ancestor cache preserves symlink-escape rejection', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'recperf-out-'));
  workspaces.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const root = makeWorkspace({ 'a/ok/deep.txt': 'deep\n', 'a/other.txt': 'other\n' });
  fs.symlinkSync(outside, path.join(root, 'a', 'link'));
  // One capture shares the ancestor cache across a valid path (validates `a`)
  // and an escape through a symlinked dir: the escape must still be refused.
  const cap = await recovery.captureOperation({ root, toolName: 'test', kind: 'op', paths: ['a/ok/deep.txt', 'a/link/secret.txt'] });
  assert.equal(cap.manifest.paths['a/ok/deep.txt']?.kind, 'file');
  assert.ok(cap.coverage.skipped.some((s) => s.path === 'a/link/secret.txt' && s.reason === 'escape'),
    JSON.stringify(cap.coverage.skipped));
  // And on a required path the escape blocks the operation.
  await assert.rejects(
    recovery.captureOperation({ root, toolName: 'test', kind: 'op', paths: ['a/link/secret.txt'], required: ['a/link/secret.txt'] }),
    /Recovery capture incomplete/,
  );
  const scan = await recovery.scanWorkspaceState(root);
  assert.equal(scan.manifest.paths[path.join('a', 'link')]?.kind, 'symlink', 'link itself recorded, never followed');
  assert.ok(!Object.keys(scan.manifest.paths).some((p) => p.includes('secret.txt')), 'outside content never captured');
});

test('9. boundary pre-capture failure refuses without running the operation', async () => {
  let ran = false;
  await assert.rejects(
    boundary.withExternalRecovery(
      { root: path.join(os.tmpdir(), 'recperf-nope-missing'), toolName: 'execute_command', opKind: 'shell' },
      async () => { ran = true; return {}; },
    ),
    /Recovery capture failed; refusing/,
  );
  assert.equal(ran, false);
});

test('10. post-scan failure preserves a restorable pre-state', async () => {
  const root = makeWorkspace({ 'v.txt': 'v1\n' });
  const pre = await recovery.scanWorkspaceState(root);
  const cp = await commit(root, pre);
  await recovery.finalizeBoundaryCheckpoint(cp.checkpointId, { postFailed: 'boom (test)' });
  const stored = recovery.getCheckpoint(cp.checkpointId);
  assert.equal(stored.op.postComplete, false);
  assert.deepEqual(stored.manifest.paths, pre.manifest.paths);
  const back = await recovery.restoreCheckpoint(cp.checkpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'v.txt'), 'utf8'), 'v1\n');
});

test('11. batched blob rows keep crash-orphan healing semantics', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await recovery.scanWorkspaceState(root); // cold
  const warm = await recovery.scanWorkspaceState(root);
  const victim = warm.manifest.paths['a.txt'].hash;
  db.db.prepare('DELETE FROM recovery_blobs WHERE hash = ?').run(victim);
  const rescan = await recovery.scanWorkspaceState(root); // warm: fast path, no rehash
  await commit(root, rescan); // commit re-inserts every referenced hash
  const row = db.db.prepare('SELECT hash FROM recovery_blobs WHERE hash = ?').get(victim);
  assert.ok(row, 'fast-path commit must re-insert the healed row');
});

console.log('Scan-perf regressions: index reuse, same-size/mtime-preserved changes, boundary honesty, cache containment, and healing passed.');
