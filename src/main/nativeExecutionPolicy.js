'use strict';

// Process-local, single-use capabilities. Serialized approval objects, tool
// output, checkpoints and renderer arguments cannot mint these grants.
const { createHash } = require('node:crypto');
const grants = new WeakMap();
const isCommand = name => name === 'execute_command' || name === 'run_tests';
const isOpaqueGit = name => ['git_stage', 'git_unstage', 'git_stash', 'git_commit', 'git_create_branch', 'git_switch'].includes(name);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scope({ name, args, sessionId, project, mode, policyRevision }) {
  return digest([name, args, sessionId ?? null, project?.root_path ?? null, mode, policyRevision ?? null]);
}
function issue(decision, options) {
  grants.set(decision, { scope: scope({ ...options, ...decision }), expires: Date.now() + 120000 });
  return decision;
}
function consume(decision, options) {
  const grant = decision && grants.get(decision);
  if (grant) grants.delete(decision);
  if (!grant || grant.expires < Date.now() || grant.scope !== scope(options)) {
    throw Object.assign(new Error('Execution blocked: A current, specific native execution approval is required.'), { code: 'APPROVAL_REQUIRED' });
  }
}
module.exports = { isCommand, isOpaqueGit, isProtected: name => isCommand(name) || isOpaqueGit(name) || name === 'git_sync', issue, consume };
