'use strict';

// Process-local, single-use capabilities. Serialized approval objects, tool
// output, checkpoints and renderer arguments cannot mint these grants.
const { createHash } = require('node:crypto');
const grants = new WeakMap();
const deleteGrants = new WeakMap();
const { isCommand, isOpaqueGit } = require('./nativeExecutionKinds');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scope({ name, args, sessionId, project, mode, policyRevision, executionProfile, commandUncontained, approved, deleteFingerprint, serverName, savedRule, imageProviderKey, gitRecovery }) {
  return digest([name, args, savedRule ? (serverName ?? null) : null, savedRule?.id ?? null, imageProviderKey ?? null, sessionId ?? null, project?.root_path ?? null, mode, policyRevision ?? null, executionProfile ?? null,
    isCommand(name) ? [commandUncontained ?? null, approved ?? null] : null,
    name === 'delete_project_file' ? deleteFingerprint ?? null : null,
    name === 'git_stash' ? gitRecovery ?? null : null]);
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
  if (isCommand(options.name) && decision?.approved === false &&
      (decision.executionProfile !== 'bwrap_workspace' || decision.commandUncontained !== false ||
       options.mode !== 'workspace_write' || !options.project?.root_path))
    throw new Error('Execution blocked: Autonomous commands require the bwrap workspace profile.');
}
function issueDelete(decision, capture, options) {
  deleteGrants.set(decision, { capture, scope: scope({ ...options, ...decision }), expires: Date.now() + 120000 });
}
function consumeDelete(decision, options) {
  const grant = deleteGrants.get(decision);
  deleteGrants.delete(decision);
  if (!grant || grant.expires < Date.now() || grant.scope !== scope({ ...options, ...decision }))
    throw new Error('Execution blocked: A current, specific deletion authorization is required.');
  return grant.capture;
}
module.exports = { issueDelete, consumeDelete, isCommand, isOpaqueGit, isProtected: name => isCommand(name) || isOpaqueGit(name) || name === 'git_sync' || name === 'generate_image', issue, consume };
