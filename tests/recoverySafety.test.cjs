'use strict';
// Zero-byte-aware recovery safeguards: anomaly detection, authorization-gated
// restores, rollback evidence preservation, and suspicious-checkpoint metadata.
// Run with: node --test tests/recoverySafety.test.cjs
// Uses temp dirs under os.tmpdir() only; never touches /tmp/opencode.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recsafe-db-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => dbDir } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(dbDir);
const recovery = require('../src/main/recoveryStore');
const tools = require('../src/main/tools/agentTools');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const workspaces = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recsafe-ws-'));
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
const sessionsByRoot = new Map();
let sessionSeq = 0;
function toolCall(root, name, args = {}) {
  let sid = sessionsByRoot.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: `recsafe-${++sessionSeq}`, root_path: root });
    sid = `recsafe-chat-${sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessionsByRoot.set(root, sid);
  }
  return tools.executeAgentTool({ name, arguments: args, sessionId: sid, permissionMode: 'workspace_write', permissionGranted: true });
}
const checkpointCount = async (root) =>
  recovery.listCheckpoints(await recovery.getOrCreateRecoverySession(root)).length;
// Capture a checkpoint over files that are currently empty, then fill them.
async function emptyCheckpointFilled(files) {
  const empties = Object.fromEntries(Object.keys(files).map((rel) => [rel, '']));
  const ws = makeWorkspace(empties);
  const { checkpointId } = await recovery.captureOperation({ root: ws, paths: Object.keys(files) });
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(ws, rel), content);
  return { root: ws, checkpointId };
}

test('empty blob hash export matches a real empty file', async () => {
  assert.equal(recovery.EMPTY_SHA256, sha(''));
  const root = makeWorkspace({ 'keep.txt': '' });
  const { checkpointId } = await recovery.captureOperation({ root, paths: ['keep.txt'] });
  const cp = recovery.getCheckpoint(checkpointId);
  assert.equal(cp.manifest.paths['keep.txt'].hash, recovery.EMPTY_SHA256);
  assert.equal(cp.manifest.paths['keep.txt'].size, 0);
});

test('empty blob over non-empty file needs authorization and writes nothing', async () => {
  const { root, checkpointId } = await emptyCheckpointFilled({ 'a.txt': 'content\n' });
  const before = await checkpointCount(root);
  const mtime = fs.statSync(path.join(root, 'a.txt')).mtimeMs;
  // Force mirrors an explicit user restore over changed files; the safety
  // gate still requires separate authorization for the emptying.
  const result = await recovery.restoreCheckpoint(checkpointId, { force: true });
  assert.equal(result.complete, false);
  assert.equal(result.strategy, 'authorization-required');
  assert.equal(result.needsAuthorization, true);
  assert.equal(result.safety.verdict, 'authorization-required');
  assert.equal(result.safety.filesWouldEmpty, 1);
  assert.deepEqual(result.safety.anomalies.map((entry) => entry.type), ['empty-over-nonempty']);
  assert.deepEqual(result.safety.anomalies[0].paths, [{ path: 'a.txt', currentSize: 8 }]);
  assert.equal(result.preRestoreCheckpointId, null, 'refused gate takes no snapshot');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'content\n');
  assert.equal(fs.statSync(path.join(root, 'a.txt')).mtimeMs, mtime);
  assert.equal(await checkpointCount(root), before, 'no pre-restore checkpoint on refusal');
});

test('legitimately empty files restore cleanly', async () => {
  // Empty recorded, current deleted after capture: fresh write of an empty
  // file is safe and needs no authorization.
  const root = makeWorkspace({ 'new.txt': '' });
  const { checkpointId } = await recovery.captureOperation({ root, paths: ['new.txt'] });
  fs.rmSync(path.join(root, 'new.txt'));
  const fresh = await recovery.restoreCheckpoint(checkpointId);
  assert.equal(fresh.complete, true);
  assert.equal(fresh.safety.verdict, 'safe');
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), '');
  // Empty recorded over empty current: unchanged.
  const again = await recovery.restoreCheckpoint(checkpointId);
  assert.equal(again.complete, true);
  assert.equal(again.safety.verdict, 'safe');
});

test('multi-file zero-byte anomaly escalates; degenerate checkpoints are refused', async () => {
  // Three empties among four records: authorization-required, not degenerate.
  const ws = makeWorkspace({ 'a.txt': '', 'b.txt': '', 'c.txt': '', 'd.txt': 'keep\n' });
  const { checkpointId } = await recovery.captureOperation({ root: ws, paths: ['a.txt', 'b.txt', 'c.txt', 'd.txt'] });
  for (const rel of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(ws, rel), `${rel} data\n`);
  const three = await recovery.restoreCheckpoint(checkpointId, { force: true });
  assert.equal(three.safety.verdict, 'authorization-required');
  assert.equal(three.safety.filesWouldEmpty, 3);
  assert.ok(three.safety.anomalies.some((entry) => entry.type === 'empty-over-nonempty'));
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'a.txt data\n', 'no writes without authorization');
  // Degenerate: every in-scope file record empty while current holds content.
  // Post-state is recorded (as an op revert would) so the actions are writes
  // even without force — the gate must still refuse.
  const all = makeWorkspace({ 'x.txt': '', 'y.txt': '', 'z.txt': '', 'w.txt': '' });
  const allRels = ['x.txt', 'y.txt', 'z.txt', 'w.txt'];
  const { checkpointId: allId } = await recovery.captureOperation({ root: all, paths: allRels });
  for (const rel of allRels) fs.writeFileSync(path.join(all, rel), `${rel} data\n`);
  await recovery.recordOpPostState(allId, await recovery.snapshotCurrentState(all, allRels));
  const deg = await recovery.restoreCheckpoint(allId, { force: true });
  assert.equal(deg.safety.verdict, 'refused');
  assert.ok(deg.safety.anomalies.some((entry) => entry.type === 'degenerate-checkpoint'));
  assert.equal(deg.strategy, 'refused');
  // allowRisky alone cannot override a refusal; allowRisky + force can.
  const stillRefused = await recovery.restoreCheckpoint(allId, { allowRisky: true });
  assert.equal(stillRefused.strategy, 'refused');
  assert.equal(fs.readFileSync(path.join(all, 'x.txt'), 'utf8'), 'x.txt data\n');
  const forced = await recovery.restoreCheckpoint(allId, { allowRisky: true, force: true });
  assert.equal(forced.complete, true);
  assert.equal(fs.readFileSync(path.join(all, 'x.txt'), 'utf8'), '');
});

test('explicitly authorized restoration succeeds and pins its undo snapshot', async () => {
  const { root, checkpointId } = await emptyCheckpointFilled({ 'a.txt': 'content\n' });
  const result = await recovery.restoreCheckpoint(checkpointId, { force: true, allowRisky: true });
  assert.equal(result.complete, true);
  assert.equal(result.safety.verdict, 'authorization-required');
  assert.equal(result.undoPinned, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '');
  const undo = recovery.getCheckpoint(result.preRestoreCheckpointId);
  assert.equal(undo.kind, 'pre-restore');
  const row = db.db.prepare('SELECT pinned FROM recovery_checkpoints WHERE id = ?').get(result.preRestoreCheckpointId);
  assert.equal(row.pinned, 1, 'pre-restore undo snapshot is pinned');
});

test('automatic rollback preserves a labelled pre-rollback snapshot', async () => {
  // Second edit targets a locked directory so the failure lands after capture.
  const root = makeWorkspace({ 'f1.txt': 'f1-old\n' });
  const sub = path.join(root, 'locked');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'f2.txt'), 'f2-old\n');
  fs.chmodSync(sub, 0o555);
  let r;
  try {
    r = await toolCall(root, 'edit_project_files', { edits: [
      { relative_path: 'f1.txt', old_str: 'f1-old', new_str: 'f1-new' },
      { relative_path: path.join('locked', 'f2.txt'), old_str: 'f2-old', new_str: 'f2-new' },
    ]});
  } finally {
    fs.chmodSync(sub, 0o755);
  }
  assert.equal(r.success, false);
  assert.match(r.error, /Recovery checkpoint #\d+/);
  assert.match(r.error, /rollback succeeded/);
  const undoMatch = /Pre-rollback snapshot: checkpoint #(\d+)\./.exec(r.error);
  assert.ok(undoMatch, 'error cites the pre-rollback snapshot');
  const undo = recovery.getCheckpoint(Number(undoMatch[1]));
  assert.equal(undo.kind, 'pre-rollback');
  // The snapshot preserves the partially mutated state (f1 already rewritten
  // when f2 failed), keeping the rollback itself undoable; the pre-op
  // checkpoint still holds the original content.
  assert.equal(undo.manifest.paths['f1.txt'].hash, sha('f1-new\n'));
  assert.equal(fs.readFileSync(path.join(root, 'f1.txt'), 'utf8'), 'f1-old\n', 'failed op left no trace');
});

test('rollback failure is reported once without recursion', async () => {
  const root = makeWorkspace({ 'f1.txt': 'f1-old\n' });
  const sub = path.join(root, 'locked');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'f2.txt'), 'f2-old\n');
  fs.chmodSync(sub, 0o555);
  const realRestore = recovery.restoreCheckpoint;
  let calls = 0;
  recovery.restoreCheckpoint = async (...args) => { calls++; throw new Error('injected restore failure'); };
  let r;
  try {
    r = await toolCall(root, 'edit_project_files', { edits: [
      { relative_path: 'f1.txt', old_str: 'f1-old', new_str: 'f1-new' },
      { relative_path: path.join('locked', 'f2.txt'), old_str: 'f2-old', new_str: 'f2-new' },
    ]});
  } finally {
    recovery.restoreCheckpoint = realRestore;
    fs.chmodSync(sub, 0o755);
  }
  assert.equal(r.success, false);
  assert.equal(calls, 1, 'rollback attempted exactly once');
  assert.match(r.error, /rollback failed: injected restore failure/);
});

test('capture records empty-file coverage; history surfaces it', async () => {
  const root = makeWorkspace({ 'keep.txt': '', 'a.txt': 'a\n' });
  const { checkpointId } = await recovery.captureOperation({ root, paths: ['keep.txt', 'a.txt'] });
  const cp = recovery.getCheckpoint(checkpointId);
  assert.deepEqual(cp.coverage.emptyFiles, ['keep.txt']);
  assert.equal(cp.coverage.allEmptyFiles, false);
  const all = makeWorkspace({ 'e1.txt': '', 'e2.txt': '' });
  const { checkpointId: allId } = await recovery.captureOperation({ root: all, paths: ['e1.txt', 'e2.txt'] });
  assert.equal(recovery.getCheckpoint(allId).coverage.allEmptyFiles, true);
  const sessionId = await recovery.getOrCreateRecoverySession(root);
  const rows = recovery.listCheckpoints(sessionId);
  assert.ok(rows.length >= 1);
});

test('normal restores and conflict checks are unaffected by the gate', async () => {
  const root = makeWorkspace({ 'n.txt': 'v1\n' });
  const r = await toolCall(root, 'str_replace_editor', { relative_path: 'n.txt', old_str: 'v1', new_str: 'v2' });
  assert.equal(r.success, true);
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(back.safety.verdict, 'safe');
  assert.equal(fs.readFileSync(path.join(root, 'n.txt'), 'utf8'), 'v1\n');
  // Manual checkpoint without post-state stays conservative on later edits.
  const { checkpointId } = await recovery.captureOperation({ root, paths: ['n.txt'] });
  fs.writeFileSync(path.join(root, 'n.txt'), 'v3\n');
  const conflicted = await recovery.restoreCheckpoint(checkpointId);
  assert.equal(conflicted.complete, false);
  assert.ok(conflicted.skipped.some((entry) => entry.reason === 'conflict'));
  assert.equal(fs.readFileSync(path.join(root, 'n.txt'), 'utf8'), 'v3\n');
});
