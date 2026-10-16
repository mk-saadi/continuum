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
    save_memory: 'Save',
    search_memory: 'Search',
    manage_mcp_servers: 'Servers',
    approve_mcp_mutation: 'Approve',
    execute_command: 'Run',
    read_project_file: 'Read',
    git_commit: 'Write',
    ask_user: 'Question',
    delegate_task: 'Subagent',
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
