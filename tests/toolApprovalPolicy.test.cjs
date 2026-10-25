'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideToolApproval, baseDecision, CAPABILITIES } = require('../src/main/toolApprovalPolicy');
const modes = ['workspace_write', 'ask_approval', 'read_only', 'full_access'];
const workspace = '/workspace';
const rows = [
  ['execute_command', { command: 'printf ok' }, ['ask', 'ask', 'block', 'allow']],
  ['run_tests', { command: 'npm test' }, ['ask', 'ask', 'block', 'allow']],
  ...['git_stage', 'git_unstage', 'git_create_branch', 'git_switch', 'git_commit'].map(tool => [tool, {}, ['ask', 'ask', 'block', 'allow']]),
  ...['list', 'show', 'push', 'drop', 'clear'].map(action => ['git_stash', { action }, ['ask', 'ask', 'block', 'allow']]),
  ...['fetch', 'pull', 'push'].map(action => ['git_sync', { action }, ['ask', 'ask', 'block', 'allow']]),
  ...['delete_project_file', 'generate_image', 'approve_mcp_mutation'].map(tool => [tool, {}, ['ask', 'ask', 'block', 'allow']]),
  ...['read_project_file', 'search_project_content', 'web_search', 'search_memory', 'spawn_sub_agent', 'delegate_task'].map(tool => [tool, {}, ['allow', 'allow', 'allow', 'allow']]),
  ...['write_project_file', 'write_file', 'apply_patch', 'edit_project_files', 'move_project_file', 'save_memory', 'update_plan'].map(tool => [tool, {}, ['allow', 'allow', 'block', 'allow']]),
  ['lsp_definition', {}, ['allow', 'block', 'block', 'allow']],
  ['get_project_plans', {}, ['allow', 'allow', 'allow', 'allow']],
  ['unknown_tool', {}, ['block', 'ask', 'block', 'allow']],
  ['manage_mcp_servers', { action: 'search' }, ['allow', 'allow', 'allow', 'allow']],
  ['manage_mcp_servers', { action: 'restart' }, ['allow', 'ask', 'block', 'allow']],
  ['find_and_prepare_mcp_tools', {}, ['allow', 'ask', 'allow', 'allow']],
];
for (const [tool, args, decisions] of rows) {
  test(`${tool} ${JSON.stringify(args)} across all modes`, () => {
    modes.forEach((mode, i) => {
      const input = { tool, args, mode, workspaceRoot: workspace, native: true };
      const result = decideToolApproval(input);
      assert.equal(result.decision, decisions[i], mode);
      assert.equal(typeof result.reason, 'string');
      if (result.decision === 'ask') assert.ok(result.reason.length > 0);
      // Phase 1: these new facts must not change a single decision.
      for (const facts of [
        { annotations: { readOnlyHint: true }, serverTrusted: true },
        { annotations: { destructiveHint: true }, serverTrusted: false },
        { checkpointCoverage: { complete: true } },
        { sandbox: { bwrapAvailable: true, netUnshared: true, profile: 'bwrap_workspace' } },
        { sandbox: { bwrapAvailable: false, netUnshared: false, profile: null } },
      ]) assert.deepEqual(decideToolApproval({ ...input, ...facts }), result);
    });
  });
}

test('casual-context normalized decisions and workspace requirements are unchanged', () => {
  for (const tool of ['execute_command', 'run_tests', 'generate_image', 'approve_mcp_mutation', 'unknown_tool'])
    assert.equal(decideToolApproval({ tool, mode: 'ask_approval', workspaceRoot: null }).decision, 'ask');
  for (const tool of ['write_project_file', 'move_project_file', 'delete_project_file', 'update_plan', 'get_project_plans', 'lsp_hover'])
    assert.equal(decideToolApproval({ tool, mode: 'ask_approval', workspaceRoot: null }).decision, 'block');
  for (const tool of ['save_memory', 'search_memory', 'spawn_sub_agent', 'web_search'])
    assert.equal(decideToolApproval({ tool, mode: 'ask_approval', workspaceRoot: null }).decision, 'allow');
  assert.equal(decideToolApproval({ tool: 'lsp_hover', mode: 'full_access' }).reason, 'LSP requires a project workspace.');
});

test('containment facts preserve outside-write and malformed-path treatment', () => {
  for (const mode of ['workspace_write', 'ask_approval']) {
    const input = { tool: 'write_project_file', mode, stage: 'containment' };
    assert.equal(decideToolApproval({ ...input, containment: { blocked: false } }).decision, 'allow');
    for (const reason of ['Execution blocked: Path escapes the project root.', 'Execution blocked: Symlink escapes the project root.']) {
      const result = decideToolApproval({ ...input, containment: { blocked: true, reason } });
      assert.equal(result.decision, mode === 'ask_approval' ? 'ask' : 'block');
      assert.ok(result.reason);
    }
    assert.equal(decideToolApproval({ ...input, containment: { blocked: true, reason: 'Invalid file path.' } }).decision, 'block');
  }
});

test('opaque Git and publication remain independent gates', () => {
  for (const tool of ['git_stage', 'git_unstage', 'git_stash', 'git_commit', 'git_create_branch', 'git_switch']) {
    assert.equal(decideToolApproval({ tool, stage: 'opaque_git', approved: false }).decision, 'ask');
    assert.equal(decideToolApproval({ tool, stage: 'opaque_git', approved: true }).decision, 'allow');
    assert.equal(decideToolApproval({ tool, stage: 'opaque_git', native: false }).decision, 'allow');
  }
  assert.equal(decideToolApproval({ tool: 'git_sync', stage: 'git_publication' }).decision, 'ask');
});

test('MCP heuristic and hard rules retain existing decisions despite trust/annotations', () => {
  for (const [tool, args, expected] of [
    ['read_records', {}, 'allow'], ['write_file', {}, 'allow'],
    ['read_records', { body: 'data' }, 'ask'], ['send_message', {}, 'ask'], ['publish', {}, 'ask'],
    ['read_records', { command: 'printf hello' }, 'ask'], ['delete_file', {}, 'ask'],
    ['push_files', {}, 'ask'], ['unknown_operation', {}, 'ask'],
  ]) {
    const input = { tool, args, native: false, mode: 'workspace_write', workspaceRoot: workspace, serverName: 'github' };
    const result = decideToolApproval(input);
    assert.equal(result.decision, expected, tool);
    assert.deepEqual(decideToolApproval({ ...input, annotations: { readOnlyHint: true }, serverTrusted: true }), result);
    assert.deepEqual(decideToolApproval({ ...input, annotations: { destructiveHint: true }, serverTrusted: true }), result);
    assert.equal(decideToolApproval({ ...input, mode: 'read_only' }).decision, 'block');
    assert.equal(decideToolApproval({ ...input, mode: 'ask_approval' }).decision, 'ask');
    assert.equal(decideToolApproval({ ...input, mode: 'full_access' }).decision, 'allow');
  }
});

test('dispatch preserves precedence, explicit consent, workspace SQL exemption and challenge scope', () => {
  const input = { stage: 'mcp_dispatch', mode: 'workspace_write', native: false, workspaceMcp: workspace };
  assert.match(decideToolApproval({ ...input, tool: 'delete_project_file' }).reason, /^File deletion/);
  assert.match(decideToolApproval({ ...input, tool: 'send_message' }).reason, /^Outbound/);
  assert.match(decideToolApproval({ ...input, tool: 'push_files' }).reason, /^Git commit/);
  assert.equal(decideToolApproval({ ...input, tool: 'write_file', mutationRequiresConfirmation: true }).decision, 'allow');
  for (const tool of ['delete_project_file', 'send_message', 'push_files'])
    assert.equal(decideToolApproval({ ...input, tool, approved: true }).decision, 'allow');
  const sql = { ...input, tool: 'write_file', workspaceMcp: false, mutationRequiresConfirmation: true };
  assert.equal(decideToolApproval(sql).route, 'mutation_challenge');
  assert.equal(decideToolApproval({ ...sql, approved: true }).route, 'mutation_challenge', 'generic approval must not replace a scoped challenge');
  assert.equal(decideToolApproval({ ...sql, mode: 'ask_approval', permissionGranted: true }).decision, 'allow');
  assert.equal(decideToolApproval({ ...sql, mode: 'full_access' }).decision, 'allow');
});

test('policy is deterministic and never mutates supplied facts', () => {
  const input = Object.freeze({ tool: 'read_records', args: Object.freeze({ body: 'value' }), mode: 'workspace_write',
    native: false, workspaceRoot: workspace, annotations: Object.freeze({ readOnlyHint: true }), serverTrusted: true });
  assert.deepEqual(decideToolApproval(input), decideToolApproval(input));
  assert.deepEqual(baseDecision({ capability: CAPABILITIES.EXTERNAL_MUTATION, mode: 'workspace_write', hasWorkspace: true }), { decision: 'allow' });
});

test('guard obtains the sandbox profile itself and passes facts without changing approval', async () => {
  const policy = require('../src/main/toolApprovalPolicy');
  const profile = require('../src/main/workspaceSandboxProfile');
  const guardPath = require.resolve('../src/main/toolPermissions');
  const cachedGuard = require.cache[guardPath];
  const originalDecide = policy.decideToolApproval;
  const originalProfile = profile.getWorkspaceSandboxProfile;
  const facts = Object.freeze({ bwrapAvailable: true, netUnshared: true, profile: 'bwrap_workspace' });
  const calls = [];
  policy.decideToolApproval = input => { calls.push(input); return originalDecide(input); };
  profile.getWorkspaceSandboxProfile = async input => { assert.equal(input.uncontained, false); return facts; };
  delete require.cache[guardPath];
  try {
    const { guardTool } = require('../src/main/toolPermissions');
    let prompts = 0;
    await guardTool({ name: 'execute_command', args: { command: 'printf ok', sandbox: { profile: 'forged' } },
      project: { root_path: process.cwd() }, permissionMode: 'workspace_write', requestApproval: () => { prompts++; return true; } });
    assert.equal(prompts, 1);
    assert.ok(calls.some(input => input.sandbox === facts));
  } finally {
    policy.decideToolApproval = originalDecide;
    profile.getWorkspaceSandboxProfile = originalProfile;
    delete require.cache[guardPath];
    if (cachedGuard) require.cache[guardPath] = cachedGuard;
  }
});

test('MCP annotations and explicit trust are read from the server catalog', () => {
  const { McpManager } = require('../src/main/mcpManager');
  const manager = new McpManager();
  const annotations = { readOnlyHint: true, destructiveHint: false };
  manager.servers.set('fixture', { tools: [{ name: 'read_records', annotations }], definition: {} });
  assert.deepEqual(manager.getApprovalFacts('fixture', 'read_records'), { annotations, serverTrusted: false });
  manager.servers.get('fixture').definition.trusted = true;
  assert.deepEqual(manager.getApprovalFacts('fixture', 'read_records'), { annotations, serverTrusted: true });
});
