'use strict';
// Discovery never invokes Git, follows a parent repository, or initializes one.
const fs = require('node:fs');
const path = require('node:path');
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
function hasRepository(marker) {
  try {
    let dir = fs.realpathSync(marker);
    if (!fs.statSync(dir).isDirectory()) {
      if (fs.statSync(dir).size > 16384) return false;
      const match = fs.readFileSync(dir, 'utf8').match(/^gitdir:\s*(.+)\s*$/);
      if (!match) return false;
      dir = path.resolve(path.dirname(marker), match[1].trim());
    }
    return fs.statSync(path.join(dir, 'HEAD')).isFile();
  } catch { return false; }
}
function repository(root) {
  try {
    root = fs.realpathSync(root);
    const marker = path.join(root, '.git');
    if (!fs.existsSync(marker)) {
      let parent = path.dirname(root);
      while (parent !== path.dirname(parent)) {
        if (hasRepository(path.join(parent, '.git'))) return { state: 'outside', reason: 'The Git repository belongs to a parent workspace.' };
        parent = path.dirname(parent);
      }
      return { state: 'absent' };
    }
    const real = fs.realpathSync(marker);
    if (!inside(root, real)) return { state: 'outside', reason: 'Git metadata resolves outside the authorized workspace.' };
    let gitdir = real;
    if (!fs.statSync(real).isDirectory()) {
      if (fs.statSync(real).size > 16384) return { state: 'invalid', reason: 'Oversize .git file.' };
      const match = fs.readFileSync(real, 'utf8').match(/^gitdir:\s*(.+)\s*$/);
      if (!match) return { state: 'invalid', reason: 'Invalid .git file.' };
      gitdir = fs.realpathSync(path.resolve(root, match[1].trim()));
    }
    if (!hasRepository(marker)) return { state: 'invalid', reason: 'Git metadata has no valid HEAD.' };
    const commonFile = path.join(gitdir, 'commondir');
    const common = fs.existsSync(commonFile) ? fs.realpathSync(path.resolve(gitdir, fs.readFileSync(commonFile, 'utf8').trim())) : gitdir;
    if (![gitdir, common].every(p => inside(root, p))) return { state: 'outside', reason: 'Linked worktree/submodule metadata is outside the authorized workspace; select an authorized repository containing its metadata.' };
    return { state: 'detected', root, gitdir };
  } catch (error) { return { state: 'invalid', reason: `Repository metadata is unavailable (${error.code || 'invalid'}).` }; }
}
function failure(code, operation, reason, next, extra = {}) {
  return Object.assign(new Error(`${code}: ${operation}: ${reason} ${next}`), {
    code, gitDetails: { operation, operation_executed: false, side_effects: false, recoveryCheckpointId: null, suggested_action: next, ...extra },
  });
}
function assertRepository(root, operation) {
  const repo = repository(root);
  if (repo.state === 'detected') return repo;
  if (repo.state === 'absent' || repo.state === 'invalid') throw failure('NOT_A_GIT_REPOSITORY', operation,
    'Not a git repository: this workspace is not a Git repository. File editing, testing and Continuum recovery remain available.',
    'Continue with file tools. Git initialization is optional; initialize only when requested or clearly authorized.');
  throw failure('GIT_REPOSITORY_OUTSIDE_WORKSPACE', operation, repo.reason, 'Select the actual authorized repository root; do not retry against a parent repository.');
}
function section(mode, root) {
  if (mode !== 'workspace_write' || !root) return '';
  const repo = repository(root);
  if (repo.state !== 'detected') return ` Git: ${repo.state === 'absent' ? 'not detected' : repo.state}; unavailable. Files/tests/recovery available; no automatic init.`;
  return ' Git: project root; Workspace Git tools; inspect/stage/unstage/commit/clean branch automatic; hooks disabled; stash needs coverage; remote fetch policy, pull/push review; destructive history approval.';
}
const writes = new Map();
function enter(root, operation, git) {
  root = fs.realpathSync(root);
  const state = writes.get(root) || { files: 0, git: false };
  if (state.git || (git && state.files)) throw failure('GIT_RECOVERY_REQUIRED', operation,
    'A conflicting workspace write is active.', 'Wait for that operation to finish, inspect changes and retry with fresh authorization.');
  if (git) state.git = true; else state.files++;
  writes.set(root, state);
  return () => { if (git) state.git = false; else state.files--; if (!state.git && !state.files) writes.delete(root); };
}
module.exports = { enter, repository, assertRepository, failure, section };
