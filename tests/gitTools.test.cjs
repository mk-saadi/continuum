'use strict';
// Git tools: read-only inspection plus branch/stage/commit writes over real temp repos.
// Run with: node --test tests/gitTools.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawn } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tools-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(directory);
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { capabilityOf, isToolVisible, guardTool, CAPABILITIES } = require('../src/main/toolPermissions');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

const GIT_TOOLS = ['git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame'];
const GIT_WRITE_TOOLS = ['git_stage', 'git_unstage', 'git_stash', 'git_sync', 'git_commit', 'git_create_branch', 'git_switch'];
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-'));
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], root);
  return root;
}
const call = (name, args = {}) => executeAgentTool({
  name, arguments: args, sessionId: null, permissionMode: 'read_only', rootPath: null, signal: undefined,
});

async function childCall(root, name, args = {}) {
  return executeAgentTool({ name, arguments: args, sessionId: null, permissionMode: 'read_only', rootPath: root });
}

// Mutations cannot run through the read-only child path by design; exercise
// them as a workspace chat (db-backed project + session). permissionGranted
// simulates the IPC path after the user approves the prompt.
let sessionSeq = 0;
const workspaceSessions = new Map();
async function workspaceCall(root, name, args = {}, permissionMode = 'workspace_write', permissionGranted = false) {
  let sid = workspaceSessions.get(root);
  if (!sid) {
    const project = require('../src/main/projectManager').createProject({ name: `git-${++sessionSeq}`, root_path: root });
    sid = `git-chat-${sessionSeq}`;
    require('../src/main/sessionManager').getOrCreateSession(sid, 'model', project.id);
    workspaceSessions.set(root, sid);
  }
  const approval = (permissionGranted || ['git_stage','git_unstage','git_stash','git_create_branch','git_switch'].includes(name))
    ? await guardTool({ name, args, sessionId: sid, project: { root_path: root }, permissionMode, requestApproval: async () => true }).catch(error => ({ fixtureError: error.message }))
    : null;
  if (approval?.fixtureError) return { success: false, error: approval.fixtureError };
  return executeAgentTool({ name, arguments: args, sessionId: sid, permissionMode, permissionGranted: !!approval, approval });
}

test.after(() => { db.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test('all six git tools are READ and visible in read_only, including to children', () => {
  for (const name of GIT_TOOLS) {
    assert.equal(capabilityOf(name), 'read');
    assert.equal(isToolVisible(name, { permissionMode: 'read_only', project: null }), true);
    assert.ok(CHILD_TOOL_NAMES.includes(name), `${name} must be in the child allowlist`);
  }
});

test('status shows untracked files, then a clean tree after commit', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'new.txt'), 'hello');
    const dirty = await childCall(root, 'git_status');
    assert.match(dirty.output, /\?\? new\.txt/);
    git(['add', 'new.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add new'], root);
    const clean = await childCall(root, 'git_status');
    assert.match(clean.output, /## main/);
    assert.doesNotMatch(clean.output, /\?\?/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diff shows unstaged work, staged flag, and stat summary', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add f'], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
    const worktree = await childCall(root, 'git_diff');
    assert.match(worktree.output, /-one\n\+two/);
    const stat = await childCall(root, 'git_diff', { stat_only: true });
    assert.match(stat.output, /f\.txt/);
    const staged = await childCall(root, 'git_diff', { staged: true });
    assert.equal(staged.output.trim(), '');
    const scoped = await childCall(root, 'git_diff', { relative_path: 'f.txt' });
    assert.match(scoped.output, /\+two/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('log lists commits newest-first and validates its limit', async () => {
  const root = makeRepo();
  try {
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'second'], root);
    const log = await childCall(root, 'git_log', { limit: 2 });
    const lines = log.output.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /second/);
    const bad = await childCall(root, 'git_log', { limit: 0 });
    assert.equal(bad.success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('show renders one commit and rejects shell-injection refs', async () => {
  const root = makeRepo();
  try {
    const shown = await childCall(root, 'git_show', { ref: 'HEAD' });
    assert.match(shown.output, /init/);
    const stat = await childCall(root, 'git_show', { ref: 'HEAD', stat_only: true });
    assert.ok(typeof stat.output === 'string');
    for (const evil of ['HEAD; rm -rf /', 'HEAD | cat /etc/passwd', '$(id)', '`id`', '--upload-pack=touch pwned']) {
      const rejected = await childCall(root, 'git_show', { ref: evil });
      assert.equal(rejected.success, false, evil);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('branch lists main; blame attributes lines and rejects escapes', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'code.js'), 'const a = 1;\nconst b = 2;\n');
    git(['add', 'code.js'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add code'], root);
    const branches = await childCall(root, 'git_branch');
    assert.match(branches.output, /main/);
    const blame = await childCall(root, 'git_blame', { relative_path: 'code.js' });
    assert.match(blame.output, /const a = 1/);
    const ranged = await childCall(root, 'git_blame', { relative_path: 'code.js', start_line: 2, end_line: 2 });
    assert.match(ranged.output, /const b = 2/);
    assert.doesNotMatch(ranged.output, /const a = 1/);
    const escape = await childCall(root, 'git_blame', { relative_path: '../outside.js' });
    assert.equal(escape.success, false);
    const badRange = await childCall(root, 'git_blame', { relative_path: 'code.js', start_line: 5, end_line: 2 });
    assert.equal(badRange.success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stage and commit stay out of read_only and out of child reach', () => {
  assert.equal(capabilityOf('git_stage'), 'workspace_write');
  assert.equal(capabilityOf('git_commit'), 'external_mutation');
  assert.equal(capabilityOf('git_sync'), 'external_mutation');
  for (const name of GIT_WRITE_TOOLS) {
    assert.equal(isToolVisible(name, { permissionMode: 'read_only', project: null }), false);
    assert.ok(!CHILD_TOOL_NAMES.includes(name), `${name} must never reach read-only children`);
  }
});

test('non-repositories fail closed and casual chats cannot reach the app repo', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-plain-'));
  try {
    const notRepo = await childCall(plain, 'git_status');
    assert.equal(notRepo.success, false);
    assert.match(notRepo.error, /Not a git repository/);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  // No workspace and no explicit root: must refuse instead of running git in
  // the application's own working directory.
  const casual = await call('git_status');
  assert.equal(casual.success, false);
  assert.match(casual.error, /project workspace/);
});

test('stage takes explicit paths only and rejects escapes', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    const staged = await workspaceCall(root, 'git_stage', { paths: ['a.txt'] });
    assert.ok(!('success' in staged) || staged.success !== false);
    assert.deepEqual(staged.staged, ['a.txt']);
    const cached = git(['diff', '--cached', '--name-only'], root).trim().split('\n');
    assert.deepEqual(cached, ['a.txt']);
    for (const bad of [['../outside.txt'], ['/abs.txt'], [], ['a.txt', 'a.txt']]) {
      const rejected = await workspaceCall(root, 'git_stage', { paths: bad });
      assert.equal(rejected.success, false, JSON.stringify(bad));
    }
    // Read-only children cannot stage at all.
    assert.equal((await childCall(root, 'git_stage', { paths: ['b.txt'] })).success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unstage round-trips staged files and keeps worktree content', async () => {
  const root = makeRepo();
  try {
    // a.txt is tracked (so unstaged changes show in git_diff); b.txt is new.
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    git(['add', 'a.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add a'], root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    await workspaceCall(root, 'git_stage', { paths: ['a.txt', 'b.txt'] });
    assert.deepEqual(git(['diff', '--cached', '--name-only'], root).trim().split('\n'), ['a.txt', 'b.txt']);
    // Partial unstage: only the listed path leaves the index.
    const partial = await workspaceCall(root, 'git_unstage', { paths: ['a.txt'] });
    assert.ok(!('success' in partial) || partial.success !== false, JSON.stringify(partial));
    assert.deepEqual(partial.unstaged, ['a.txt']);
    assert.deepEqual(git(['diff', '--cached', '--name-only'], root).trim().split('\n'), ['b.txt']);
    // The worktree change survives: still visible as unstaged, content intact.
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'changed\n');
    const status = await childCall(root, 'git_status');
    assert.match(status.output, /[ ?][M\?] .*a\.txt/);
    const unstagedDiff = await childCall(root, 'git_diff');
    assert.match(unstagedDiff.output, /changed/);
    const stagedDiff = await childCall(root, 'git_diff', { staged: true });
    assert.doesNotMatch(stagedDiff.output, /changed/);
    assert.match(stagedDiff.output, /b\.txt/);
    // Full unstage empties the index; nothing is lost.
    await workspaceCall(root, 'git_unstage', { paths: ['b.txt'] });
    assert.equal(git(['diff', '--cached', '--name-only'], root).trim(), '');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'b\n');
    // Read-only children cannot unstage at all.
    assert.equal((await childCall(root, 'git_unstage', { paths: ['a.txt'] })).success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unstage rejects the same hostile paths as stage', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    fs.mkdirSync(path.join(root, 'subdir'));
    fs.writeFileSync(path.join(root, 'subdir', 'c.txt'), 'c\n');
    await workspaceCall(root, 'git_stage', { paths: ['a.txt'] });
    const long = `${'x'.repeat(1025)}.txt`;
    for (const bad of [['.'], ['subdir/'], ['/abs.txt'], ['../outside.txt'], ['..\\x'],
        [long], ['a.txt', 'a.txt'], ['subdir'], [], 'a.txt', ['--staged'], [':(top)*']]) {
      const rejected = await workspaceCall(root, 'git_unstage', { paths: bad });
      assert.equal(rejected.success, false, JSON.stringify(bad));
    }
    // Nothing was unstaged by the rejections above.
    assert.deepEqual(git(['diff', '--cached', '--name-only'], root).trim().split('\n'), ['a.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unstage fails closed outside a repository', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-plain-'));
  try {
    const result = await workspaceCall(plain, 'git_unstage', { paths: ['a.txt'] });
    assert.equal(result.success, false);
    assert.match(result.error, /Not a git repository/);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

test('stash push stores tracked mods and leaves a clean tree', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'untracked\n');
    const pushed = await workspaceCall(root, 'git_stash', { action: 'push', message: 'wip work' });
    assert.ok(!('success' in pushed) || pushed.success !== false, JSON.stringify(pushed));
    assert.equal(pushed.action, 'push');
    // Tracked change stashed, worktree file restored; untracked file untouched.
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'one\n');
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'untracked\n');
    assert.equal(git(['status', '--porcelain=v1'], root).trim().split('\n').filter(line => !line.startsWith('??')).join(''), '');
    const listed = await workspaceCall(root, 'git_stash', { action: 'list' });
    assert.ok(!('success' in listed) || listed.success !== false, JSON.stringify(listed));
    assert.match(listed.output, /wip work/);
    assert.match(git(['stash', 'list'], root), /wip work/);
    // Pushing a clean tree stores nothing (git exits 0 with "No local
    // changes to save"): the existing entry is untouched, none is added.
    const empty = await workspaceCall(root, 'git_stash', { action: 'push' });
    assert.ok(!('success' in empty) || empty.success !== false, JSON.stringify(empty));
    assert.match(empty.output, /No local changes to save/);
    assert.equal(git(['stash', 'list'], root).trim().split('\n').length, 1);
    // Read-only children cannot stash at all — not even list, since the
    // tool as a whole can mutate (push/pop) and stays out of child reach.
    assert.equal((await childCall(root, 'git_stash', { action: 'list' })).success, false);
    assert.equal((await childCall(root, 'git_stash', { action: 'push', message: 'x' })).success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stash pop restores the entry and drops it', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
    await workspaceCall(root, 'git_stash', { action: 'push', message: 'first' });
    fs.writeFileSync(path.join(root, 'f.txt'), 'three\n');
    await workspaceCall(root, 'git_stash', { action: 'push', message: 'second' });
    assert.equal(git(['stash', 'list'], root).trim().split('\n').length, 2);
    // Indexed pop restores the older entry; the other entry survives.
    const popped = await workspaceCall(root, 'git_stash', { action: 'pop', index: 1 });
    assert.ok(!('success' in popped) || popped.success !== false, JSON.stringify(popped));
    assert.equal(popped.index, 1);
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'two\n');
    const remaining = git(['stash', 'list'], root).trim().split('\n');
    assert.equal(remaining.length, 1);
    assert.match(remaining[0], /second/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stash pop conflict surfaces git output without data loss', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
    await workspaceCall(root, 'git_stash', { action: 'push', message: 'stashed two' });
    fs.writeFileSync(path.join(root, 'f.txt'), 'three\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'three'], root);
    const conflicted = await workspaceCall(root, 'git_stash', { action: 'pop' });
    assert.equal(conflicted.success, false);
    assert.match(conflicted.error, /CONFLICT|conflict/i);
    // Nothing auto-resolved: the entry is kept and no content is lost.
    assert.match(git(['stash', 'list'], root), /stashed two/);
    const content = fs.readFileSync(path.join(root, 'f.txt'), 'utf8');
    assert.ok(content.includes('two') && content.includes('three'), content);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stash rejects hostile actions, messages, and indexes', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
    const bad = [
      { action: 'drop' }, { action: 'push; rm -rf /' }, { action: 'apply' },
      { action: 'push', message: '' }, { action: 'push', message: '   ' },
      { action: 'push', message: 'x'.repeat(501) }, { action: 'push', message: 42 },
      { action: 'push', index: 0 }, { action: 'list', message: 'x' }, { action: 'list', index: 0 },
      { action: 'pop', message: 'x' }, { action: 'pop', index: -1 }, { action: 'pop', index: 1.5 },
      { action: 'pop', index: '0' }, { action: 'pop', index: 'stash@{0}' }, { action: 'pop', index: 7 },
      { action: 'pop' },
    ];
    for (const args of bad) {
      const rejected = await workspaceCall(root, 'git_stash', args);
      assert.equal(rejected.success, false, JSON.stringify(args));
    }
    assert.match((await workspaceCall(root, 'git_stash', { action: 'pop', index: 7 })).error, /only \d+ stash/);
    // The refused calls stored and restored nothing.
    assert.equal(git(['stash', 'list'], root).trim(), '');
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'two\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stash fails closed outside a repository', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-plain-'));
  try {
    for (const args of [{ action: 'push', message: 'x' }, { action: 'pop' }, { action: 'list' }]) {
      const result = await workspaceCall(plain, 'git_stash', args);
      assert.equal(result.success, false, JSON.stringify(args));
      assert.match(result.error, /Not a git repository/, JSON.stringify(args));
    }
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

// Remote-sync fixtures. The sandbox masks host /tmp (tmpfs), so a file://
// remote the tool must read or write has to live INSIDE the project
// workspace (the only mounted path). Raw-git writers run unsandboxed and can
// use any local path. All URLs are file://.
function makeBare(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--bare', '--initial-branch=main'], dir);
}
function identify(root) {
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
}
function makePair() {
  const reader = makeRepo();
  identify(reader);
  const upstream = path.join(reader, 'upstream.git');
  makeBare(upstream);
  const url = pathToFileURL(upstream).href;
  git(['remote', 'add', 'origin', url], reader);
  git(['push', 'origin', 'main'], reader);
  const writerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-writer-'));
  git(['clone', url, writerDir], os.tmpdir());
  identify(writerDir);
  return { upstream, url, writer: writerDir, reader };
}
function makePushRepo() {
  const root = makeRepo();
  identify(root);
  const upstream = path.join(root, 'upstream.git');
  makeBare(upstream);
  const url = pathToFileURL(upstream).href;
  git(['remote', 'add', 'origin', url], root);
  return { root, upstream, url };
}
const syncCall = (root, args, granted = true) => workspaceCall(root, 'git_sync', args, 'workspace_write', granted);

test('sync fetch discovers new branches from a file remote', async () => {
  const { writer, reader, upstream } = makePair();
  try {
    git(['checkout', '-b', 'feature'], writer);
    fs.writeFileSync(path.join(writer, 'feat.txt'), 'feat\n');
    git(['add', 'feat.txt'], writer);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feature work'], writer);
    git(['push', 'origin', 'feature'], writer);
    // The reader has never seen this branch: the tool fetch must discover it.
    assert.doesNotMatch(git(['branch', '-r'], reader), /origin\/feature/);
    const fetched = await syncCall(reader, { action: 'fetch' });
    assert.ok(!('success' in fetched) || fetched.success !== false, JSON.stringify(fetched));
    assert.equal(fetched.action, 'fetch');
    assert.match(git(['branch', '-r'], reader), /origin\/feature/);
    // Explicit branch fetch works too.
    const scoped = await syncCall(reader, { action: 'fetch', branch: 'main' });
    assert.ok(!('success' in scoped) || scoped.success !== false, JSON.stringify(scoped));
    assert.equal(scoped.branch, 'main');
    // Unknown remotes and URLs never reach git.
    for (const args of [{ action: 'fetch', remote: 'nope' }, { action: 'fetch', remote: 'https://evil.example/x.git' },
        { action: 'fetch', remote: '--help' }, { action: 'fetch', branch: 'HEAD; rm -rf /' }, { action: 'merge' }]) {
      assert.equal((await syncCall(reader, args)).success, false, JSON.stringify(args));
    }
  } finally {
    fs.rmSync(writer, { recursive: true, force: true });
    fs.rmSync(reader, { recursive: true, force: true });
    fs.rmSync(upstream, { recursive: true, force: true });
  }
});

test('sync fetch reaches the network through its sandbox profile', async () => {
  // The file:// tests above never touch the network stack, so a regression
  // re-adding --unshare-net would pass them. A loopback git daemon proves
  // the network profile actually egresses; the daemon is test-only harness.
  const srv = fs.mkdtempSync(path.join(os.tmpdir(), 'git-srv-'));
  makeBare(path.join(srv, 'repo.git'));
  const seed = makeRepo();
  identify(seed);
  git(['remote', 'add', 'origin', path.join(srv, 'repo.git')], seed);
  git(['push', 'origin', 'main'], seed);
  const daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--listen=127.0.0.1', '--port=9418', `--base-path=${srv}`, srv], { stdio: 'ignore' });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'git-daemon-reader-'));
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try { git(['ls-remote', 'git://127.0.0.1:9418/repo.git'], srv); ready = true; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal(ready, true, 'git daemon did not start');
    git(['clone', 'git://127.0.0.1:9418/repo.git', work], os.tmpdir());
    git(['checkout', '-b', 'netted'], seed);
    fs.writeFileSync(path.join(seed, 'n.txt'), 'n\n');
    git(['add', 'n.txt'], seed);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'netted work'], seed);
    git(['push', 'origin', 'netted'], seed);
    const fetched = await syncCall(work, { action: 'fetch' });
    assert.ok(!('success' in fetched) || fetched.success !== false, JSON.stringify(fetched));
    assert.match(git(['branch', '-r'], work), /origin\/netted/);
  } finally {
    daemon.kill();
    await new Promise((resolve) => { daemon.on('close', resolve); setTimeout(resolve, 3000); });
    fs.rmSync(seed, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(srv, { recursive: true, force: true });
  }
});

test('sync pull fast-forwards, and refuses dirty or diverged trees', async () => {
  const { writer, reader, upstream } = makePair();
  try {
    fs.writeFileSync(path.join(writer, 'v2.txt'), 'v2\n');
    git(['add', 'v2.txt'], writer);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v2'], writer);
    git(['push', 'origin', 'main'], writer);
    const pulled = await syncCall(reader, { action: 'pull' });
    assert.ok(!('success' in pulled) || pulled.success !== false, JSON.stringify(pulled));
    assert.equal(pulled.action, 'pull');
    assert.equal(fs.readFileSync(path.join(reader, 'v2.txt'), 'utf8'), 'v2\n');
    // A dirty worktree refuses before contacting the remote.
    fs.writeFileSync(path.join(reader, 'v2.txt'), 'dirty\n');
    const dirtyHead = git(['rev-parse', 'HEAD'], reader).trim();
    const dirty = await syncCall(reader, { action: 'pull' });
    assert.equal(dirty.success, false);
    assert.match(dirty.error, /commit or stash/);
    assert.equal(git(['rev-parse', 'HEAD'], reader).trim(), dirtyHead);
    git(['checkout', '--', 'v2.txt'], reader);
    // Diverged history refuses instead of merging; HEAD never moves and no
    // merge commit is created.
    fs.writeFileSync(path.join(writer, 'v3.txt'), 'v3\n');
    git(['add', 'v3.txt'], writer);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v3'], writer);
    git(['push', 'origin', 'main'], writer);
    fs.writeFileSync(path.join(reader, 'local.txt'), 'local\n');
    git(['add', 'local.txt'], reader);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'local'], reader);
    const before = git(['rev-parse', 'HEAD'], reader).trim();
    const diverged = await syncCall(reader, { action: 'pull' });
    assert.equal(diverged.success, false);
    assert.match(diverged.error, /diverged|fast-forward|ff-only/i);
    assert.equal(git(['rev-parse', 'HEAD'], reader).trim(), before);
    assert.doesNotMatch(git(['log', '--pretty=%s', '-n', '1'], reader), /[Mm]erge/);
    // Pulling without an approval grant prompts instead of running.
    assert.match((await syncCall(reader, { action: 'pull' }, false)).error, /approval denied/i);
  } finally {
    fs.rmSync(writer, { recursive: true, force: true });
    fs.rmSync(reader, { recursive: true, force: true });
    fs.rmSync(upstream, { recursive: true, force: true });
  }
});

test('sync push publishes with fingerprint approval', async () => {
  const { root, upstream } = makePushRepo();
  try {
    fs.writeFileSync(path.join(root, 'p.txt'), 'v1\n');
    git(['add', 'p.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add p'], root);
    await workspaceCall(root, 'git_status');
    const sid = workspaceSessions.get(root);
    // The approval card shows remote/branch/outgoing history — never secrets.
    let displayed;
    const approval = await guardTool({ name: 'git_sync', args: { action: 'push' }, sessionId: sid,
      project: { root_path: root }, permissionMode: 'workspace_write',
      requestApproval: async (payload) => { displayed = payload; return true; } });
    assert.ok(approval.gitPushFingerprint);
    assert.match(displayed.args.outgoing, /origin/);
    assert.match(displayed.args.outgoing, /main/);
    assert.match(displayed.args.outgoing, /add p/);
    assert.doesNotMatch(displayed.args.outgoing, /ghp_|github_pat_|token\s*[:=]/i);
    const done = await executeAgentTool({ name: 'git_sync', arguments: { action: 'push' },
      sessionId: sid, permissionMode: 'workspace_write', permissionGranted: true, approval });
    assert.ok(!('success' in done) || done.success !== false, JSON.stringify(done));
    assert.equal(done.action, 'push');
    assert.match(git(['log', '--pretty=%s', 'main'], upstream), /add p/);
    assert.equal(git(['rev-parse', 'main'], upstream).trim(), git(['rev-parse', 'HEAD'], root).trim());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sync push rejects stale approval and diverged remotes', async () => {
  const { root, upstream, url } = makePushRepo();
  try {
    fs.writeFileSync(path.join(root, 'p.txt'), 'v1\n');
    git(['add', 'p.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v1'], root);
    await workspaceCall(root, 'git_status');
    const sid = workspaceSessions.get(root);
    const approve = () => guardTool({ name: 'git_sync', args: { action: 'push' }, sessionId: sid,
      project: { root_path: root }, permissionMode: 'workspace_write', requestApproval: async () => true });
    const run = (approval) => executeAgentTool({ name: 'git_sync', arguments: { action: 'push' },
      sessionId: sid, permissionMode: 'workspace_write', permissionGranted: true, approval });
    // Local movement after approval invalidates it.
    const stale = await approve();
    fs.writeFileSync(path.join(root, 'p.txt'), 'v2\n');
    git(['add', 'p.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v2'], root);
    const rejected = await run(stale);
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /changed since approval/);
    // Fresh approval publishes the new state.
    const published = await run(await approve());
    assert.ok(!('success' in published) || published.success !== false, JSON.stringify(published));
    assert.match(git(['log', '--pretty=%s', 'main'], upstream), /v2/);
    // A second writer advances the remote: our push must refuse rather than
    // overwrite, with no force flag able to override it.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'git-other-'));
    try {
      git(['clone', url, other], os.tmpdir());
      identify(other);
      fs.writeFileSync(path.join(other, 'q.txt'), 'q\n');
      git(['add', 'q.txt'], other);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v3'], other);
      git(['push', 'origin', 'main'], other);
      fs.writeFileSync(path.join(root, 'r.txt'), 'r\n');
      git(['add', 'r.txt'], root);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'local-r'], root);
      const remoteTip = git(['rev-parse', 'main'], upstream).trim();
      const diverged = await run(await approve());
      assert.equal(diverged.success, false);
      assert.match(diverged.error, /diverged/);
      assert.equal(git(['rev-parse', 'main'], upstream).trim(), remoteTip);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sync schema exposes no force or refspec surface', () => {
  const definition = agentTools.find((tool) => tool.function.name === 'git_sync').function;
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['action', 'branch', 'remote']);
  assert.deepEqual(definition.parameters.properties.action.enum, ['fetch', 'pull', 'push']);
  assert.deepEqual(definition.parameters.required, ['action']);
});

test('sync auth failure names gh without leaking secrets', async () => {
  const root = makeRepo();
  git(['remote', 'add', 'origin', 'https://127.0.0.1:1/unreachable.git'], root);
  // Scrub every credential source so the gh probe deterministically fails
  // before any network is attempted.
  const saved = { HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'git-empty-home-'));
  process.env.HOME = emptyHome;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await workspaceCall(root, 'git_status');
    const sid = workspaceSessions.get(root);
    const result = await syncCall(root, { action: 'fetch' });
    assert.equal(result.success, false);
    assert.match(result.error, /Authentication failed for 'origin'/);
    assert.match(result.error, /gh auth login/);
    assert.doesNotMatch(result.error, /ghp_|github_pat_|token\s*[:=][^\s]/i);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.GH_TOKEN;
    if (saved.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    fs.rmSync(emptyHome, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync fails closed outside a repository', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-plain-'));
  try {
    // Fetch runs unprompted; pull/push carry an approval grant so each action
    // reaches remote resolution, where the missing repository fails closed.
    assert.match((await syncCall(plain, { action: 'fetch' })).error, /Not a git repository/);
    assert.match((await syncCall(plain, { action: 'pull' })).error, /Not a git repository/);
    const sid = workspaceSessions.get(plain);
    const push = await syncCall(plain, { action: 'push' });
    assert.equal(push.success, false);
    assert.match(push.error, /Not a git repository/);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

test('commit needs a message, stages nothing itself, and reports its hash', async () => {
  const root = makeRepo();
  try {
    git(['config', 'user.email', 't@t'], root);
    git(['config', 'user.name', 't'], root);
    fs.writeFileSync(path.join(root, 'staged.txt'), 's\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'u\n');
    const grant = (name, args) => workspaceCall(root, name, args, 'workspace_write', true);
    const empty = await grant('git_commit', { message: '   ' });
    assert.equal(empty.success, false);
    const unstaged = await grant('git_commit', { message: 'nope' });
    assert.equal(unstaged.success, false, 'nothing staged must fail, not create an empty commit');
    await workspaceCall(root, 'git_stage', { paths: ['staged.txt'] });
    const done = await grant('git_commit', { message: 'add staged' });
    assert.match(done.output, /add staged/);
    assert.match(done.hash ?? '', /^[0-9a-f]{40}$/);
    // The untracked file was never staged implicitly.
    assert.match(git(['status', '--porcelain=v1'], root), /\?\? untracked\.txt/);
    assert.match(git(['log', '--pretty=%s', '-n', '1'], root), /add staged/);
    // Read-only children cannot commit at all.
    assert.equal((await childCall(root, 'git_commit', { message: 'x' })).success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('create_branch creates on HEAD and auto-switches', async () => {
  const root = makeRepo();
  try {
    const created = await workspaceCall(root, 'git_create_branch', { name: 'feature/work' });
    assert.ok(!('success' in created) || created.success !== false, JSON.stringify(created));
    assert.equal(created.branch, 'feature/work');
    assert.equal(created.switched, true);
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], root).trim(), 'feature/work');
    assert.match(git(['branch', '--list', 'feature/work'], root), /feature\/work/);
    // Read-only children cannot create branches at all.
    assert.equal((await childCall(root, 'git_create_branch', { name: 'nope' })).success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('create_branch starts from a tag or older ref without switching', async () => {
  const root = makeRepo();
  try {
    git(['tag', 'v1'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'second'], root);
    const tagged = git(['rev-parse', 'v1'], root).trim();
    const created = await workspaceCall(root, 'git_create_branch', { name: 'from-tag', start_point: 'v1', switch: false });
    assert.ok(!('success' in created) || created.success !== false, JSON.stringify(created));
    assert.equal(created.switched, false);
    assert.equal(git(['rev-parse', 'from-tag'], root).trim(), tagged);
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], root).trim(), 'main');
    // A hostile start_point goes through ref validation, never a shell.
    const badStart = await workspaceCall(root, 'git_create_branch', { name: 'bad', start_point: 'HEAD; rm -rf /' });
    assert.equal(badStart.success, false);
    assert.match(git(['branch', '--list'], root), /from-tag/);
    assert.doesNotMatch(git(['branch', '--list'], root), /\bbad\b/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('switch moves HEAD on a clean tree and refuses a dirty one', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    await workspaceCall(root, 'git_create_branch', { name: 'side', switch: false });
    const moved = await workspaceCall(root, 'git_switch', { ref: 'side' });
    assert.ok(!('success' in moved) || moved.success !== false, JSON.stringify(moved));
    assert.equal(moved.branch, 'side');
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], root).trim(), 'side');
    // Unstaged changes block the way back.
    fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
    const refused = await workspaceCall(root, 'git_switch', { ref: 'main' });
    assert.equal(refused.success, false);
    assert.match(refused.error, /commit or stash/);
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], root).trim(), 'side');
    // Staged changes block too.
    git(['checkout', '--', 'f.txt'], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'three\n');
    git(['add', 'f.txt'], root);
    const refusedStaged = await workspaceCall(root, 'git_switch', { ref: 'main' });
    assert.equal(refusedStaged.success, false);
    assert.match(refusedStaged.error, /commit or stash/);
    // Clean again: untracked files alone never block a switch.
    git(['reset', 'HEAD', 'f.txt'], root);
    git(['checkout', '--', 'f.txt'], root);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'u\n');
    const withUntracked = await workspaceCall(root, 'git_switch', { ref: 'main' });
    assert.ok(!('success' in withUntracked) || withUntracked.success !== false, JSON.stringify(withUntracked));
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], root).trim(), 'main');
    // Read-only children cannot switch at all.
    assert.equal((await childCall(root, 'git_switch', { ref: 'side' })).success, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hostile branch names are rejected and create nothing', async () => {
  const root = makeRepo();
  try {
    const hostile = ['../../x', '--help', '@{1}', '', 'a'.repeat(101), 'foo//bar',
      'foo.lock', '.hidden', '/abs', '-dash', 'trail/', 'has space', 'semi;colon',
      'HEAD~1', 'a:b', 'back\\slash', 'star*glob'];
    for (const name of hostile) {
      const create = await workspaceCall(root, 'git_create_branch', { name });
      assert.equal(create.success, false, JSON.stringify(name));
      const switched = await workspaceCall(root, 'git_switch', { ref: name });
      assert.equal(switched.success, false, JSON.stringify(name));
    }
    // Nothing hostile was created and HEAD never moved.
    assert.deepEqual(git(['branch', '--list'], root).trim().split('\n').map(line => line.replace(/^\* /, '').trim()), ['main']);
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], root).trim(), 'main');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('branch tools fail closed outside a repository', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'git-plain-'));
  try {
    for (const [name, args] of [['git_create_branch', { name: 'x' }], ['git_switch', { ref: 'main' }]]) {
      const result = await workspaceCall(plain, name, args);
      assert.equal(result.success, false, name);
      assert.match(result.error, /Not a git repository/, name);
    }
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

test('Workspace Write commits and stages autonomously; Ask for Approval still reviews commits', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'f.txt'), 'review me');
  git(['add', 'f.txt'], root);
  const project = { root_path: root };
  // Ask for Approval preserves the staged-diff review.
  for (const mode of ['ask_approval']) {
    let requested = false;
    await assert.rejects(guardTool({ name: 'git_commit', args: { message: 'x' },
      permissionMode: mode, project,
      requestApproval: async () => { requested = true; return false; } }), /approval denied/);
    assert.equal(requested, true, mode);
    const granted = await guardTool({ name: 'git_commit', args: { message: 'x' },
      permissionMode: mode, project, requestApproval: async () => true });
    assert.equal(granted.approved, true, mode);
  }
  // Contained staging runs silently; escapes stay denied in workspace_write.
  let requested = false;
  const inside = await guardTool({ name: 'git_stage', args: { paths: ['f.txt'] },
    permissionMode: 'workspace_write', project, requestApproval: async () => { requested = true; return true; } });
  assert.equal(requested, false);
  assert.equal(inside.approved, false);
  await assert.rejects(guardTool({ name: 'git_stage', args: { paths: ['../outside.txt'] },
    permissionMode: 'workspace_write', project,
    requestApproval: async () => { throw new Error('must not ask'); } }), /Path escapes/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hostile diff, textconv and fsmonitor helpers are disabled for inspection', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'before\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt diff=hostile\n');
    const helper = 'touch helper-ran; cat';
    git(['config', 'diff.external', helper], root);
    git(['config', 'diff.hostile.textconv', helper], root);
    git(['config', 'core.fsmonitor', helper], root);
    fs.writeFileSync(path.join(root, 'f.txt'), 'after\n');
    for (const [name, args] of [['git_status', {}], ['git_diff', {}], ['git_show', { ref: 'HEAD' }]]) {
      const result = await childCall(root, name, args);
      assert.notEqual(result.success, false, JSON.stringify(result));
    }
    assert.equal(fs.existsSync(path.join(root, 'helper-ran')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staging filters cannot write outside the workspace', async () => {
  const root = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-filter-outside-'));
  try {
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=hostile\n');
    fs.writeFileSync(path.join(root, 'f.txt'), 'content\n');
    git(['config', 'filter.hostile.clean', `touch '${outside}/escaped'; cat`], root);
    const result = await workspaceCall(root, 'git_stage', { paths: ['f.txt'] });
    assert.notEqual(result.success, false, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(outside, 'escaped')), false);
    for (const paths of [['.'], ['../x'], ['..\\x'], [root], [':(top)*']]) {
      assert.equal((await workspaceCall(root, 'git_stage', { paths })).success, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('commit approval contains staged diff and rejects subsequent staged changes', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'approved\n');
    git(['add', 'f.txt'], root);
    let displayed;
    await workspaceCall(root, 'git_status');
    const sid = workspaceSessions.get(root);
    const approval = await guardTool({ name: 'git_commit', args: { message: 'review' }, sessionId: sid, project: { root_path: root },
      permissionMode: 'workspace_write', requestApproval: async payload => { displayed = payload; return true; } });
    assert.equal(displayed, undefined);
    assert.match(approval.gitCommitReview.staged_diff, /approved/);
    assert.equal(approval.gitCommitReview.message, 'review');
    fs.writeFileSync(path.join(root, 'f.txt'), 'changed\n');
    git(['add', 'f.txt'], root);
    const result = await executeAgentTool({ name: 'git_commit', arguments: { message: 'review' }, sessionId: sid,
      permissionMode: 'workspace_write', permissionGranted: true, approval });
    assert.equal(result.success, false);
    assert.match(result.error, /changed since approval/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('blame start-only ranges extend to the actual end of the file', async () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\ntwo\nthree\n');
    git(['add', 'f.txt'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'file'], root);
    const result = await childCall(root, 'git_blame', { relative_path: 'f.txt', start_line: 2 });
    assert.match(result.output, /three/);
    assert.doesNotMatch(result.output, /one/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing sandbox fails closed without running Git directly', async () => {
  const root = makeRepo();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent-git-sandbox-test';
    const result = await childCall(root, 'git_status');
    assert.equal(result.success, false);
    assert.match(result.error, /bwrap is not installed/);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
