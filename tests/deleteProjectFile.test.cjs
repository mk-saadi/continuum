'use strict';
// Phase 1.6: delete_project_file — the native, permission-aware single-file
// deletion tool. Exercises the REAL tool-dispatch and permission/approval path
// (executeAgentTool + guardTool) over temp Git and non-Git workspaces, plus the
// recovery store's before-image capture and restore.
// Run with: node --test tests/deleteProjectFile.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// The database AND the recovery blob store live under the electron userData
// dir; point it at a throwaway temp dir so nothing touches a real profile.
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'del-db-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => appDir } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(appDir);
const { executeAgentTool, prepareFileDelete, agentTools } = require('../src/main/tools/agentTools');
const { capabilityOf, isToolVisible, guardTool, CAPABILITIES } = require('../src/main/toolPermissions');
const recovery = require('../src/main/recoveryStore');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });

const roots = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-ws-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content && typeof content === 'object' && content.$symlink) fs.symlinkSync(content.$symlink, abs);
    else if (content && typeof content === 'object' && content.$dir) fs.mkdirSync(abs, { recursive: true });
    else fs.writeFileSync(abs, content);
  }
  return root;
}
function makeRepo(files = {}) {
  const root = makeWorkspace(files);
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], root);
  return root;
}
const sessions = new Map();
let sessionSeq = 0;
function sessionFor(root) {
  let sid = sessions.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: `del-${++sessionSeq}`, root_path: root });
    sid = `del-chat-${sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessions.set(root, sid);
  }
  return sid;
}
// Full real path: permission guard prompts (handler returns true) -> fingerprint
// bound -> executor. Mirrors the IPC wiring where the user approves the card.
async function approve(root, args, mode = 'workspace_write') {
  return guardTool({ name: 'delete_project_file', args, project: { root_path: root },
    permissionMode: mode, requestApproval: async () => true });
}
async function approvedDelete(root, args, mode = 'workspace_write') {
  const approval = await approve(root, args, mode);
  return executeAgentTool({ name: 'delete_project_file', arguments: args, sessionId: sessionFor(root),
    permissionMode: mode, permissionGranted: true, approval });
}
// Ungranted call: the inner guard runs with no approval channel (the model
// cannot approve itself), exactly like a denied prompt.
async function unapproved(root, args, mode = 'workspace_write') {
  return executeAgentTool({ name: 'delete_project_file', arguments: args, sessionId: sessionFor(root), permissionMode: mode });
}

test.after(() => {
  try { db.closeDatabase(); } catch {}
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('capability: delete_project_file is a distinct FILE_DELETE, hidden read-only and without a workspace', () => {
  assert.equal(capabilityOf('delete_project_file'), CAPABILITIES.FILE_DELETE);
  assert.equal(CAPABILITIES.FILE_DELETE, 'file_delete');
  // Legacy delete_file keeps its own (WORKSPACE_WRITE) capability.
  assert.equal(capabilityOf('delete_file'), CAPABILITIES.WORKSPACE_WRITE);
  const project = { root_path: '/tmp/whatever' };
  assert.equal(isToolVisible('delete_project_file', { permissionMode: 'read_only', project }), false);
  assert.equal(isToolVisible('delete_project_file', { permissionMode: 'workspace_write', project }), true);
  assert.equal(isToolVisible('delete_project_file', { permissionMode: 'ask_approval', project }), true);
  assert.equal(isToolVisible('delete_project_file', { permissionMode: 'full_access', project }), true);
  // Full access does NOT invent a workspace: with nothing to delete into, the
  // tool stays hidden so visibility and execution agree.
  assert.equal(isToolVisible('delete_project_file', { permissionMode: 'full_access', project: null }), false);
  // Registered as a real schema entry requiring a path.
  const def = agentTools.find((t) => t.function.name === 'delete_project_file').function;
  assert.deepEqual(def.parameters.required, ['path']);
  assert.equal(typeof prepareFileDelete, 'function');
});

test('children gain nothing: delete_project_file is absent from the read-only child allowlist', async () => {
  assert.ok(!CHILD_TOOL_NAMES.includes('delete_project_file'));
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  // A child runs read_only with sessionId null (no project). Either way denied.
  const viaChild = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'a.txt' },
    sessionId: null, permissionMode: 'read_only', rootPath: root });
  assert.equal(viaChild.success, false);
  assert.equal(viaChild.outcome, 'permission_denied');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), true);
});

test('read_only mode never deletes', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  const r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'a.txt' },
    sessionId: sessionFor(root), permissionMode: 'read_only' });
  assert.equal(r.success, false);
  assert.equal(r.outcome, 'permission_denied');
  assert.match(r.error, /Read Only/);
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), true);
});

test('casual chat without a workspace is denied even in full access (no outside escape)', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'del-out-'));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'victim\n');
  try {
    const r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: path.join(outside, 'victim.txt') },
      sessionId: null, permissionMode: 'full_access' });
    assert.equal(r.success, false);
    assert.equal(r.outcome, 'permission_denied');
    assert.match(r.error, /requires a project workspace/);
    assert.equal(fs.existsSync(path.join(outside, 'victim.txt')), true);
  } finally {
    // root list cleanup handles it; nothing else to do.
  }
});

test('deletion always prompts outside full_access and a denied prompt blocks it', async () => {
  const root = makeWorkspace({ 'a.txt': 'hello\n' });
  for (const mode of ['workspace_write', 'ask_approval']) {
    let displayed;
    let requested = false;
    await assert.rejects(guardTool({ name: 'delete_project_file', args: { path: 'a.txt' },
      project: { root_path: root }, permissionMode: mode,
      requestApproval: async (payload) => { displayed = payload; requested = true; return false; } }), /approval denied/);
    assert.equal(requested, true, mode);
    // The approval payload names the exact operation, file, and size — never a
    // directory or an outside path.
    assert.equal(displayed.name, 'delete_project_file');
    assert.deepEqual(displayed.args, { operation: 'delete', path: 'a.txt', size: Buffer.byteLength('hello\n') });
    // An ungranted dispatch surfaces the denial as a typed outcome, file intact.
    const r = await unapproved(root, { path: 'a.txt' }, mode);
    assert.equal(r.success, false);
    assert.equal(r.outcome, 'approval_denied');
  }
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello\n');
});

test('approved deletion removes exactly one file and reports a truthful deleted outcome', async () => {
  const root = makeWorkspace({ 'keep.txt': 'keep\n', 'gone.txt': 'gone content\n' });
  const expected = sha256('gone content\n');
  const r = await approvedDelete(root, { path: 'gone.txt' });
  assert.equal(r.success, true);
  assert.equal(r.outcome, 'deleted');
  assert.equal(r.sha256, expected);
  assert.equal(typeof r.recoveryCheckpointId, 'number');
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'keep.txt')), true, 'only the named file is removed');
});

test('a missing file is reported not_found, never deleted', async () => {
  const root = makeWorkspace({ 'present.txt': 'present\n' });
  const r = await unapproved(root, { path: 'missing.txt' });
  assert.equal(r.success, false);
  assert.equal(r.outcome, 'not_found');
  assert.match(r.error, /does not exist/);
  assert.equal(fs.existsSync(path.join(root, 'present.txt')), true);
});

test('path shapes that are not one in-workspace regular file are rejected', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'del-out-'));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const root = makeWorkspace({
    'ok.txt': 'ok\n',
    'sub/inner.txt': 'inner\n',
    'inside-link': { $symlink: 'ok.txt' },
    'outside-link': { $symlink: path.join(outside, 'secret.txt') },
    'esc': { $symlink: outside },
    '.git/config': 'fake git config\n',
  });
  const cases = [
    ['/etc/passwd', 'invalid_path'],
    [path.join(outside, 'secret.txt'), 'invalid_path'],
    ['../secret.txt', 'invalid_path'],
    ['sub/../../secret.txt', 'invalid_path'],
    ['..\\secret.txt', 'invalid_path'],
    ['', 'invalid_path'],
    ['   ', 'invalid_path'],
    ['.', 'invalid_path'],
    ['./', 'invalid_path'],
    ['sub', 'not_a_file'],
    ['sub/inner.txt/', 'not_a_file'],
    ['inside-link', 'not_a_file'],
    // A symlink that escapes the workspace is a containment violation, caught
    // by the canonicalizing resolver before the file-type check.
    ['outside-link', 'invalid_path'],
    ['esc/secret.txt', 'invalid_path'],
    ['.git/config', 'invalid_path'],
    ['.git', 'invalid_path'],
  ];
  for (const [target, outcome] of cases) {
    const r = await unapproved(root, { path: target });
    assert.equal(r.success, false, JSON.stringify(target));
    assert.equal(r.outcome, outcome, `${target} -> ${r.outcome}: ${r.error}`);
  }
  // Nothing was deleted anywhere: the file, the directory, the symlinks, the
  // .git stand-in, and the outside target all survive.
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'ok\n');
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'inner.txt'), 'utf8'), 'inner\n');
  assert.ok(fs.lstatSync(path.join(root, 'inside-link')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(root, 'outside-link')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(root, 'esc')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), 'fake git config\n');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');
});

test('content changed between approval and execution is a conflict, file preserved', async () => {
  const root = makeWorkspace({ 'f.txt': 'approved v1\n' });
  const approval = await approve(root, { path: 'f.txt' });
  fs.writeFileSync(path.join(root, 'f.txt'), 'changed v2\n');
  const r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'f.txt' },
    sessionId: sessionFor(root), permissionMode: 'workspace_write', permissionGranted: true, approval });
  assert.equal(r.success, false);
  assert.equal(r.outcome, 'conflict');
  assert.match(r.error, /changed since approval/);
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'changed v2\n');
  // A fresh approval of the new bytes succeeds.
  const ok = await approvedDelete(root, { path: 'f.txt' });
  assert.equal(ok.outcome, 'deleted');
});

test('a change in the instant before unlink fails closed (TOCTOU re-check)', async () => {
  const root = makeWorkspace({ 'f.txt': 'original\n' });
  const approval = await approve(root, { path: 'f.txt' });
  const original = recovery.captureOperation;
  recovery.captureOperation = async function (opts) {
    const result = await original.call(recovery, opts);
    // Simulate a racing writer between the approved snapshot and the unlink.
    fs.writeFileSync(path.join(root, 'f.txt'), 'raced in\n');
    return result;
  };
  let r;
  try {
    r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'f.txt' },
      sessionId: sessionFor(root), permissionMode: 'workspace_write', permissionGranted: true, approval });
  } finally {
    recovery.captureOperation = original;
  }
  assert.equal(r.success, false);
  assert.equal(r.outcome, 'conflict');
  assert.match(r.error, /nothing was deleted/);
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'raced in\n', 'racing content wins; nothing deleted');
});

test('expected_hash precondition guards content identity', async () => {
  const root = makeWorkspace({ 'f.txt': 'exact bytes\n' });
  const good = sha256('exact bytes\n');
  const mismatch = await approvedDelete(root, { path: 'f.txt', expected_hash: sha256('different\n') });
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.outcome, 'conflict');
  assert.match(mismatch.error, /content changed/i);
  assert.equal(fs.existsSync(path.join(root, 'f.txt')), true);
  const badFormat = await approvedDelete(root, { path: 'f.txt', expected_hash: 'NOT-A-HASH' });
  assert.equal(badFormat.success, false);
  assert.equal(badFormat.outcome, 'invalid_path');
  const ok = await approvedDelete(root, { path: 'f.txt', expected_hash: good });
  assert.equal(ok.outcome, 'deleted');
  assert.equal(fs.existsSync(path.join(root, 'f.txt')), false);
});

test('deletion captures the exact before-image and restore recreates the content', async () => {
  const root = makeWorkspace({ 'keep.txt': 'keep\n', 'gone.txt': 'restore me exactly\n' });
  const before = sha256('restore me exactly\n');
  const r = await approvedDelete(root, { path: 'gone.txt' });
  assert.equal(r.outcome, 'deleted');
  // Durable checkpoint records the deletion op and the exact bytes captured.
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.equal(cp.manifest.op.kind, 'delete');
  assert.equal(cp.manifest.op.path, 'gone.txt');
  assert.equal(cp.manifest.paths['gone.txt'].kind, 'file');
  assert.equal(cp.manifest.paths['gone.txt'].hash, before);
  // It appears in the recovery history for the workspace.
  const recSession = await recovery.getOrCreateRecoverySession(root);
  const rows = recovery.listCheckpoints(recSession);
  assert.ok(rows.some((row) => row.tool_name === 'delete_project_file' && row.id === r.recoveryCheckpointId));
  // Restore recreates the file with identical content and mode.
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true, JSON.stringify(back));
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'restore me exactly\n');
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep\n');
});

test('a file beyond the recovery limit is blocked, not deleted unprotected', async () => {
  const root = makeWorkspace({ 'big.bin': 'seed\n' });
  const big = path.join(root, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 7));
  const r = await approvedDelete(root, { path: 'big.bin' });
  assert.equal(r.success, false);
  assert.equal(r.outcome, 'recovery_failed');
  assert.match(r.error, /Recovery capture failed/);
  assert.equal(fs.statSync(big).size, 3 * 1024 * 1024, 'oversized original untouched');
});

test('read_only children still cannot reach deletion through the executor', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  // Same shape the child loop uses (read_only, explicit rootPath, no grant).
  const r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'a.txt' },
    sessionId: null, permissionMode: 'read_only', rootPath: root });
  assert.equal(r.success, false);
  assert.equal(r.outcome, 'permission_denied');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), true);
});

test('full access deletes without a prompt but stays workspace-contained', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'del-out-'));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'victim\n');
  const root = makeWorkspace({ 'a.txt': 'a\n', 'inside-link': { $symlink: 'a.txt' } });
  const r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'a.txt' },
    sessionId: sessionFor(root), permissionMode: 'full_access' });
  assert.equal(r.success, true);
  assert.equal(r.outcome, 'deleted');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  // No outside-workspace escape: absolute, traversal, and symlink targets fail.
  for (const bad of [
    { path: path.join(outside, 'victim.txt') },
    { path: '../victim.txt' },
    { path: 'inside-link' },
  ]) {
    const blocked = await executeAgentTool({ name: 'delete_project_file', arguments: bad,
      sessionId: sessionFor(root), permissionMode: 'full_access' });
    assert.equal(blocked.success, false, JSON.stringify(bad));
    assert.ok(['invalid_path', 'not_a_file'].includes(blocked.outcome), blocked.outcome);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'victim\n');
  assert.ok(fs.lstatSync(path.join(root, 'inside-link')).isSymbolicLink());
});

test('cancellation before the irreversible step keeps the file; after it reports deleted', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  // Aborted up front: nothing may be unlinked.
  const approvalA = await approve(root, { path: 'a.txt' });
  const ac = new AbortController();
  ac.abort();
  const cancelled = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'a.txt' },
    sessionId: sessionFor(root), permissionMode: 'workspace_write', permissionGranted: true, approval: approvalA, signal: ac.signal });
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), true);

  // Abort fired during the unlink: the deletion stands and must be reported
  // truthfully as deleted rather than silently "cancelled".
  const approvalB = await approve(root, { path: 'b.txt' });
  const ac2 = new AbortController();
  const origUnlink = fsp.unlink;
  fsp.unlink = async function (p, ...rest) { ac2.abort(); return origUnlink.call(fsp, p, ...rest); };
  let r;
  try {
    r = await executeAgentTool({ name: 'delete_project_file', arguments: { path: 'b.txt' },
      sessionId: sessionFor(root), permissionMode: 'workspace_write', permissionGranted: true, approval: approvalB, signal: ac2.signal });
  } finally {
    fsp.unlink = origUnlink;
  }
  assert.equal(r.success, true);
  assert.equal(r.outcome, 'deleted');
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
});

test('tracked deletion surfaces in git status/diff with no auto stage or commit', async () => {
  const root = makeRepo({ 'tracked.txt': 'tracked\n' });
  const head = git(['rev-parse', 'HEAD'], root).trim();
  const r = await approvedDelete(root, { path: 'tracked.txt' });
  assert.equal(r.outcome, 'deleted');
  const porcelain = git(['status', '--porcelain=v1'], root);
  assert.match(porcelain, /D\s+tracked\.txt/);
  assert.match(git(['diff', '--name-only'], root), /tracked\.txt/);
  // The index and history are untouched: no implicit stage, commit, or reset.
  assert.equal(git(['diff', '--cached', '--name-only'], root).trim(), '');
  assert.equal(git(['rev-parse', 'HEAD'], root).trim(), head);
  assert.equal(git(['log', '--pretty=%s', '-n', '1'], root).trim(), 'init');
});

test('untracked files and non-Git workspaces delete through recovery', async () => {
  const repo = makeRepo({});
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
  const a = await approvedDelete(repo, { path: 'untracked.txt' });
  assert.equal(a.outcome, 'deleted');
  assert.equal(fs.existsSync(path.join(repo, 'untracked.txt')), false);

  const plain = makeWorkspace({ 'plain.txt': 'plain\n' });
  assert.equal(fs.existsSync(path.join(plain, '.git')), false);
  const b = await approvedDelete(plain, { path: 'plain.txt' });
  assert.equal(b.outcome, 'deleted');
  const back = await recovery.restoreCheckpoint(b.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(plain, 'plain.txt'), 'utf8'), 'plain\n');
});

test('work log / checkpoint integration classifies deletion as a file edit with an honest outcome', () => {
  const { classifyTool, buildTurnDigest } = require('../src/main/turnDigest');
  assert.equal(classifyTool('delete_project_file'), 'edit');
  const digest = buildTurnDigest([
    { type: 'tool_call', toolName: 'delete_project_file', args: { path: 'gone.txt' },
      result: { success: true, outcome: 'deleted' }, status: 'complete' },
  ], { turnSeq: 1 });
  assert.match(digest.text, /deleted/);
  assert.match(digest.text, /gone\.txt/);

  const { classifyStepOutcome } = require('../src/main/taskCheckpoints');
  const step = (result, status = 'complete') => ({ type: 'tool_call', toolName: 'delete_project_file', args: { path: 'gone.txt' }, result, status });
  assert.equal(classifyStepOutcome(step({ success: true, outcome: 'deleted' })), 'success');
  // A blocked deletion (guard/permission message) is a blocker, not a success.
  assert.equal(classifyStepOutcome(step({ success: false, error: 'Execution blocked: File deletion requires a project workspace.' }, 'error')), 'blocked');
  assert.equal(classifyStepOutcome(step({ success: false, error: 'Tool execution cancelled.' }, 'error')), 'cancelled');
});
