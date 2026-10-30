import test from 'node:test';
import assert from 'node:assert/strict';
import { toolKind, toolVerb, summarizeStage } from '../src/lib/executionEvents.mjs';

test('no native tool renders as raw snake_case', () => {
  const verbs = {
    str_replace_editor: 'Replace text',
    edit_project_files: 'Edit files',
    apply_patch: 'Apply patch',
    write_project_file: 'Write file',
    move_project_file: 'Move file',
    delete_project_file: 'Delete file',
    save_memory: 'Save memory',
    search_memory: 'Search memory',
    execute_command: 'Shell',
    read_project_file: 'Read file',
    git_status: 'Git status',
    git_log: 'Git log',
    git_commit: 'Git commit',
    git_sync: 'Sync remote',
    ask_user: 'Ask user',
    delegate_task: 'Delegate task',
    update_plan: 'Update plan',
    // Previously-colliding generic verbs now differ per tool.
    search_project_content: 'Search project',
    web_search: 'Web search',
    run_tests: 'Run test',
  };
  for (const [name, verb] of Object.entries(verbs)) {
    assert.equal(toolVerb({ toolName: name }), verb, name);
    assert.doesNotMatch(toolVerb({ toolName: name }), /_/);
  }
  // Kind verbs stay distinct across the previously-ambiguous pairs.
  assert.notEqual(toolVerb({ toolName: 'search_project_content' }), toolVerb({ toolName: 'web_search' }));
  assert.notEqual(toolVerb({ toolName: 'read_project_file' }), toolVerb({ toolName: 'search_project_content' }));
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

test('native tool display names are distinct human-readable labels', async () => {
  const { toolDisplayName, NATIVE_TOOL_LABELS } = await import('../src/lib/executionEvents.mjs');
  const labels = Object.values(NATIVE_TOOL_LABELS);
  assert.equal(new Set(labels).size, labels.length, 'labels must be unique');
  assert.ok(labels.every((label) => !label.includes('_')), 'no raw snake_case');
  // Previously-ambiguous tools no longer share a display name.
  assert.notEqual(toolDisplayName({ toolName: 'search_project_content' }), toolDisplayName({ toolName: 'web_search' }));
  assert.equal(toolDisplayName({ toolName: 'search_project_content' }), 'Search project');
  assert.equal(toolDisplayName({ toolName: 'web_search' }), 'Web search');
  assert.equal(toolDisplayName({ toolName: 'search_memory' }), 'Search memory');
  assert.equal(toolDisplayName({ toolName: 'get_recent_chat_history' }), 'Chat history');
  assert.equal(toolDisplayName({ toolName: 'read_project_file' }), 'Read file');
  assert.equal(toolDisplayName({ toolName: 'str_replace_editor' }), 'Replace text');
  assert.equal(toolDisplayName({ toolName: 'execute_command' }), 'Shell');
  // Unknown native names fall back to the recorded identifier.
  assert.equal(toolDisplayName({ toolName: 'some_future_tool' }), 'some_future_tool');
});
