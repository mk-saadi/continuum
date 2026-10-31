import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { classifyStep, isBlockedStep, summarizeStage } from '../src/lib/executionEvents.mjs';

const require = createRequire(import.meta.url);
const { guardTool } = require('../src/main/toolPermissions');

test('memory search never requests approval in any permission mode or chat context', async () => {
  for (const permissionMode of ['read_only', 'workspace_write', 'ask_approval', 'full_access']) {
    for (const project of [null, { root_path: process.cwd() }]) {
      await guardTool({ name: 'search_memory', native: true, permissionMode, project,
        args: { query: 'execution blocked approval denied full access' },
        requestApproval: () => { assert.fail(`Memory search requested approval in ${permissionMode}`); } });
    }
  }
});

test('recalled permission messages do not turn successful memory searches into approval requests', () => {
  for (const text of ['Execution blocked', 'approval denied', 'permission denied', 'requires a project', 'read only mode', 'ask for approval', 'full access']) {
    const step = { id: 'search', type: 'tool_call', toolName: 'search_memory', serverName: 'memory',
      status: 'success', result: `Past Chat Context found:\n[Session: old] assistant:\n${text}` };
    assert.equal(isBlockedStep(step), false, text);
    assert.equal(classifyStep(step).key, 'success', text);
    const summary = summarizeStage({ events: [step] });
    assert.equal(summary.blocked, 0, text);
    assert.equal(summary.status.includes('needs approval'), false, text);
  }
});

test('actual permission failures retain blocked classification', () => {
  const step = { type: 'tool_call', toolName: 'execute_command', status: 'error' };
  assert.equal(classifyStep({ ...step, error: 'Execution blocked: approval denied.' }).key, 'blocked');
  assert.equal(classifyStep({ ...step, result: 'Execution blocked: approval denied.' }).key, 'blocked');
});
