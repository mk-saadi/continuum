import test from 'node:test';
import assert from 'node:assert/strict';
import { toolKind, toolVerb, summarizeStage } from '../src/lib/executionEvents.mjs';

test('no native tool renders as raw snake_case', () => {
  const verbs = {
    str_replace_editor: 'Edit',
    edit_project_files: 'Edit',
    apply_patch: 'Edit',
    write_project_file: 'Write',
    move_project_file: 'Move',
    delete_project_file: 'Delete',
    save_memory: 'Save',
    search_memory: 'Search',
    manage_mcp_servers: 'Manage MCP servers',
    approve_mcp_mutation: 'Approve MCP operation',
    execute_command: 'Run',
    read_project_file: 'Read',
    git_status: 'Git status',
    git_log: 'Git log',
    git_commit: 'Git commit',
    git_sync: 'Git sync',
    ask_user: 'Question',
    delegate_task: 'Subagent',
    update_plan: 'Plan',
  };
  for (const [name, verb] of Object.entries(verbs)) {
    assert.equal(toolVerb({ toolName: name }), verb, name);
    assert.doesNotMatch(toolVerb({ toolName: name }), /_/);
  }
});

test('batch edits and moves summarize with files, not raw names', () => {
  const stage = { events: [
    { type: 'tool_call', toolName: 'edit_project_files', status: 'complete',
      args: { edits: [{ relative_path: 'a.js' }, { relative_path: 'b.js' }] } },
    { type: 'tool_call', toolName: 'move_project_file', status: 'complete',
      args: { source_path: 'old.js', destination_path: 'new.js' } },
  ] };
  const summary = summarizeStage(stage);
  assert.ok(summary.files.includes('a.js') && summary.files.includes('old.js'));
  assert.match(summary.title, /Edited 4 files/);
});

test('git stages title the operation, mixed stages stay generic', async () => {
  const { summarizeStage: summarize, summarizeStep: stepSummary } = await import('../src/lib/executionEvents.mjs');
  const single = summarize({ events: [
    { type: 'tool_call', toolName: 'git_status', status: 'complete', args: {} },
  ] });
  assert.equal(single.title, 'Git status');
  const multi = summarize({ events: [
    { type: 'tool_call', toolName: 'git_status', status: 'complete', args: {} },
    { type: 'tool_call', toolName: 'git_log', status: 'complete', args: { limit: 3 } },
  ] });
  assert.equal(multi.title, '2 git operations');
  const mixed = summarize({ events: [
    { type: 'tool_call', toolName: 'read_project_file', status: 'complete',
      args: { relative_path: 'a.js' } },
    { type: 'tool_call', toolName: 'git_status', status: 'complete', args: {} },
  ] });
  assert.equal(mixed.title, '2 operations');
  assert.equal(
    stepSummary({ type: 'tool_call', toolName: 'git_commit', status: 'complete',
      args: { message: 'Add Midnight themes' } }).summary,
    '"Add Midnight themes"',
  );
  assert.equal(
    stepSummary({ type: 'tool_call', toolName: 'git_sync', status: 'complete',
      args: { action: 'push', remote: 'origin', branch: 'main' } }).summary,
    'push origin main',
  );
  assert.equal(
    stepSummary({ type: 'tool_call', toolName: 'git_log', status: 'complete', args: { limit: 3 } }).summary,
    'last 3',
  );
  assert.equal(
    stepSummary({ type: 'tool_call', toolName: 'git_status', status: 'complete', args: {} }).summary,
    '',
  );
});

test('MCP labels describe the action and keep server tools identifiable', async () => {
  const { toolDisplayName } = await import('../src/lib/executionEvents.mjs');
  assert.equal(toolDisplayName({ toolName: 'manage_mcp_servers', args: { action: 'inspect' } }), 'Inspect MCP server');
  assert.equal(toolDisplayName({ toolName: 'manage_mcp_servers', args: { action: 'activate' } }), 'Activate MCP tools');
  assert.equal(toolDisplayName({ toolName: 'browser_navigate', serverName: 'browsermcp' }), 'Browser navigate (browsermcp)');
  assert.equal(toolDisplayName({ toolName: 'fetch', serverName: 'fetch' }), 'Fetch');
});
