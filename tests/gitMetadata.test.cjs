'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { resolveGitMetadata, assertWritable } = require('../src/main/gitMetadata');
test('git metadata resolves normal, worktree and submodule layouts and rejects writes and aliases', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-metadata-'));
 try {
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  assert.deepEqual(resolveGitMetadata(repo), []);
  const git = (args, cwd = repo) => cp.execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init']); git(['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '--allow-empty', '-m', 'initial']);
  const wt = path.join(dir, 'worktree'); git(['worktree', 'add', wt]);
  const paths = resolveGitMetadata(wt);
  assert.ok(paths.includes(path.join(repo, '.git')));
  assert.ok(paths.includes(path.join(wt, '.git')));
  assert.ok(paths.includes(path.join(repo, '.git/worktrees/worktree')));
  const sub = path.join(repo, 'sub'); git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'sub', repo, sub]);
  assert.ok(resolveGitMetadata(repo).includes(path.join(repo, '.git/modules/sub')));
  fs.symlinkSync(path.join(repo, '.git'), path.join(repo, 'alias'));
  for (const target of ['.git/config', '.git/hooks/new', 'alias/config', 'sub/.git', '.']) assert.throws(() => assertWritable(repo, path.join(repo, target)), /Git metadata is read-only here; use the git_\* tools/);
  assert.doesNotThrow(() => assertWritable(repo, path.join(repo, 'file')));
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
