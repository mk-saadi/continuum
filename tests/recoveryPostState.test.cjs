'use strict';
// Post-operation-state conflict semantics: reverting an operation's own
// effects needs no force; genuinely later edits conflict unless forced.
// Run with: node --test tests/recoveryPostState.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec4-db-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => dbDir } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(dbDir);
const recovery = require('../src/main/recoveryStore');
const boundary = require('../src/main/recoveryBoundary');
const tools = require('../src/main/tools/agentTools');

const workspaces = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec4-ws-'));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
const sessionsByRoot = new Map();
let sessionSeq = 0;
function toolCall(root, name, args = {}) {
  let sid = sessionsByRoot.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: `rec4-${++sessionSeq}`, root_path: root });
    sid = `rec4-chat-${sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessionsByRoot.set(root, sid);
  }
  return tools.executeAgentTool({ name, arguments: args, sessionId: sid, permissionMode: 'workspace_write' });
}

test.after(() => {
  try { db.closeDatabase(); } catch {}
  for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('reverting the creating operation needs no force', async () => {
  const root = makeWorkspace({ 'f.txt': 'v0\n' });
  const op = await toolCall(root, 'write_project_file', { relative_path: 'f.txt', content: 'v1\n' });
  const r = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { preRestore: false });
  assert.equal(r.complete, true, JSON.stringify(r.skipped));
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'v0\n');
});

test('later user edits still conflict without force, yield with force', async () => {
  const root = makeWorkspace({ 'f.txt': 'v0\n' });
  const op = await toolCall(root, 'write_project_file', { relative_path: 'f.txt', content: 'v1\n' });
  fs.writeFileSync(path.join(root, 'f.txt'), 'user-edit\n');
  const refused = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { preRestore: false });
  assert.equal(refused.complete, false);
  assert.ok(refused.skipped.some((s) => s.path === 'f.txt' && s.reason === 'conflict'));
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'user-edit\n', 'user edit preserved');
  const forced = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(forced.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'v0\n');
});

test('shell checkpoint reverts without force; later edits conflict', async () => {
  const root = makeWorkspace({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
  const r = await boundary.withShellRecovery({ root, toolName: 't' }, async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
    fs.rmSync(path.join(root, 'b.txt'));
    return { exitCode: 0 };
  });
  const id = r.recoveryCheckpointId;
  const back = await recovery.restoreCheckpoint(id, { preRestore: false });
  assert.equal(back.complete, true, JSON.stringify(back.skipped));
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a0\n');
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  // Second cycle: op effect re-applied by hand, then a user edit on top.
  fs.writeFileSync(path.join(root, 'a.txt'), 'a1\n');
  const again = await recovery.restoreCheckpoint(id, { preRestore: false });
  assert.equal(again.complete, true, 'op-identical state reverts freely');
  fs.writeFileSync(path.join(root, 'a.txt'), 'user-edit\n');
  const conflicted = await recovery.restoreCheckpoint(id, { preRestore: false });
  assert.equal(conflicted.complete, false);
  assert.ok(conflicted.skipped.some((s) => s.reason === 'conflict'));
});

test('manual checkpoints stay conservative without post-state', async () => {
  const root = makeWorkspace({ 'm.txt': 'm0\n' });
  const cap = await recovery.createManualCheckpoint(root, { label: 'manual' });
  assert.equal(cap.manifest.op, null, 'manual capture records no operation');
  const stored = recovery.getCheckpoint(cap.checkpointId);
  assert.equal(stored.op, null);
  fs.writeFileSync(path.join(root, 'm.txt'), 'm1\n');
  const refused = await recovery.restoreCheckpoint(cap.checkpointId, { preRestore: false });
  assert.equal(refused.complete, false, 'unknown post-state stays strict');
  const forced = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(forced.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'm.txt'), 'utf8'), 'm0\n');
});

test('created files: untouched removed freely, edited conflict', async () => {
  const root = makeWorkspace({ 'k.txt': 'k\n' });
  const op = await toolCall(root, 'write_project_file', { relative_path: 'n.txt', content: 'n1\n' });
  const clean = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { preRestore: false });
  assert.equal(clean.complete, true);
  assert.equal(fs.existsSync(path.join(root, 'n.txt')), false);
  // Recreate identically (matches post-state) plus an edited twin.
  const op2 = await toolCall(root, 'write_project_file', { relative_path: 'n.txt', content: 'n1\n' });
  fs.writeFileSync(path.join(root, 'n.txt'), 'n-edited\n');
  const conflicted = await recovery.restoreCheckpoint(op2.recoveryCheckpointId, { preRestore: false });
  assert.equal(conflicted.complete, false);
  assert.ok(conflicted.skipped.some((s) => s.path === 'n.txt'));
  const forced = await recovery.restoreCheckpoint(op2.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(forced.complete, true);
  assert.equal(fs.existsSync(path.join(root, 'n.txt')), false);
});

test('moved tree reverts without force when untouched', async () => {
  const root = makeWorkspace({ 'd/a.txt': 'a\n' });
  const op = await toolCall(root, 'move_project_file', { source_path: 'd', destination_path: 'e' });
  const back = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { preRestore: false });
  assert.equal(back.complete, true, JSON.stringify(back.skipped));
  assert.equal(fs.readFileSync(path.join(root, 'd', 'a.txt'), 'utf8'), 'a\n');
});

test('preview distinguishes unchanged from would-restore', async () => {
  const root = makeWorkspace({ 'p.txt': 'p0\n', 'q.txt': 'q\n' });
  const op = await toolCall(root, 'write_project_file', { relative_path: 'p.txt', content: 'p1\n' });
  const full = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { dryRun: true });
  // Nothing changed since the op: everything matches post-state.
  const forcedPreview = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { dryRun: true, force: true });
  assert.equal(forcedPreview.complete, true);
  fs.writeFileSync(path.join(root, 'p.txt'), 'p-user\n');
  const preview = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { dryRun: true });
  assert.equal(preview.complete, false);
  assert.ok(preview.skipped.some((s) => s.path === 'p.txt' && s.reason === 'conflict'));
  assert.ok(preview.restored.every((r) => r.path !== 'p.txt'));
});

test('post snapshot never fails the operation; unknowns stay strict', async () => {
  const root = makeWorkspace({ 'z.txt': 'z\n' });
  const state = await recovery.snapshotCurrentState(root, ['z.txt', 'missing.txt', '../evil']);
  assert.equal(state['z.txt'].k, 'file');
  assert.ok(!('missing.txt' in state) || state['missing.txt'].k === 'absent');
  assert.ok(!('../evil' in state));
  await assert.rejects(recovery.recordOpPostState(999999999, {}), /Unknown recovery checkpoint/);
});
