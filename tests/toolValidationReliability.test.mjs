import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemoryChat, sanitizeChatMessages } from '../src/lib/memoryChat.mjs';
import { formatToolResult } from '../src/lib/toolResultFormatter.mjs';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-validation-'));
const root = path.join(directory, 'workspace');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'future-plans.md'), '# Backlog\nPending work\n');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle() {}, removeHandler() {} } };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db');
database.initDatabase(directory);
const { agentTools, executeAgentTool } = require('../src/main/tools/agentTools');
const { createProjectToolLoopGuard, rewindFailedTurnRange, failedToolReason, createToolFailureCircuitBreaker } = require('../src/main/engineManager');
const { validationSummary } = require('../src/lib/toolValidation.cjs');
const { buildTurnDigest } = require('../src/main/turnDigest');
const project = require('../src/main/projectManager').createProject({ name: 'Validation', root_path: root });
require('../src/main/sessionManager').getOrCreateSession('validation-session', 'fixture-model', project.id);
assert.equal(require('../src/main/workspacePlan').updatePlan('validation-session', { action: 'create', objective: 'Validate backlog', steps: [{ description: 'Inspect backlog' }] }).success, true);
const dispatch = (name, args) => executeAgentTool({ name, arguments: args, sessionId: 'validation-session', permissionMode: 'workspace_write' });
test.after(() => {
  database.closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});
const scenarios = [
  { name: 'read_project_file', code: 'INVALID_READ_SOURCE',
    bad: { end_line: 200, expected_content_hash: `sha256:${'a'.repeat(64)}` },
    changed: { end_line: 400, if_content_hash: `sha256:${'b'.repeat(64)}` },
    corrected: { relative_path: 'future-plans.md', end_line: 2 }, field: /relative_path/ },
  { name: 'update_plan', code: 'EMPTY_UPDATE', bad: { action: 'update', expected_revision: 1 },
    changed: { action: 'update', expected_revision: 2 }, corrected: { action: 'update', objective: 'Validated backlog status' }, field: /steps/ },
  { name: 'edit_project_files', code: 'EDIT_ARGUMENT_INVALID',
    bad: { edits: '[{"relative_path":"future-plans.md","old_str":"x","new_str":"y"}]' },
    changed: { edits: '[{"relative_path":"other.md","old_str":"a","new_str":"b"}]' },
    corrected: { edits: [{ relative_path: 'future-plans.md', old_str: '# Backlog', new_str: '# Updated backlog' }] }, field: /array/ },
  { name: 'spawn_sub_agent', code: 'SUBAGENT_TARGET_REQUIRED',
    bad: { task: `Read ${root}/future-plans.md` }, changed: { task: `Summarize ${root}/future-plans.md`, constraint: 'Concise' },
    corrected: { task: 'Summarize', target_file: path.join(root, 'future-plans.md') }, field: /target_file/ },
];

test('authoritative dispatch rejects observed invalid shapes with actionable typed results', async () => {
  for (const scenario of scenarios) {
    const output = await dispatch(scenario.name, scenario.bad);
    assert.equal(output.success, false);
    assert.equal(output.code, scenario.code);
    assert.equal(output.error_type, 'validation');
    assert.match(output.suggested_action, scenario.field);
    assert.match(failedToolReason(output, scenario.name), new RegExp(scenario.code));
    const formatted = formatToolResult(output, scenario.name, { nativeTool: scenario.name });
    const wire = sanitizeChatMessages([
      { role: 'assistant', tool_calls: [call('failure', scenario.name, scenario.bad)] },
      { role: 'tool', tool_call_id: 'failure', content: formatted.content },
    ]);
    assert.match(wire[1].content, new RegExp(scenario.code));
    assert.match(wire[1].content, /suggested_action/);
  }
  assert.equal(fs.readFileSync(path.join(root, 'future-plans.md'), 'utf8'), '# Backlog\nPending work\n');
});

test('file source alternatives remain enforced and schemas retain guidance in compact profile', async () => {
  const { compact } = require('../src/main/nativeToolActivation');
  const read = agentTools.find(tool => tool.function.name === 'read_project_file');
  assert.equal(read.function.parameters.allOf[0].oneOf.length, 2);
  assert.match(compact(read).function.description, /exactly one of relative_path or attachment_id/);
  const plan = compact(agentTools.find(tool => tool.function.name === 'update_plan'));
  assert.match(plan.function.description, /expected_revision alone/);
  const result = await dispatch('read_project_file', { relative_path: 'future-plans.md', attachment_id: 'unused' });
  assert.equal(result.code, 'INVALID_READ_SOURCE');
  assert.equal((await dispatch('read_project_file', { relative_path: 'future-plans.md' })).success, true);
});

test('semantic retry protection groups the same invalid shape, permits corrections and distinct work', async () => {
  for (const scenario of scenarios) {
    const guard = createProjectToolLoopGuard(project.id);
    const output = await dispatch(scenario.name, scenario.bad);
    assert.equal(guard.inspect(scenario.name, scenario.bad), null);
    guard.record(scenario.name, scenario.bad, output);
    assert.equal(guard.inspect(scenario.name, scenario.changed), null);
    guard.record(scenario.name, scenario.changed, output);
    assert.match(guard.inspect(scenario.name, { ...scenario.changed, ...(scenario.name === 'read_project_file' ? { end_line: 600 } : {}) }), /VALIDATION RETRY BLOCKED/);
    assert.equal(guard.inspect(scenario.name, scenario.corrected), null, 'corrected shape can execute');
    assert.equal(guard.inspect('git_status', {}), null, 'distinct work is allowed');
    guard.record('git_status', {}, { success: true });
    assert.equal(guard.inspect(scenario.name, scenario.bad), null, 'successful distinct work resets failure streak');
  }
  const guard = createProjectToolLoopGuard(project.id);
  const absent = { success: false, code: 'EDIT_TARGET_NOT_FOUND', error: 'no match' };
  for (let i = 0; i < 2; i++) guard.record('edit_project_files', scenarios[2].corrected, absent);
  assert.equal(guard.inspect('edit_project_files', { edits: [{ relative_path: 'other.md', old_str: 'different', new_str: 'text' }] }), null);
});

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = calls => Response.json({ choices: [{ message: { content: calls.length ? '' : 'Done.', tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });

test('wire replay retains causes after failure rewind, blocks changed invalid retries, and executes corrected calls', async () => {
  // File analysis is isolated here: use the real selector/validator and stub
  // only the child's inference, never start a model or write a live session.
  const runtime = require('../src/main/subagents');
  const original = runtime.runFileAnalysis;
  runtime.runFileAnalysis = async () => 'Summary of backlog';
  try {
    for (const scenario of scenarios) {
      const requests = [], dispatched = [], steps = [];
      await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture-model', projectId: project.id,
        messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Inspect the backlog.' }],
        chatTools: agentTools.filter(tool => [scenario.name, 'git_status'].includes(tool.function.name)),
        resolveTool: name => ({ toolName: name, serverName: 'native' }),
        rewindFailedTurnRange, failedToolReason, projectToolLoopGuard: createProjectToolLoopGuard(project.id),
        toolFailureCircuitBreaker: createToolFailureCircuitBreaker(),
        executeTool: async tool => { dispatched.push(tool); return dispatch(tool.name, JSON.parse(tool.arguments)); },
        onExecutionSteps: current => { steps.splice(0, steps.length, ...structuredClone(current)); },
        fetchImpl: async (_url, options) => {
          requests.push(JSON.parse(options.body));
          if (requests.length === 1) return reply([call('bad-1', scenario.name, scenario.bad)]);
          if (requests.length === 2) return reply([call('bad-2', scenario.name, scenario.changed)]);
          if (requests.length === 3) return reply([call('bad-3', scenario.name, scenario.bad), call('corrected', scenario.name, scenario.corrected)]);
          return reply([]);
        },
      });
      assert.equal(dispatched.length, 3, 'two rejections plus one corrected dispatch');
      assert.match(requests[2].messages[0].content, new RegExp(scenario.code));
      assert.match(requests[2].messages[0].content, /do not infer an outage/);
      assert.equal(requests[2].messages.filter(message => message.role === 'tool').length, 0, 'error-pair rewind still applies');
      assert.match(requests[3].messages.find(message => message.tool_call_id === 'bad-3').content, /VALIDATION RETRY BLOCKED/);
      assert.equal(steps.find(step => step.id === 'corrected').status, 'complete');
      assert.equal(steps.find(step => step.id === 'bad-3').status, 'error');
    }
  } finally { runtime.runFileAnalysis = original; }
});

test('edit source mismatch stays a zero-write rejection with recovery guidance', async () => {
  const before = fs.readFileSync(path.join(root, 'future-plans.md'), 'utf8');
  const output = await dispatch('edit_project_files', { edits: [{ relative_path: 'future-plans.md', old_str: 'INVENTED SOURCE TEXT', new_str: 'replacement' }] });
  assert.equal(output.code, 'EDIT_TARGET_NOT_FOUND');
  assert.equal(output.zero_writes, true);
  assert.match(validationSummary(output, 'edit_project_files'), /Read a small relevant source range/);
  assert.equal(fs.readFileSync(path.join(root, 'future-plans.md'), 'utf8'), before);
});

test('resumed work logs prefer real validation causes over saved generic banners', () => {
  assert.equal(validationSummary({ success: false, code: '__proto__' }), null);
  assert.equal(validationSummary({ success: false, code: 'EMPTY_UPDATE' }, 'constructor'), null);
  for (const scenario of scenarios) {
    const result = { success: false, code: scenario.code, error: 'sensitive value sk-secretvalue123456' };
    const digest = buildTurnDigest([{ type: 'tool_call', toolName: scenario.name, args: scenario.bad, status: 'error',
      error: 'A tool call failed.', result }], { turnSeq: 1 });
    assert.match(JSON.stringify(digest), new RegExp(scenario.code));
    assert.doesNotMatch(JSON.stringify(digest), /sk-secretvalue123456/);
    assert.doesNotMatch(validationSummary(result, scenario.name), /sensitive value/);
    const breaker = createToolFailureCircuitBreaker({ maxConsecutiveToolFailures: 1 });
    breaker.record(result, scenario.name, true);
    assert.match(breaker.abortReason, new RegExp(scenario.code));
  }
});
