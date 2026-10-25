'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shell-readonly-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => path.join(directory, 'userdata') } };
  return load.call(this, name, ...args);
};
const { executeCommand } = require('../src/main/tools/agentTools');
const { SHELL_HINT, resolveGitMetadata, shellMetadataReadOnlyFailure: diagnose } = require('../src/main/gitMetadata');
const shellMetadataReadOnlyFailure = (workspace, cwd, stderr) => diagnose(resolveGitMetadata(workspace), cwd, stderr);
const git = (root, args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function fixture() {
  const root = fs.mkdtempSync(path.join(directory, 'repo with spaces-'));
  git(root, ['init', '-qb', 'main']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(root, 'file'), 'initial'); git(root, ['add', 'file']); git(root, ['commit', '-qm', 'initial']);
  git(root, ['branch', 'other']);
  return root;
}
test.after(() => { Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });

test('real shell git mutations preserve read-only error and append exact hint in model output', async () => {
  const { formatToolResult } = await import('../src/lib/toolResultFormatter.mjs');
  for (const command of ['git commit --allow-empty -m x', 'git add file', 'git checkout other', 'git switch other',
    'git reset --hard HEAD', 'git merge other', 'git rebase --force-rebase HEAD', 'git tag new-tag',
    'git branch new-branch', 'git branch -D other', 'git init', 'git config user.name Changed']) {
    const root = fixture();
    if (command === 'git add file') fs.writeFileSync(path.join(root, 'file'), 'changed');
    if (command === 'git merge other') {
      git(root, ['checkout', '-q', 'other']); fs.writeFileSync(path.join(root, 'feature'), 'feature');
      git(root, ['add', 'feature']); git(root, ['commit', '-qm', 'feature']); git(root, ['checkout', '-q', 'main']);
    }
    const result = await executeCommand({ command }, root, undefined, root);
    assert.equal(result.success, false, command + ': ' + JSON.stringify(result));
    assert.match(result.stderr, /Read-only file system/i, command + ': ' + JSON.stringify(result));
    assert.ok(result.stderr.endsWith(SHELL_HINT), command + ': ' + result.stderr);
    const model = JSON.parse(formatToolResult(result, 'execute_command').content);
    assert.equal(model.stderr, result.stderr, command);
    assert.ok(model.stderr.indexOf('Read-only file system') < model.stderr.indexOf(SHELL_HINT), command);
  }
});

test('successful shell git inspections remain unchanged with optional index locks disabled', async () => {
  const root = fixture();
  for (const command of ['git status', 'git diff', 'git log', 'git show']) {
    const result = await executeCommand({ command }, root, undefined, root);
    assert.equal(result.success, true, command + ': ' + JSON.stringify(result));
    assert.equal(result.stderr, '', command);
    assert.ok(!result.stdout.includes(SHELL_HINT), command);
    assert.equal(result.stdout, cp.execFileSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }), command);
  }
});

test('diagnosis follows metadata paths for linked worktrees, submodules, aliases and cwd', () => {
  const root = fixture(), worktree = path.join(directory, 'linked worktree');
  git(root, ['worktree', 'add', '-q', worktree, 'other']);
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'sub', root, 'sub']);
  const gitdir = git(worktree, ['rev-parse', '--absolute-git-dir']).trim();
  for (const [workspace, cwd, target] of [
    [worktree, worktree, path.join(gitdir, 'index.lock')],
    [worktree, worktree, path.join(root, '.git/refs/heads/new.lock')],
    [root, path.join(root, 'sub'), '../.git/modules/sub/index.lock'],
    [root, root, '.git/modules/sub/config.lock'],
  ]) assert.equal(shellMetadataReadOnlyFailure(workspace, cwd, `fatal: Unable to create '${target}': Read-only file system`), true, target);
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'alias'));
  assert.equal(shellMetadataReadOnlyFailure(root, root, 'cannot create alias/config: Read-only file system'), true);
});

test('hint depends on read-only metadata failure, not command spelling or unrelated errors', async () => {
  const root = fixture(), runner = require('../src/main/foregroundCommand'), original = runner.runForeground;
  try {
    for (const [stderr, hint] of [
      ["fatal: Unable to create '.git/index.lock': Read-only file system", true],
      ['error: could not lock config file .git/config: Read-only file system', true],
      ["fatal: Unable to create '.git/refs/stash.lock': Read-only file system", true],
      ['cannot create /usr/bin/file: Read-only file system', false],
      ['cannot create .git-other/config: Read-only file system', false],
      ["fatal: Unable to create '.git/index.lock': Permission denied", false],
      ["fatal: Unable to create '.git/index.lock': File exists", false],
      ['.git/config\ncannot create /usr/bin/file: Read-only file system', false],
    ]) {
      runner.runForeground = async () => ({ status: 'failed', exitCode: 1, stdout: '', stderr });
      const result = await executeCommand({ command: 'some-wrapper' }, root, undefined, root);
      assert.equal(result.stderr, hint ? stderr + '\n' + SHELL_HINT : stderr);
    }
  } finally { runner.runForeground = original; }
});

test('redirected Git diagnostics still reach the model with the original text and hint', async () => {
  const root = fixture();
  const result = await executeCommand({ command: 'git commit --allow-empty -m x 2>&1' }, root, undefined, root);
  assert.equal(result.success, false); assert.equal(result.stderr, '');
  assert.match(result.stdout, /Read-only file system/); assert.ok(result.stdout.endsWith(SHELL_HINT));
  const { formatToolResult } = await import('../src/lib/toolResultFormatter.mjs');
  assert.equal(JSON.parse(formatToolResult(result, 'execute_command').content).stdout, result.stdout);
});

test('silent failures are preserved instead of guessing that read-only Git metadata caused them', async () => {
  const root = fixture(), runner = require('../src/main/foregroundCommand'), original = runner.runForeground;
  runner.runForeground = async () => ({ status: 'nonzero_exit', exitCode: 1, stdout: '', stderr: '' });
  try {
    const result = await executeCommand({ command: 'git stash push' }, root, undefined, root);
    assert.equal(result.stderr, ''); assert.equal(result.stdout, ''); assert.equal(result.success, false);
  } finally { runner.runForeground = original; }
});
