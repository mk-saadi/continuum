import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatArgFields,
  isTestCommand,
  languageOfPath,
  splitStages,
  summarizeStage,
  toolKind,
  toolVerb,
} from '../src/lib/executionEvents.mjs';

const tool = (toolName, args = {}, status = 'complete', extra = {}) => ({
  id: `s-${toolName}-${Math.random()}`,
  type: 'tool_call',
  toolName,
  status,
  args,
  result: null,
  ...extra,
});
const thought = (id, durationMs = null) => ({ id, type: 'thought', content: 'plan', durationMs });

test('splitStages groups tools at thought boundaries and preserves order', () => {
  const steps = [
    tool('read_project_file', { relative_path: 'a.js' }),
    thought('t1', 18000),
    tool('search_project_content', { query: 'session_' }),
    tool('read_project_file', { relative_path: 'b.js' }),
    thought('t2'),
    tool('execute_command', { command: 'npm test' }),
  ];
  const stages = splitStages(steps);
  assert.equal(stages.length, 3);
  assert.equal(stages[0].thought, null);
  assert.equal(stages[0].events.length, 1);
  assert.equal(stages[1].thought.id, 't1');
  assert.equal(stages[1].events.map((s) => s.toolName).join(','), 'search_project_content,read_project_file');
  assert.equal(stages[2].thought.id, 't2');
  assert.equal(stages[2].events.length, 1);
});

test('summarizeStage counts exploration from recorded events only', () => {
  const stages = splitStages([
    thought('t1', 18000),
    tool('search_project_content', { query: 'a' }),
    tool('search_project_content', { query: 'b' }),
    tool('read_project_file', { relative_path: 'a.js' }),
    tool('read_project_file', { relative_path: 'b.js' }),
  ]);
  const summary = summarizeStage(stages[0]);
  assert.equal(summary.title, 'Explored 2 files, 2 searches');
  assert.equal(summary.ops, 4);
  assert.equal(summary.elapsedMs, 18000);
  assert.deepEqual(summary.status, []);
});

test('summarizeStage reports failures without inventing timing', () => {
  const stages = splitStages([
    tool('execute_command', { command: 'ls' }),
    tool('execute_command', { command: 'rm -rf /' }, 'error', { error: 'Command failed: boom' }),
  ]);
  const summary = summarizeStage(stages[0]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 0);
  assert.equal(summary.elapsedMs, null);
  assert.match(summary.status.join(' '), /1 failed/);
});

test('summarizeStage recognizes permission denials as approval blocks', () => {
  const stages = splitStages([
    tool('write_project_file', { relative_path: 'x.ts', content: 'a' }, 'error', { error: 'Permission denied' }),
  ]);
  const summary = summarizeStage(stages[0]);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.failed, 0);
  assert.match(summary.status.join(' '), /needs approval/);
});

test('toolKind and verb map known tools and keep raw names for others', () => {
  assert.equal(toolKind({ toolName: 'execute_command' }), 'command');
  assert.equal(toolKind({ toolName: 'str_replace_editor' }), 'edit');
  assert.equal(toolKind({ toolName: 'write_project_file' }), 'write');
  assert.equal(toolKind({ toolName: 'mystery_mcp_tool' }), 'other');
  assert.equal(toolVerb({ toolName: 'execute_command' }), 'Run');
  assert.equal(toolVerb({ toolName: 'mystery_mcp_tool' }), 'mystery_mcp_tool');
});

test('formatArgFields surfaces salient fields without full content', () => {
  const fields = formatArgFields(tool('write_project_file', { relative_path: 'a/b.ts', content: Array(10).fill('x').join('\n') }));
  const path = fields.find((f) => f.label === 'Path');
  assert.equal(path.value, 'a/b.ts');
  assert.match(fields.find((f) => f.label === 'Content').value, /10 lines/);
  const cmd = formatArgFields(tool('execute_command', { command: 'grep -rn foo', cwd: '/p' }));
  assert.equal(cmd[0].value, 'grep -rn foo');
});

test('isTestCommand only matches recorded test-runner commands', () => {
  assert.equal(isTestCommand(tool('execute_command', { command: 'npx vitest run' })), true);
  assert.equal(isTestCommand(tool('execute_command', { command: 'grep -rn foo src' })), false);
  assert.equal(isTestCommand(tool('read_project_file', { relative_path: 'a' })), false);
});

test('languageOfPath labels known extensions and stays empty otherwise', () => {
  assert.equal(languageOfPath('src/a.tsx'), 'tsx');
  assert.equal(languageOfPath('Makefile'), '');
});
