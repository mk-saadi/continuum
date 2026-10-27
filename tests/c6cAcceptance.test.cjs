'use strict';
// Real files/Node test process, production agent loop + atomic compaction;
// scripted inference and approximate token counts, deliberately NOT real-model acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), { spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-c6c-coding-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return originalLoad.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager'), engine = require('../src/main/engineManager');
const builder = require('../src/main/promptBuilder'), budget = require('../src/main/contextBudget');
const service = require('../src/main/workspaceCompaction'), checkpoints = require('../src/main/taskCheckpoints');
const candidate = require('../src/main/workspaceCompactCandidate'), evidence = require('../src/main/workspaceEvidence');
const { executeAgentTool } = require('../src/main/tools/agentTools');
const root = path.join(directory, 'taskflow'); fs.mkdirSync(root);
const project = require('../src/main/projectManager').createProject({ name: 'C6-C disposable TaskFlow', root_path: root });
const report = { inference: 'scripted controlled provider', measurement: 'approximate-full-request', toolExecutions: [], compactions: [], testRuns: [], generations: [], requests: [] };
test.after(() => {
  if (process.env.C6C_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.C6C_EVIDENCE_OUTPUT, JSON.stringify(report, null, 2));
  storage.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true });
});
test('C6-C real coding operations preserve failing and passing evidence across three atomic same-run compactions', async () => {
  fs.writeFileSync(path.join(root, 'queue.cjs'), '// C6C_CRITICAL: IDs must remain monotonic after deletion; never use array length.\nlet nextId = 1;\nconst tasks = [];\nexports.add = title => { const task = { id: tasks.length + 1, title }; tasks.push(task); return task; };\nexports.remove = id => { const i = tasks.findIndex(t => t.id === id); if (i >= 0) tasks.splice(i, 1); };\n');
  fs.appendFileSync(path.join(root, 'queue.cjs'), '// Historical task import format and queue migration documentation.\n'.repeat(1000));
  fs.writeFileSync(path.join(root, 'queue.test.cjs'), "const test=require('node:test'),assert=require('node:assert/strict'),q=require('./queue.cjs'); test('monotonic IDs after deletion',()=>{const a=q.add('a'),b=q.add('b');q.remove(a.id);assert.equal(q.add('c').id,b.id+1);});\n");
  const id = 'c6c-coding'; sessions.getOrCreateSession(id, 'fixture-model', project.id);
  sessions.saveMessage(id, 'user', 'Fix TaskFlow duplicate IDs. Preserve monotonic IDs after deletion, reproduce with a test, apply a narrow edit, verify and do not publish.');
  const owner = new AbortController(); owner.runId = 'c6c-same-run'; engine.activeStreams.set(id, owner);
  const persistence = engine.createMessagePersistence({ sessionId: id, modelId: 'fixture-model', runId: owner.runId });
  const prefix = projection => builder.rebuildChatMessages({ sessionId: id, modelId: 'fixture-model', excludeMessageIds: [persistence.messageId], compactionProjection: projection });
  const measure = async payload => {
    const tokens = budget.approximateTokens(payload), contract = budget.createRuntimeBudget({ runtimeContextTokens: 65536, payload, currentInputTokens: tokens });
    return { tokens, method: 'approximate-full-request', budgetContract: contract, limit: 65536, budget: contract.usableInputTokens };
  };
  const calls = [
    ['read_project_file', { relative_path: 'queue.cjs' }],
    ['run_tests', { command: 'node --test queue.test.cjs' }],
    ['str_replace_editor', { relative_path: 'queue.cjs', old_str: 'id: tasks.length + 1', new_str: 'id: nextId++' }],
    ['read_project_file', { relative_path: 'queue.cjs' }],
    ['run_tests', { command: 'node --test queue.test.cjs' }],
    ['read_project_file', { relative_path: 'queue.cjs' }],
    ['get_recent_chat_history', { source_step_id: 'coding-1' }],
    ['read_project_file', { relative_path: 'queue.cjs' }],
  ];
  const tools = [...new Set(calls.map(c => c[0]))].map(name => ({ type: 'function', function: { name, description: 'Controlled acceptance operation', parameters: { type: 'object' } } }));
  let dispatched = 0;
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  try {
    const answer = await runMemoryChat({ modelId: 'fixture-model', baseUrl: 'http://fixture.invalid', projectId: project.id,
      signal: owner.signal, messages: prefix(), chatTools: tools, samplingParams: { max_tokens: 1024 },
      onExecutionSteps: steps => persistence.update({ content: 'Working on monotonic IDs', executionSteps: steps }), rebuildWorkspacePrefix: prefix,
      workspaceCompaction: async boundary => {
        const force = [4, 6, 8].includes(report.toolExecutions.length) && report.compactions.length < 3;
        const boundaryStart = performance.now();
        const result = await service.compactAtBoundary({ ...boundary, sessionId: id, modelId: 'fixture-model', owner,
          messageId: persistence.messageId, isCurrent: () => true, force, measure,
          generate: async request => {
            const start = performance.now(), input = JSON.parse(request.messages[1].content);
            const draft = { objective: 'Fix monotonic TaskFlow IDs without publishing', briefIds: input.briefs.map(b => b.id) };
            for (const key of candidate.ARRAY_KEYS) draft[key] = [];
            draft.nextActions = ['Review verification evidence before concluding'];
            draft.blockers = ['Earlier failing test must remain available alongside later verification'];
            report.generations.push({ inputEstimate: budget.approximateTokens(request), reservedOutput: request.max_tokens, controlledDraftConstructionMs: performance.now() - start, newSourceIds: input.messages.map(m => m.id) });
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] };
          } });
        if (result.compressed) report.compactions.push({ ...result.diagnostics, acceptanceWallMilliseconds: performance.now() - boundaryStart });
        return result;
      },
      executeTool: async call => {
        report.toolExecutions.push({ id: call.id, name: call.name });
        if (call.name === 'run_tests') {
          // Execute a real Node subprocess in the disposable workspace. This adapter
          // does not claim production shell/permission dispatch coverage.
          const subprocessEnv = { ...process.env }; delete subprocessEnv.NODE_TEST_CONTEXT;
          const run = spawnSync(process.execPath, ['--test', 'queue.test.cjs'], { cwd: root, encoding: 'utf8', env: subprocessEnv });
          assert.ifError(run.error);
          report.testRuns.push({ id: call.id, exitCode: run.status, stdout: run.stdout });
          assert.equal(run.status, report.testRuns.length === 1 ? 1 : 0);
          return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
        }
        const result = await executeAgentTool({ name: call.name, arguments: call.arguments, sessionId: id, permissionMode: 'workspace_write' });
        assert.notEqual(result.success, false, JSON.stringify(result)); return result;
      },
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body); assert.ok(service.paired(request.messages));
        // Only synthetic fixture prompts, opt-in capture for C6-D composition QA.
        if (process.env.C6D_REQUEST_CAPTURE) require('node:fs').appendFileSync(process.env.C6D_REQUEST_CAPTURE, JSON.stringify({ afterTools: report.toolExecutions.length, request }) + '\n');
        report.requests.push({ afterTools: report.toolExecutions.length, serializedBytes: Buffer.byteLength(JSON.stringify(request)), inputEstimate: budget.approximateTokens(request), criticalFactVisible: JSON.stringify(request).includes('C6C_CRITICAL') });
        if (report.compactions.length) {
          assert.match(JSON.stringify(request), /C6C_CRITICAL/);
          assert.match(JSON.stringify(request), /monotonic/);
          assert.match(JSON.stringify(request), /coding-2/);
        }
        const entry = calls[dispatched++];
        const message = entry ? { tool_calls: [{ id: `coding-${dispatched}`, type: 'function', function: { name: entry[0], arguments: JSON.stringify(entry[1]) } }] } : { content: 'Verified monotonic IDs [TASK COMPLETE]' };
        return Response.json({ choices: [{ message, finish_reason: entry ? 'tool_calls' : 'stop' }] });
      } });
    assert.deepEqual(report.testRuns.map(r => r.exitCode), [1, 0]);
    assert.match(answer, /Verified/); assert.equal(report.compactions.length, 3);
    assert.equal(report.toolExecutions.length, 8); assert.equal(new Set(report.toolExecutions.map(c => c.id)).size, 8);
    const checkpoint = checkpoints.getLatestCheckpoint(id).checkpoint;
    assert.equal(checkpoint.projection.runId, owner.runId);
    assert.match(JSON.stringify(checkpoint.evidence), /C6C_CRITICAL/);
    assert.match(evidence.retrieve(id, { source_step_id: 'coding-2' }).text, /not ok/);
    assert.match(evidence.retrieve(id, { source_step_id: 'coding-5' }).text, /# pass 1/);
    assert.match(evidence.retrieve(id, { source_step_id: 'coding-3' }).text, /nextId/);
    report.originalResultsRetrieved = 4; report.duplicateExecutions = 0;
    report.sameRunId = owner.runId; report.outcome = 'pass';
  } finally { engine.activeStreams.delete(id); }
});
