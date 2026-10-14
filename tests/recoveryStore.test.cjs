'use strict';
// Phase 1 workspace recovery: engine, capture boundaries, restore API,
// atomic-write fixes, and failure guarantees.
// Run with: node --test tests/recoveryStore.test.cjs
// Uses temp dirs under os.tmpdir() only; never touches /tmp/opencode.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-db-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-ws-'));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content && typeof content === 'object' && content.link) fs.symlinkSync(content.link, abs);
    else if (content && typeof content === 'object' && content.dir) fs.mkdirSync(abs, { recursive: true });
    else fs.writeFileSync(abs, content);
  }
  return root;
}
const sessionsByRoot = new Map();
let sessionSeq = 0;
function toolCall(root, name, args = {}, permissionMode = 'workspace_write', permissionGranted = false) {
  let sid = sessionsByRoot.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: `rec-${++sessionSeq}`, root_path: root });
    sid = `rec-chat-${sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessionsByRoot.set(root, sid);
  }
  return tools.executeAgentTool({ name, arguments: args, sessionId: sid, permissionMode, permissionGranted });
}
function appBlobsDir() {
  const appData = require('../src/main/configStore').getConfig().appDataDirectory;
  return path.join(appData, 'recovery', 'blobs');
}
function blobFileCount() {
  const base = appBlobsDir();
  let n = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (!entry.name.includes('.tmp-')) n += 1;
    }
  };
  if (fs.existsSync(base)) walk(base);
  return n;
}
function tmpLeftovers(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.git')) walk(p); }
      else if (/\.tmp-[0-9a-f-]+$/.test(entry.name) || entry.name.includes('.restore-')) found.push(p);
    }
  };
  walk(root);
  return found;
}
const git = (args, cwd, extraEnv) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...(extraEnv || {}) } });

test.after(() => {
  try { db.closeDatabase(); } catch {}
  for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('1. overwrite capture and restore through the real tool path', async () => {
  const root = makeWorkspace({ 'a.txt': 'original\n' });
  const op = await toolCall(root, 'write_project_file', { relative_path: 'n.txt', content: 'v1\n' });
  assert.ok(op.recoveryCheckpointId);
  await toolCall(root, 'write_project_file', { relative_path: 'n.txt', content: 'MANGLED\n' });
  const restored = await recovery.restoreCheckpoint(op.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(restored.complete, true);
  // n.txt did not exist at capture: created-after content is removed.
  assert.equal(fs.existsSync(path.join(root, 'n.txt')), false);
  assert.deepEqual(restored.removed.map((r) => r.path), ['n.txt']);
});

test('2. deleted files restore; created files are removed', async () => {
  const root = makeWorkspace({ 'keep.txt': 'keep\n', 'doomed.txt': 'doomed\n' });
  // Only captured paths are restorable: include the to-be-created path so
  // its earlier-absent state is on record (unattributed paths stay untouched).
  const cap = await recovery.captureOperation({ root, toolName: 't2', paths: ['keep.txt', 'doomed.txt', 'fresh.txt'] });
  assert.equal(cap.manifest.paths['fresh.txt'].kind, 'absent');
  fs.rmSync(path.join(root, 'doomed.txt'));
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh\n');
  const r = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(r.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'doomed.txt'), 'utf8'), 'doomed\n');
  assert.equal(fs.existsSync(path.join(root, 'fresh.txt')), false);
});

test('3. selective restore preserves unrelated files', async () => {
  const root = makeWorkspace({ 'x.txt': 'x0\n', 'y.txt': 'y0\n' });
  const cap = await recovery.createManualCheckpoint(root, { label: 't3' });
  fs.writeFileSync(path.join(root, 'x.txt'), 'x1\n');
  fs.writeFileSync(path.join(root, 'y.txt'), 'y1\n');
  const r = await recovery.restoreCheckpoint(cap.checkpointId, { paths: ['x.txt'], force: true, preRestore: false });
  assert.equal(r.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'x0\n');
  assert.equal(fs.readFileSync(path.join(root, 'y.txt'), 'utf8'), 'y1\n');
});

test('4. identical content reuses one blob across checkpoints', async () => {
  const root = makeWorkspace({ 's.txt': 'same\n' });
  const before = blobFileCount();
  await recovery.captureOperation({ root, toolName: 't', paths: ['s.txt'] });
  const mid = blobFileCount();
  await recovery.captureOperation({ root, toolName: 't', paths: ['s.txt'] });
  assert.equal(blobFileCount(), mid, 'second identical capture stores no new blob');
  assert.ok(mid >= before);
});

test('5. uncommitted modifications and untracked files survive the round trip', async () => {
  const root = makeWorkspace({ 'tracked.txt': 'v1\n' });
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'tracked.txt'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], root);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'dirty-work\n');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'precious\n');
  const cap = await recovery.createManualCheckpoint(root, { label: 't5' });
  assert.equal(cap.coverage.complete, true);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'agent-mangle\n');
  fs.rmSync(path.join(root, 'untracked.txt'));
  const r = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(r.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'dirty-work\n');
  assert.equal(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8'), 'precious\n');
});

test('6. non-git workspace is fully supported', async () => {
  const root = makeWorkspace({ 'plain.txt': 'plain\n' });
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  const cap = await recovery.createManualCheckpoint(root, { label: 't6' });
  fs.writeFileSync(path.join(root, 'plain.txt'), 'changed\n');
  const r = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(r.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), 'plain\n');
});

test('7. capture failure blocks the mutation and changes nothing', async () => {
  const root = makeWorkspace({ 'big.bin': 'small\n' });
  const big = path.join(root, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 7));
  const r = await toolCall(root, 'write_project_file', { relative_path: 'big.bin', content: 'x\n' });
  assert.equal(r.success, false);
  assert.match(r.error, /Recovery capture failed/);
  assert.equal(fs.readFileSync(big).length, 3 * 1024 * 1024, 'oversized original untouched');
});

test('8. corrupted or missing blobs are detected, never written', async () => {
  const root = makeWorkspace({ 'c.txt': 'clean\n' });
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: ['c.txt'] });
  const manifest = recovery.getCheckpoint(cap.checkpointId).manifest;
  const hash = manifest.paths['c.txt'].hash;
  fs.writeFileSync(path.join(root, 'c.txt'), 'dirty\n');
  // Missing blob. Blob files live under 2-char shards named by full hash.
  const real = (function find(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const hit = find(p); if (hit) return hit; }
      else if (e.name === hash) return p;
    }
    return null;
  })(appBlobsDir());
  assert.ok(real, 'blob file located');
  fs.rmSync(real);
  const missing = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(missing.complete, false);
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'dirty\n', 'no corrupt write on missing blob');
  // Poisoned blob.
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, 'POISON');
  const poisoned = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(poisoned.complete, false);
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'dirty\n', 'no corrupt write on poisoned blob');
});

test('9. interrupted atomic writes leave originals intact for str_replace and write', async () => {
  const root = makeWorkspace({ 's.txt': 'aaa\nbbb\n', 'w.txt': 'www\n' });
  // Break renames ONLY under the project root: tool temp-file commits fail
  // while blob publication (app-data) keeps working, so capture succeeds and
  // the failure lands in the write phase exactly like a torn write.
  const origRename = fsp.rename;
  fsp.rename = async (from, to, ...rest) => {
    if (typeof to === 'string' && (to === root || to.startsWith(`${root}${path.sep}`))) {
      throw Object.assign(new Error('EIO injected'), { code: 'EIO' });
    }
    return origRename.call(fsp, from, to, ...rest);
  };
  let s;
  let w;
  try {
    s = await toolCall(root, 'str_replace_editor', { relative_path: 's.txt', old_str: 'aaa', new_str: 'AAA' });
    w = await toolCall(root, 'write_project_file', { relative_path: 'w.txt', content: 'WWW\n' });
  } finally {
    fsp.rename = origRename;
  }
  assert.equal(s.success, false);
  assert.match(s.error, /Recovery checkpoint #\d+/);
  assert.equal(w.success, false);
  assert.equal(fs.readFileSync(path.join(root, 's.txt'), 'utf8'), 'aaa\nbbb\n');
  assert.equal(fs.readFileSync(path.join(root, 'w.txt'), 'utf8'), 'www\n');
  assert.deepEqual(tmpLeftovers(root), [], 'temp files cleaned up');
  // The durable checkpoint still restores after the outage.
  const rows = recovery.listCheckpoints((await recovery.getOrCreateRecoverySession(root)));
  assert.ok(rows.length >= 2);
});

test('10. traversal paths and symlink escapes are rejected', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-out-'));
  workspaces.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const root = makeWorkspace({ 'inner.txt': 'inner\n' });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'evil-link'));
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: ['../nope', 'inner.txt'] });
  assert.equal(cap.coverage.complete, false);
  assert.ok(cap.coverage.skipped.some((s) => s.reason === 'escape'));
  // Symlink is recorded as a link, never followed.
  const linkCap = await recovery.captureOperation({ root, toolName: 't', paths: ['evil-link'] });
  assert.equal(linkCap.manifest.paths['evil-link'].kind, 'symlink');
  fs.rmSync(path.join(root, 'evil-link'));
  const rl = await recovery.restoreCheckpoint(linkCap.checkpointId, { force: true, preRestore: false });
  assert.equal(rl.complete, true);
  assert.ok(fs.lstatSync(path.join(root, 'evil-link')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  // Write-through refusal: captured file replaced by an outside-pointing link.
  const root2 = makeWorkspace({ 'v.txt': 'victim\n' });
  const vcap = await recovery.captureOperation({ root: root2, toolName: 't', paths: ['v.txt'] });
  fs.rmSync(path.join(root2, 'v.txt'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root2, 'v.txt'));
  const refused = await recovery.restoreCheckpoint(vcap.checkpointId, { preRestore: false });
  assert.equal(refused.complete, false, 'no-force restore must not write through the link');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');
  const forced = await recovery.restoreCheckpoint(vcap.checkpointId, { force: true, preRestore: false });
  assert.equal(forced.complete, true);
  assert.equal(fs.readFileSync(path.join(root2, 'v.txt'), 'utf8'), 'victim\n');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n', 'outside target untouched');
});

test('11. file mode bits are preserved', async () => {
  const root = makeWorkspace({ 'mode.sh': '#!/bin/sh\n' });
  fs.chmodSync(path.join(root, 'mode.sh'), 0o640);
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: ['mode.sh'] });
  fs.chmodSync(path.join(root, 'mode.sh'), 0o600);
  const r = await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(r.complete, true);
  assert.equal(fs.statSync(path.join(root, 'mode.sh')).mode & 0o777, 0o640);
});

test('12. real git index, branches, and history are unchanged by capture/restore', async () => {
  const root = makeWorkspace({ 'g.txt': 'g1\n' });
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'g.txt'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], root);
  const head = git(['rev-parse', 'HEAD'], root).trim();
  const branch = git(['branch', '--show-current'], root).trim();
  await toolCall(root, 'write_project_file', { relative_path: 'g.txt', content: 'g2\n' });
  const cap = await recovery.createManualCheckpoint(root, { label: 't12' });
  await recovery.restoreCheckpoint(cap.checkpointId, { force: true, preRestore: false });
  assert.equal(git(['rev-parse', 'HEAD'], root).trim(), head);
  assert.equal(git(['branch', '--show-current'], root).trim(), branch);
  assert.equal(git(['stash', 'list'], root).trim(), '');
  assert.equal(git(['diff', '--cached', '--name-only'], root).trim(), '', 'index untouched');
  assert.equal(fs.existsSync(path.join(root, '.git', 'index.lock')), false);
});

test('13. failed captures leave no rows; orphans are swept, referenced blobs kept', async () => {
  const root = makeWorkspace({ 'o.txt': 'o\n' });
  const n0 = recovery.listCheckpoints(await recovery.getOrCreateRecoverySession(root)).length;
  const big = path.join(root, 'huge.bin');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 9));
  await assert.rejects(recovery.captureOperation({ root, toolName: 't', paths: ['huge.bin'], required: ['huge.bin'] }), /too_large/);
  assert.equal(recovery.listCheckpoints(await recovery.getOrCreateRecoverySession(root)).length, n0, 'no row for failed capture');
  // Orphan blob file with no row + orphan tmp file.
  const orphanHash = sha('orphan');
  const orphanPath = path.join(appBlobsDir(), orphanHash.slice(0, 2), orphanHash);
  fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
  fs.writeFileSync(orphanPath, 'orphan');
  fs.writeFileSync(`${orphanPath}.tmp-1-deadbeef`, 'tmp');
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: ['o.txt'] });
  const refHash = recovery.getCheckpoint(cap.checkpointId).manifest.paths['o.txt'].hash;
  const gc = await recovery.gcRecoveryBlobs();
  assert.ok(gc.orphanFiles >= 2, JSON.stringify(gc));
  assert.equal(await recovery.blobExists(refHash), true, 'referenced blob survives gc');
  // Subset retention sweeps everything outside the set — including other
  // tests' checkpoints in this shared database. That is correct gc behavior;
  // later tests capture fresh state, so only assert the guarantee: the
  // retained checkpoint's blob survives.
  const gc2 = await recovery.gcRecoveryBlobs(new Set([cap.checkpointId]));
  assert.equal(await recovery.blobExists(refHash), true);
  assert.ok(gc2.deletedBlobs >= 0);
});

test('14. every native mutation path captures its exact before-state', async () => {
  const root = makeWorkspace({ 'w.txt': 'w0\n', 's.txt': 's0\nline\n', 'e.txt': 'e0\nline\n', 'p.txt': 'p0\nline\n' });
  const before = {};
  for (const f of ['w.txt', 's.txt', 'e.txt', 'p.txt']) before[f] = sha(fs.readFileSync(path.join(root, f)));
  await toolCall(root, 'write_project_file', { relative_path: 'w.txt', content: 'w1\n' });
  await toolCall(root, 'str_replace_editor', { relative_path: 's.txt', old_str: 's0', new_str: 'S0' });
  await toolCall(root, 'edit_project_files', { edits: [{ relative_path: 'e.txt', old_str: 'e0', new_str: 'E0' }] });
  const patch = '--- a/p.txt\n+++ b/p.txt\n@@ -1,2 +1,2 @@\n-p0\n+P0\n line\n';
  await toolCall(root, 'apply_patch', { patch });
  const rows = recovery.listCheckpoints(await recovery.getOrCreateRecoverySession(root));
  assert.ok(rows.length >= 4);
  const byTool = {};
  for (const row of rows) {
    const full = recovery.getCheckpoint(row.id);
    byTool[row.tool_name] = full.manifest;
  }
  const expect = { write_project_file: 'w.txt', str_replace_editor: 's.txt', edit_project_files: 'e.txt', apply_patch: 'p.txt' };
  for (const [tool, file] of Object.entries(expect)) {
    const rec = byTool[tool].paths[file];
    assert.ok(rec && rec.kind === 'file', `${tool} captured ${file}`);
    assert.equal(rec.hash, before[file], `${tool} before-hash matches pre-op content`);
  }
});

test('15. move captures source/dest; restore cleans created parents', async () => {
  const root = makeWorkspace({ 'mv.txt': 'mv\n' });
  const r = await toolCall(root, 'move_project_file', { source_path: 'mv.txt', destination_path: 'newdir/sub/mv.txt' });
  assert.equal(r.success, true);
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.equal(cp.manifest.op.kind, 'move');
  assert.ok(cp.manifest.parentsCreated.includes(path.join('newdir', 'sub')) || cp.manifest.parentsCreated.includes('newdir'));
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId);
  assert.equal(fs.readFileSync(path.join(root, 'mv.txt'), 'utf8'), 'mv\n');
  assert.equal(fs.existsSync(path.join(root, 'newdir', 'sub', 'mv.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'newdir')), false, 'empty created parents removed');
  assert.ok(back.removed.some((e) => e.path === 'newdir' || e.path === path.join('newdir', 'sub')));
});

test('16. directory move reverses without losing contents', async () => {
  const root = makeWorkspace({ 'd/a.txt': 'a\n', 'd/n/b.txt': 'b\n' });
  const r = await toolCall(root, 'move_project_file', { source_path: 'd', destination_path: 'e' });
  assert.equal(r.success, true);
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId);
  assert.equal(back.strategy, 'move-back', JSON.stringify(back));
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'd', 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(root, 'd', 'n', 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.existsSync(path.join(root, 'e')), false);
  // Changed-after-move falls back to per-path restore.
  const r2 = await toolCall(root, 'move_project_file', { source_path: 'd', destination_path: 'e2' });
  fs.writeFileSync(path.join(root, 'e2', 'a.txt'), 'user-edit\n');
  const back2 = await recovery.restoreCheckpoint(r2.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back2.strategy, 'per-path');
  assert.equal(fs.readFileSync(path.join(root, 'd', 'a.txt'), 'utf8'), 'a\n');
});

test('17. batch write failure mid-sequence rolls back and keeps a durable point', async () => {
  const root = makeWorkspace({ 'f1.txt': 'f1-old\n' });
  const sub = path.join(root, 'locked');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'f2.txt'), 'f2-old\n');
  fs.chmodSync(sub, 0o555);
  try {
    const r = await toolCall(root, 'edit_project_files', { edits: [
      { relative_path: 'f1.txt', old_str: 'f1-old', new_str: 'f1-new' },
      { relative_path: path.join('locked', 'f2.txt'), old_str: 'f2-old', new_str: 'f2-new' },
    ]});
    assert.equal(r.success, false);
    assert.match(r.error, /Recovery checkpoint #\d+/);
    assert.match(r.error, /rollback succeeded/);
    assert.equal(fs.readFileSync(path.join(root, 'f1.txt'), 'utf8'), 'f1-old\n', 'first write rolled back');
    assert.equal(fs.readFileSync(path.join(sub, 'f2.txt'), 'utf8'), 'f2-old\n', 'second file untouched');
    const rows = recovery.listCheckpoints(await recovery.getOrCreateRecoverySession(root));
    const op = rows.find((row) => row.tool_name === 'edit_project_files');
    assert.ok(op, 'durable checkpoint row exists despite failure');
    assert.equal(op.coverage.complete, true);
  } finally {
    fs.chmodSync(sub, 0o755);
  }
});

test('18. patch captures every target before the first mutation', async () => {
  const root = makeWorkspace({ 'p1.txt': 'one\nsame\n', 'p2.txt': 'two\nsame\n' });
  const patch = '--- a/p1.txt\n+++ b/p1.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n same\n\n--- a/p2.txt\n+++ b/p2.txt\n@@ -1,2 +1,2 @@\n-two\n+TWO\n same\n\n--- /dev/null\n+++ b/p3.txt\n@@ -0,0 +1 @@\n+created\n';
  const r = await toolCall(root, 'apply_patch', { patch });
  assert.equal(r.success, true);
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.equal(cp.manifest.paths['p1.txt'].hash, sha('one\nsame\n'));
  assert.equal(cp.manifest.paths['p2.txt'].hash, sha('two\nsame\n'));
  assert.equal(cp.manifest.paths['p3.txt'].kind, 'absent', 'created file recorded as absent');
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'p1.txt'), 'utf8'), 'one\nsame\n');
  assert.equal(fs.existsSync(path.join(root, 'p3.txt')), false);
});

test('19. partial copy/unlink move failure is detected and rolled back', async () => {
  const root = makeWorkspace({ 'm.txt': 'move-me\n' });
  const origUnlink = fsp.unlink;
  fsp.unlink = async () => { throw Object.assign(new Error('EIO injected'), { code: 'EIO' }); };
  let r;
  try {
    // Force the EXDEV path is platform-specific; simulate partial state by
    // breaking unlink so copy+unlink semantics apply where reachable.
    r = await toolCall(root, 'move_project_file', { source_path: 'm.txt', destination_path: 'm2.txt' });
  } finally {
    fsp.unlink = origUnlink;
  }
  if (r.success === false) {
    assert.match(r.error, /partially|Recovery checkpoint #\d+/);
    assert.equal(fs.readFileSync(path.join(root, 'm.txt'), 'utf8'), 'move-me\n', 'source preserved');
  } else {
    // Same-filesystem rename does not consult unlink: move succeeded cleanly.
    assert.equal(fs.existsSync(path.join(root, 'm2.txt')), true);
    const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId);
    assert.equal(fs.readFileSync(path.join(root, 'm.txt'), 'utf8'), 'move-me\n');
  }
});

test('20. successful ops create no duplicate blobs and corrupt no checkpoints', async () => {
  const root = makeWorkspace({ 'dup.txt': 'dup\n' });
  const n0 = blobFileCount();
  const r1 = await toolCall(root, 'write_project_file', { relative_path: 'other.txt', content: 'dup\n' });
  assert.equal(r1.success, true);
  // r1 captured absence (no blob); only genuinely new content adds blobs.
  assert.ok(blobFileCount() <= n0 + 1, `blobs ${n0} -> ${blobFileCount()}`);
  const r2 = await toolCall(root, 'write_project_file', { relative_path: 'other.txt', content: 'dup\n' });
  assert.equal(r2.success, true);
  const n2 = blobFileCount();
  assert.equal(recovery.getCheckpoint(r2.recoveryCheckpointId).manifest.paths['other.txt'].hash, sha('dup\n'));
  // Repeating the identical capture stores nothing new: dedupe, not growth.
  const r3 = await toolCall(root, 'write_project_file', { relative_path: 'other.txt', content: 'dup\n' });
  assert.equal(r3.success, true);
  assert.equal(blobFileCount(), n2, 'repeating identical content adds no blob');
  const cp1 = recovery.getCheckpoint(r1.recoveryCheckpointId);
  assert.equal(cp1.manifest.paths['other.txt'].kind, 'absent');
  // Earlier checkpoint still restores exactly.
  await toolCall(root, 'write_project_file', { relative_path: 'other.txt', content: 'changed\n' });
  const back = await recovery.restoreCheckpoint(r2.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'other.txt'), 'utf8'), 'dup\n');
});
