'use strict';
// Phase 2 workspace recovery: shell/MCP boundaries, scans, coverage honesty.
// Run with: node --test tests/recoveryBoundary.test.cjs
// Temp dirs under os.tmpdir() only; never touches /tmp/opencode. No network,
// no live model inference. Shell e2e uses full_access raw exec in temp dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec2-db-'));
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

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const workspaces = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec2-ws-'));
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
function shellCall(root, command, cwd = '.') {
  let sid = sessionsByRoot.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: `rec2-${++sessionSeq}`, root_path: root });
    sid = `rec2-chat-${sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessionsByRoot.set(root, sid);
  }
  return tools.executeAgentTool({ name: 'execute_command', arguments: { command, cwd }, sessionId: sid, permissionMode: 'full_access' });
}
async function checkpointsFor(root) {
  return recovery.listCheckpoints(await recovery.getOrCreateRecoverySession(root));
}
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });

test.after(() => {
  try { db.closeDatabase(); } catch {}
  for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('1. shell creates absent file; restore removes it', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  const r = await shellCall(root, 'echo created > new.txt && cat a.txt');
  assert.equal(r.exitCode, 0);
  assert.ok(Number.isSafeInteger(r.recoveryCheckpointId));
  assert.ok(r.recoveryChangedTotal >= 1);
  assert.ok(r.recoveryChanged.some((e) => e.startsWith('new.txt (created')));
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a\n');
});

test('2. shell overwrites; original bytes recover', async () => {
  const root = makeWorkspace({ 'v.txt': 'original-bytes\n' });
  const r = await shellCall(root, 'echo mangled > v.txt');
  assert.ok(r.recoveryChanged.some((e) => e.startsWith('v.txt (modified')));
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'v.txt'), 'utf8'), 'original-bytes\n');
});

test('3. shell deletes; original bytes recover', async () => {
  const root = makeWorkspace({ 'gone.txt': 'gone-bytes\n', 'stay.txt': 'stay\n' });
  const r = await shellCall(root, 'rm gone.txt');
  assert.ok(r.recoveryChanged.some((e) => e.startsWith('gone.txt (deleted')));
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'gone-bytes\n');
});

test('4. shell multi-file nested changes all recover', async () => {
  const root = makeWorkspace({ 'd1/f1.txt': 'f1\n', 'd1/nest/f2.txt': 'f2\n', 'top.txt': 'top\n' });
  const r = await shellCall(root, 'echo x >> d1/f1.txt && echo y > d1/nest/f2.txt && rm top.txt && mkdir -p newdir && echo z > newdir/z.txt');
  const names = r.recoveryChanged.join('\n');
  for (const n of ['d1/f1.txt (modified', 'd1/nest/f2.txt (modified', 'top.txt (deleted', 'newdir/z.txt (created']) {
    assert.ok(names.includes(n), n);
  }
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'd1/f1.txt'), 'utf8'), 'f1\n');
  assert.equal(fs.readFileSync(path.join(root, 'top.txt'), 'utf8'), 'top\n');
  assert.equal(fs.existsSync(path.join(root, 'newdir')), false);
});

test('5. shell rename pairs as rename; both ends restore', async () => {
  const root = makeWorkspace({ 'old.txt': 'payload\n' });
  const r = await shellCall(root, 'mv old.txt new.txt');
  assert.ok(r.recoveryChanged.some((e) => e.includes('(renamed from old.txt)')), JSON.stringify(r.recoveryChanged));
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'payload\n');
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
});

test('6. read-only native calls create no snapshots', async () => {
  const root = makeWorkspace({ 'r.txt': 'read\n' });
  const n0 = (await checkpointsFor(root)).length;
  let sid = sessionsByRoot.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: 'rec2-ro', root_path: root });
    sid = 'rec2-ro-chat';
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessionsByRoot.set(root, sid);
  }
  const run = (name, args) => tools.executeAgentTool({ name, arguments: args, sessionId: sid, permissionMode: 'read_only', rootPath: root });
  await run('read_project_file', { relative_path: 'r.txt' });
  await run('list_directory', { relative_path: '.' });
  await run('search_project_content', { query: 'read' });
  await run('git_status', {});
  assert.equal((await checkpointsFor(root)).length, n0, 'reads must not snapshot');
});

test('7. native tools keep precise capture, no full scans', async () => {
  const root = makeWorkspace({ 't.txt': 't0\n', 'other.txt': 'o\n' });
  const r = await (async () => {
    let sid = sessionsByRoot.get(root);
    if (!sid) {
      const project = require('../src/main/projectManager').createProject({ name: 'rec2-nat', root_path: root });
      sid = 'rec2-nat-chat';
      require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
      sessionsByRoot.set(root, sid);
    }
    return tools.executeAgentTool({ name: 'write_project_file', arguments: { relative_path: 't.txt', content: 't1\n' }, sessionId: sid, permissionMode: 'workspace_write' });
  })();
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.deepEqual(Object.keys(cp.manifest.paths), ['t.txt'], 'only the target is captured');
  assert.equal(cp.kind, 'op');
});

test('8. pre-capture failure blocks the command unlaunched', async () => {
  const root = makeWorkspace({ 'p.txt': 'p\n' });
  const n0 = (await checkpointsFor(root)).length;
  // Break blob publication (not the workspace): scans cannot persist state.
  const blobsDir = path.join(require('../src/main/configStore').getConfig().appDataDirectory, 'recovery', 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.chmodSync(blobsDir, 0o555);
  let r;
  try {
    r = await shellCall(root, 'touch LAUNCHED && echo hi');
  } finally {
    fs.chmodSync(blobsDir, 0o755);
  }
  assert.equal(r.success, false);
  assert.match(r.error, /Recovery capture failed/);
  assert.equal(fs.existsSync(path.join(root, 'LAUNCHED')), false, 'command never launched');
  assert.equal((await checkpointsFor(root)).length, n0, 'no checkpoint row for blocked op');
});

test('9. failing command retains a valid recovery point', async () => {
  const root = makeWorkspace({ 'f.txt': 'before\n' });
  const r = await shellCall(root, 'echo after > f.txt && exit 3');
  assert.equal(r.exitCode, 3, 'real failure passes through, no auto-restore');
  assert.ok(Number.isSafeInteger(r.recoveryCheckpointId));
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'after\n', 'failed effects stand until restore');
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'before\n');
});

test('10a. deleted workspace root: post-scan fails, pre-state restores', async () => {
  const root = makeWorkspace({ 'w.txt': 'w\n', 'sub/v.txt': 'v\n' });
  const r = await boundary.withShellRecovery({ root, toolName: 'execute_command' },
    async () => { fs.rmSync(root, { recursive: true, force: true }); return { stdout: '', stderr: '', exitCode: 0 }; });
  assert.equal(fs.existsSync(root), false);
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.ok(typeof cp.op.postFailed === 'string' && cp.op.postFailed.length > 0, 'post failure recorded, pre-state kept');
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'w.txt'), 'utf8'), 'w\n');
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'v.txt'), 'utf8'), 'v\n');
});

test('10b. unreadable subdir: partial post-scan, pre-state still restores', async () => {
  const root = makeWorkspace({ 'ok.txt': 'ok0\n', 'dark/h.txt': 'h\n' });
  const dark = path.join(root, 'dark');
  const r = await boundary.withShellRecovery({ root, toolName: 'execute_command' }, async () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok1\n');
    fs.chmodSync(dark, 0o000);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  fs.chmodSync(dark, 0o755);
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.equal(cp.op.postComplete, false, 'partial post-scan disclosed');
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'ok0\n');
});

test('11. coverage honesty: too_large, unreadable, volatile, excluded', async () => {
  const root = makeWorkspace({ 'small.txt': 's\n' });
  fs.writeFileSync(path.join(root, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 9));
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'h.txt'), 'h\n');
  fs.chmodSync(locked, 0o000);
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep\n');
  let scan;
  try {
    scan = await recovery.scanWorkspaceState(root);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  const reasons = Object.fromEntries(scan.coverage.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons['huge.bin'], 'too_large');
  assert.ok(scan.coverage.skipped.some((s) => s.reason === 'unreadable'), JSON.stringify(scan.coverage.skipped));
  assert.ok(scan.coverage.excluded.some((e) => e.path === 'node_modules'), JSON.stringify(scan.coverage.excluded));
  assert.equal(scan.coverage.complete, false);
  // Unreadable is recorded uncaptured, never absent: a failed read is not
  // proof the file was missing, and restore must refuse rather than delete.
  assert.equal(scan.manifest.paths[path.join('locked', 'h.txt')]?.kind, undefined, 'no record without a read');
  assert.ok(scan.coverage.skipped.some((s) => s.path === 'locked' && s.reason === 'unreadable'));
  assert.equal(scan.manifest.paths['locked']?.kind, 'uncaptured', 'unlistable dir is uncaptured, not a clean dir record');
  // Freshly written file is flagged volatile rather than assumed settled.
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh\n');
  const scan2 = await recovery.scanWorkspaceState(root);
  assert.ok(scan2.coverage.volatile.includes('fresh.txt'), JSON.stringify(scan2.coverage.volatile));
});

test('12. external writer lands after post-scan; next boundary sees it', async () => {
  const root = makeWorkspace({ 'base.txt': 'b\n' });
  // Foreground tools now clean up their children. A separate workspace actor
  // can still change files after a post-scan; preserve that recovery coverage
  // without depending on an orphaned shell job escaping the command lifetime.
  const r = await shellCall(root, 'echo go');
  assert.equal(r.exitCode, 0);
  assert.ok(!r.recoveryChanged.some((e) => e.startsWith('late.txt')), 'scan-time state honestly reported');
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(root, 'late.txt'), 'late\n');
  assert.equal(fs.readFileSync(path.join(root, 'late.txt'), 'utf8').trim(), 'late');
  const scan = await recovery.scanWorkspaceState(root);
  const diff = recovery.diffStates(recovery.getCheckpoint(r.recoveryCheckpointId).manifest.paths,
    Object.fromEntries(Object.entries(scan.manifest.paths).map(([k, v]) => [k, v])));
  assert.ok(diff.some((e) => e.path === 'late.txt' && e.change === 'created'), 'next boundary detects the late write');
  // Unknown-to-checkpoint paths are left alone by restore.
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(fs.existsSync(path.join(root, 'late.txt')), true);
  assert.ok(back.complete);
});

test('13. interruption after pre-commit still restores', async () => {
  const root = makeWorkspace({ 'i.txt': 'i0\n' });
  const scan = await recovery.scanWorkspaceState(root);
  const pre = await recovery.commitScanResult({ root, toolName: 'execute_command', kind: 'shell', op: { kind: 'shell' }, scan });
  fs.writeFileSync(path.join(root, 'i.txt'), 'i1\n');
  // No post-scan ever ran (simulated crash): pre-state alone restores.
  const back = await recovery.restoreCheckpoint(pre.checkpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'i.txt'), 'utf8'), 'i0\n');
});

test('14. post-restore conflicts are never silent', async () => {
  const root = makeWorkspace({ 'k.txt': 'k0\n' });
  const r = await shellCall(root, 'echo k1 > k.txt');
  fs.writeFileSync(path.join(root, 'k.txt'), 'user-edit\n');
  const refused = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { preRestore: false });
  assert.equal(refused.complete, false);
  assert.ok(refused.skipped.some((s) => s.path === 'k.txt' && s.reason === 'conflict'));
  assert.equal(fs.readFileSync(path.join(root, 'k.txt'), 'utf8'), 'user-edit\n');
  const forced = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(forced.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'k.txt'), 'utf8'), 'k0\n');
});

test('15. git index, branches, history untouched by boundaries', async () => {
  const root = makeWorkspace({ 'g.txt': 'g1\n' });
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'g.txt'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], root);
  const head = git(['rev-parse', 'HEAD'], root).trim();
  const r = await shellCall(root, 'echo g2 > g.txt && git status --porcelain=v1 --branch');
  assert.equal(r.exitCode, 0);
  const back = await recovery.restoreCheckpoint(r.recoveryCheckpointId, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(git(['rev-parse', 'HEAD'], root).trim(), head);
  assert.equal(git(['branch', '--show-current'], root).trim(), 'main');
  assert.equal(git(['stash', 'list'], root).trim(), '');
  assert.equal(git(['diff', '--cached', '--name-only'], root).trim(), '', 'index untouched');
  assert.equal(fs.existsSync(path.join(root, '.git', 'index.lock')), false);
  const cp = recovery.getCheckpoint(r.recoveryCheckpointId);
  assert.ok(!Object.keys(cp.manifest.paths).some((p) => p === '.git' || p.startsWith('.git/')), 'no git internals captured');
});

test('16. boundaries respect permissions; denied calls never scan', async () => {
  const root = makeWorkspace({ 's.txt': 's\n' });
  let sid = sessionsByRoot.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: 'rec2-perm', root_path: root });
    sid = 'rec2-perm-chat';
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    sessionsByRoot.set(root, sid);
  }
  const n0 = (await checkpointsFor(root)).length;
  const denied = await tools.executeAgentTool({ name: 'execute_command', arguments: { command: 'echo no' }, sessionId: sid, permissionMode: 'read_only' });
  assert.equal(denied.success, false);
  assert.equal((await checkpointsFor(root)).length, n0, 'denied shell leaves no checkpoint');
  // MCP discriminator: reads and non-workspace args skip; writes scan.
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'read_text_file', args: { path: 's.txt' }, root }), false);
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'list_directory', args: { path: '.' }, root }), false);
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'fetch_url', args: { url: 'https://example.com/x' }, root }), false);
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'query', args: { sql: 'select * from t' }, root }), false);
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'write_file', args: { path: 's.txt', content: 'x' }, root }), true);
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'custom_tool', args: { path: 'brand-new.txt' }, root }), true, 'created target still scans');
  assert.equal(await boundary.shouldScanMcpCall({ toolName: 'write_file', args: { path: 's.txt' }, root: null }), false, 'no workspace means nothing to capture');
});

test('17. MCP write-shaped call is bounded; result shape preserved', async () => {
  const root = makeWorkspace({ 'm.txt': 'm0\n' });
  const calls = [];
  const fakeMutate = async () => {
    calls.push(1);
    fs.writeFileSync(path.join(root, 'm.txt'), 'm1\n');
    fs.writeFileSync(path.join(root, 'mcp-new.txt'), 'new\n');
    return 'ok';
  };
  const n0 = (await checkpointsFor(root)).length;
  const out = await boundary.withMcpRecovery({
    root, chatSessionId: 'rec2-mcp', toolName: 'mcp:fs/write_file', opMeta: { server: 'fs' },
  }, fakeMutate);
  assert.equal(out, 'ok', 'string result passes through untouched');
  assert.equal(calls.length, 1, 'dispatched exactly once');
  assert.equal((await checkpointsFor(root)).length, n0 + 1);
  const cp = recovery.getCheckpoint((await checkpointsFor(root))[0].id);
  assert.equal(cp.kind, 'mcp');
  assert.ok((cp.op.changed || []).some((e) => e.path === 'm.txt' && e.change === 'modified'));
  assert.ok((cp.op.changed || []).some((e) => e.path === 'mcp-new.txt' && e.change === 'created'));
  const back = await recovery.restoreCheckpoint(cp.id, { force: true, preRestore: false });
  assert.equal(back.complete, true);
  assert.equal(fs.readFileSync(path.join(root, 'm.txt'), 'utf8'), 'm0\n');
  assert.equal(fs.existsSync(path.join(root, 'mcp-new.txt')), false);
});

test('18. repeated scans reuse blobs; warm scans skip rehashing', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const countFiles = () => {
    let n = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.name.includes('.tmp-')) n += 1;
      }
    };
    const base = path.join(require('../src/main/configStore').getConfig().appDataDirectory, 'recovery', 'blobs');
    if (fs.existsSync(base)) walk(base);
    return n;
  };
  const s1 = await recovery.scanWorkspaceState(root);
  await recovery.commitScanResult({ root, toolName: 't', kind: 'shell', op: { kind: 'shell' }, scan: s1 });
  const n1 = countFiles();
  const s2 = await recovery.scanWorkspaceState(root);
  await recovery.commitScanResult({ root, toolName: 't', kind: 'shell', op: { kind: 'shell' }, scan: s2 });
  assert.equal(countFiles(), n1, 'unchanged workspace adds no blobs');
  assert.ok(s2.stats.files >= 2);
});

test('19. large workspace scans within bounds with exact skips', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec2-big-'));
  workspaces.push(root);
  const N = 1500;
  for (let i = 0; i < N; i++) {
    const sub = path.join(root, `d${Math.floor(i / 150)}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f${i}.txt`), `content-${i}\n`.padEnd(2000, '.'));
  }
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, 'node_modules', 'dep', `m${i}.js`), 'module\n');
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 5));
  const t0 = Date.now();
  const cold = await recovery.scanWorkspaceState(root);
  const coldMs = Date.now() - t0;
  assert.equal(cold.coverage.complete, false, 'big.bin forces honest partial');
  assert.ok(cold.coverage.skipped.some((s) => s.path === 'big.bin' && s.reason === 'too_large'));
  assert.ok(cold.coverage.excluded.some((e) => e.path === 'node_modules')), 'deps excluded, listed';
  assert.ok(!Object.keys(cold.manifest.paths).some((p) => p.startsWith('node_modules/')), 'excluded subtree not walked');
  const t1 = Date.now();
  const warm = await recovery.scanWorkspaceState(root);
  const warmMs = Date.now() - t1;
  console.log(`    scan perf: ${cold.stats.files} files/${(cold.stats.bytes / 1048576).toFixed(1)}MiB cold=${coldMs}ms warm=${warmMs}ms`);
  assert.ok(warmMs <= Math.max(coldMs, 1000), `warm (${warmMs}ms) must not exceed cold (${coldMs}ms)`);
  assert.ok(coldMs < 120000, `cold scan completes within operational bounds (${coldMs}ms)`);
});
