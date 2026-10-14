'use strict';
// Git read-only tools: status/diff/log/show/branch/blame over real temp repos.
// Run with: node --test tests/gitTools.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tools-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(directory);
const { executeAgentTool } = require('../src/main/tools/agentTools');
const { capabilityOf, isToolVisible, guardTool, CAPABILITIES } = require('../src/main/toolPermissions');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

const GIT_TOOLS = ['git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame'];
const GIT_WRITE_TOOLS = ['git_stage', 'git_commit'];
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
  const approval = permissionGranted && name === 'git_commit'
    ? await guardTool({ name, args, project: { root_path: root }, permissionMode, requestApproval: async () => true }).catch(() => null)
    : null;
  return executeAgentTool({ name, arguments: args, sessionId: sid, permissionMode, permissionGranted, approval });
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

test('commit always prompts outside full_access; stage stays contained', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'f.txt'), 'review me');
  git(['add', 'f.txt'], root);
  const project = { root_path: root };
  // Commit prompts in both workspace modes, even for in-workspace work.
  for (const mode of ['workspace_write', 'ask_approval']) {
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
    const approval = await guardTool({ name: 'git_commit', args: { message: 'review' }, project: { root_path: root },
      permissionMode: 'workspace_write', requestApproval: async payload => { displayed = payload; return true; } });
    assert.match(displayed.args.staged_diff, /approved/);
    await workspaceCall(root, 'git_status');
    const sid = workspaceSessions.get(root);
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
