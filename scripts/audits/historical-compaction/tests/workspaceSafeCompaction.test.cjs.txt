'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-w3-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const { db } = storage;
const sessions = require('../src/main/sessionManager');
const engine = require('../src/main/engineManager');
const service = require('../src/main/workspaceCompaction');
const budget = require('../src/main/contextBudget');
const builder = require('../src/main/promptBuilder');
const checkpoints = require('../src/main/taskCheckpoints');
const project = require('../src/main/projectManager').createProject({ name: 'W3 disposable' });
const records = [];
let serial = 0;
function fixture() {
  const id = `w3-${++serial}`;
  sessions.getOrCreateSession(id, 'model', project.id);
  sessions.saveMessage(id, 'user', 'Fix the bug, preserve tests and do not publish.');
  sessions.saveMessage(id, 'assistant', 'Completed source inspection. '.repeat(4000));
  sessions.saveMessage(id, 'user', 'Keep the patch narrow.');
  const owner = new AbortController(); owner.runId = `run-${serial}`;
  engine.activeStreams.set(id, owner);
  const persistence = engine.createMessagePersistence({ sessionId: id, modelId: 'model', runId: owner.runId });
  const steps = [], tail = [];
  for (let i = 0; i < 5; i++) {
    const call = { id: `call-${i}`, type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ relative_path: `f${i}.js` }) } };
    const result = 'source output '.repeat(1000);
    steps.push({ id: call.id, type: 'tool_call', toolName: call.function.name, args: JSON.parse(call.function.arguments), status: 'complete', result });
    tail.push({ role: 'assistant', content: `Inspected f${i}.js`, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: result });
  }
  persistence.update({ content: 'Inspection completed', executionSteps: steps });
  const prefix = projection => builder.rebuildChatMessages({ sessionId: id, modelId: 'model', excludeMessageIds: [persistence.messageId], compactionProjection: projection });
  const tool = { type: 'function', function: { name: 'read_project_file', description: 'read fixture', parameters: { type: 'object' } } };
  const payload = { model: 'model', messages: [...prefix(null), ...tail], tools: [tool], max_tokens: 1024, stream: true };
  const measure = require('./fixtures/c9SummaryTokenizer.cjs').withSummaryTokenizer(async request => {
    const tokens = budget.approximateTokens(request);
    const budgetContract = budget.createRuntimeBudget({ runtimeContextTokens: 40000, payload: request, currentInputTokens: tokens, measurementMethod: 'server-template-tokenizer' });
    return { tokens, method: 'server-template-tokenizer', budgetContract, limit: 40000, budget: budgetContract.usableInputTokens };
  });
  const generate = async request => {
    const input = JSON.parse(request.messages[1].content);
    const draft = { objective: 'Fix bug without publishing', briefIds: input.briefs.map(b => b.id) };
    for (const key of require('../src/main/workspaceCompactCandidate').ARRAY_KEYS) draft[key] = [];
    draft.nextActions = ['Finish verification'];
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }], usage: { completion_tokens: 80 } };
  };
  const options = { sessionId: id, modelId: 'model', owner, messageId: persistence.messageId, tail, payload, measure, generate,
    isCurrent: () => true, force: true, buildRequest: async (projection, retained) => ({ ...payload, messages: [...prefix(projection), ...retained] }) };
  return { id, owner, persistence, options, steps, tail };
}
const history = id => JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(id));
test.after(() => {
  if (process.env.W3_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.W3_EVIDENCE_OUTPUT, JSON.stringify(records, null, 2));
  storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true });
});
test('W3 commits complete history, protects two rounds, retains durable originals and run identity', async () => {
  const f = fixture(), original = db.prepare('SELECT id, content, execution_steps FROM messages WHERE session_id = ?').all(f.id);
  const result = await service.compactAtBoundary(f.options);
  assert.equal(result.compressed, true);
  assert.equal(result.tail.length, 4);
  assert.equal(checkpoints.getLatestCheckpoint(f.id).checkpoint.lifecycle, 'w3-current');
  assert.equal(checkpoints.getLatestCheckpoint(f.id).checkpoint.projection.runId, f.owner.runId);
  assert.deepEqual(db.prepare('SELECT id, content, execution_steps FROM messages WHERE session_id = ?').all(f.id), original);
  assert.equal(db.prepare('SELECT archived FROM messages WHERE id = ?').get(f.persistence.messageId).archived, 0);
  assert.equal(service.paired(result.payload.messages), true);
  assert.equal(result.diagnostics.actualTokens, result.diagnostics.prospectiveTokens);
  const planning=require('../src/main/workspaceCompactionActivity').list(f.id).at(-1).metadata.planningSummary;
  assert.equal(planning.activationOutcome,'activated');assert.ok(planning.plannedReservations<=planning.generationPool);
  assert.ok(result.diagnostics.reductionTokens > 0);
  records.push({ name: 'safe-commit', ...result.diagnostics });
});
for (const stage of ['generation-start', 'prospective-build', 'transaction-start', 'candidate-promotion', 'message-archival', 'transaction-commit', 'post-commit-build']) {
  test(`W3 failure at ${stage} retains history and has no current checkpoint`, async () => {
    const f = fixture(), original = history(f.id);
    await assert.rejects(service.compactAtBoundary({ ...f.options, inject: value => { if (value === stage) throw new Error(stage); } }), new RegExp(stage));
    assert.equal(history(f.id), original);
    assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  });
}
test('W3 rejects truncation with one bounded retry', async () => {
  const f = fixture(), original = history(f.id); let calls = 0;
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async () => { calls++; return { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }; } }), /output-truncated/);
  assert.equal(calls, 2); assert.equal(history(f.id), original);
});
test('W3 stale steering or tool writes cannot commit', async () => {
  const f = fixture();
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async request => {
    db.prepare('UPDATE messages SET content = content || ? WHERE id = ?').run(' changed', f.persistence.messageId);
    return f.options.generate(request);
  } }), /concurrent-state-change/);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('W3 pending tool pair and pending approval fail closed', async () => {
  const f = fixture();
  await assert.rejects(service.compactAtBoundary({ ...f.options, tail: f.tail.slice(0, -1) }), /incomplete-tool-pair/);
  f.steps[0].status = 'pending'; f.persistence.update({ content: '', executionSteps: f.steps });
  await assert.rejects(service.compactAtBoundary(f.options), /pending-tool-operation/);
});
test('W3 capacity change and irreducible prospective overhead reject without archival', async () => {
  for (const mode of ['capacity', 'overhead']) {
    const f = fixture(), original = history(f.id); let calls = 0;
    await assert.rejects(service.compactAtBoundary({ ...f.options, measure: async payload => {
      const m = await f.options.measure(payload); calls++;
      if (payload.messages.some(message => message.taskCheckpoint)) {
        if (mode === 'capacity') m.budgetContract.capacityTokens--;
        else { m.tokens = m.budget + 1; m.budgetContract.currentInputTokens = m.tokens; }
      }
      return m;
    } }), /capacity-changed|prospective-context-overflow/);
    assert.equal(history(f.id), original);
  }
});
test('W3 cancellation, model/permission/schema invalidation stop commit', async () => {
  for (const mode of ['cancel', 'state']) {
    const f = fixture(); let current = true;
    await assert.rejects(service.compactAtBoundary({ ...f.options, isCurrent: () => current, generate: async request => {
      const answer = await f.options.generate(request);
      if (mode === 'cancel') f.owner.abort(); else current = false;
      return answer;
    } }), /unexpected-abort|invalid-safe-point|concurrent-state-change/);
    assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  }
});
test('Workspace legacy compression is disabled; no unvalidated fallback', async () => {
  const f = fixture();
  const result = await require('../src/main/compressionEngine').checkAndCompressContext({ sessionId: f.id, modelId: 'model', contextWindowLimit: 40000, llmSummarizeCallback: async () => 'unused', force: true });
  assert.equal(result.reason, 'workspace-safe-boundary-required');
});
function stream(call, text) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: call.function }] } : { content: text };
  return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}
test('deterministic coding loop crosses 90% after test output, compacts and completes the SAME run without tool replay', async () => {
  const { runMemoryChat, sanitizeChatMessages } = await import('../src/lib/memoryChat.mjs');
  const f = fixture();
  // Only this disposable session is modified. The test never touches a real repository.
  db.prepare("UPDATE messages SET content = 'Previous investigation', variants = NULL, estimated_tokens = 5 WHERE session_id = ? AND role = 'assistant' AND id != ?").run(f.id, f.persistence.messageId);
  const root = fs.mkdtempSync(path.join(directory, 'project-'));
  fs.writeFileSync(path.join(root, 'bug.js'), 'module.exports = 0;\n');
  const initial = builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model', excludeMessageIds: [f.persistence.messageId] });
  const calls = ['read_project_file', 'search_project', 'update_plan', 'write_project_file', 'read_project_file', 'run_tests', 'read_project_file'];
  const tools = [...new Set(calls)].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } }));
  const executed = [], outcomes = [], sizes = []; let count = 0, steps = [];
  const answer = await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'model', messages: initial, projectId: project.id,
    signal: f.owner.signal, chatTools: tools, samplingParams: { max_tokens: 1024 },
    onExecutionSteps: value => { steps = value; f.persistence.update({ content: 'Working on narrow fix', executionSteps: value }); },
    rebuildWorkspacePrefix: projection => builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model', excludeMessageIds: [f.persistence.messageId], compactionProjection: projection }),
    workspaceCompaction: async boundary => {
      assert.equal(engine.activeStreams.get(f.id), f.owner);
      const result = await service.compactAtBoundary({ ...f.options, ...boundary, force: false });
      if (result.compressed) outcomes.push(result.diagnostics);
      return result;
    },
    executeTool: async call => {
      executed.push(call.id);
      if (call.name === 'update_plan') {
        const plan = require('../src/main/workspacePlan').updatePlan(f.id, { action: 'create', objective: 'Fix narrow fixture bug',
          steps: [{ description: 'Inspect sources', status: 'completed' }, { description: 'Fix and test', status: 'in_progress' }] });
        assert.equal(plan.success, true); return plan;
      }
      if (call.name === 'write_project_file') fs.writeFileSync(path.join(root, 'bug.js'), 'module.exports = 1;\n');
      if (call.name === 'run_tests') {
        assert.equal(fs.readFileSync(path.join(root, 'bug.js'), 'utf8'), 'module.exports = 1;\n');
        return { exitCode: 0, stdout: 'ok fixture verifies bug is fixed\n'.repeat(1000) + '\n# tests 1\n# pass 1\n# fail 0' };
      }
      if (call.name === 'read_project_file') return { content: fs.readFileSync(path.join(root, 'bug.js'), 'utf8') + 'verified fixture observation '.repeat(700) };
      if (call.name === 'search_project') return { content: 'fixture search match '.repeat(900) };
      return { success: true };
    },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body); sizes.push((await f.options.measure(payload)).tokens);
      assert.equal(service.paired(payload.messages), true);
      assert.deepEqual(payload.tools, tools);
      assert.equal(engine.activeStreams.get(f.id).runId, f.owner.runId);
      const name = calls[count++];
      if (!name) return stream(null, 'Fixed the bug and verified the fixture test passes.');
      return stream({ id: `coding-${count}`, function: { name, arguments: JSON.stringify(name === 'run_tests' ? { command: 'fixture-test' } : { relative_path: 'bug.js' }) } });
    },
  });
  assert.match(answer, /verified/);
  assert.equal(executed.length, calls.length);
  assert.equal(new Set(executed).size, calls.length);
  assert.equal(executed.filter(id => id === 'coding-4').length, 1);
  assert.equal(executed.filter(id => id === 'coding-6').length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'bug.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(steps.filter(s => s.type === 'tool_call').length, calls.length);
  assert.equal(checkpoints.getLatestCheckpoint(f.id).checkpoint.plan.objective, 'Fix narrow fixture bug');
  assert.equal(require('../src/main/workspacePlan').getPlan(f.id).objective, 'Fix narrow fixture bug');
  assert.equal(outcomes.length, 1);
  assert.ok(sizes[0] < outcomes[0].triggerTokens);
  assert.ok(outcomes.every(o => o.beforeTokens >= o.triggerTokens));
  assert.ok(sizes.every(size => size <= 40000 - 1152));
  records.push({ name: 'same-run-coding-loop', runIdentityPreserved: true, executedTools: executed.length,
    duplicateExecutions: executed.length - new Set(executed).size, outcomes, dispatchedInputTokens: sizes, finalAnswerVerified: true });
});
for (const delta of [-1, 0, 1, 5000]) {
  test(`W3 C1 threshold boundary ${delta < 0 ? 'below' : delta === 0 ? 'at' : 'above'} 90% (${delta})`, async () => {
    const f = fixture(); let generations = 0;
    const result = await service.compactAtBoundary({ ...f.options, force: false,
      measure: async payload => {
        const m = await f.options.measure(payload);
        if (payload === f.options.payload) {
          m.tokens = m.budgetContract.autoCompactionTriggerTokens + delta;
          m.budgetContract.currentInputTokens = m.tokens;
        }
        return m;
      }, generate: async request => { generations++; return f.options.generate(request); } });
    assert.equal(result.compressed, delta >= 0);
    assert.equal(generations, delta >= 0 ? 1 : 0);
  });
}
test('W3 repeated compactions preserve earlier current-run evidence and never reuse authority', async () => {
  const f = fixture();
  const first = await service.compactAtBoundary(f.options);
  const newTail = [...first.tail];
  for (let i = 5; i < 8; i++) {
    const call = { id: `call-${i}`, type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ relative_path: `f${i}.js` }) } };
    const result = 'new source output '.repeat(600);
    f.steps.push({ id: call.id, type: 'tool_call', toolName: 'read_project_file', args: { relative_path: `f${i}.js` }, status: 'complete', result });
    newTail.push({ role: 'assistant', content: 'Inspect next source', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: result });
  }
  f.persistence.update({ content: 'More inspection', executionSteps: f.steps });
  const secondPayload = { ...first.payload, messages: [...first.payload.messages, ...newTail.slice(first.tail.length)] };
  const second = await service.compactAtBoundary({ ...f.options, payload: secondPayload, tail: newTail });
  assert.equal(second.compressed, true);
  const checkpoint = checkpoints.getLatestCheckpoint(f.id);
  assert.deepEqual(checkpoint.checkpoint.projection.consumedToolIds, ['call-0', 'call-1', 'call-2', 'call-3', 'call-4', 'call-5']);
  assert.ok(checkpoint.checkpoint.evidence.some(e => e.stepId === 'call-0'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workspace_checkpoints WHERE session_id = ? AND status = 'current'").get(f.id).n, 1);
  assert.equal(checkpoint.checkpoint.pending.authority, 'none; revalidate permissions on execution');
});
test('W3 current image, attachment metadata, MCP schemas and steering tail remain in the measured request', async () => {
  const f = fixture();
  const image = { role: 'user', content: [{ type: 'text', text: 'Current attachment: fixture.png; keep current constraint' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture', detail: 'high' } }] };
  const mcp = { type: 'function', function: { name: 'fixture_mcp', description: 'read fixture', parameters: { type: 'object' } } };
  f.options.tail.push(image); f.options.payload.messages.push(image); f.options.payload.tools.push(mcp);
  const result = await service.compactAtBoundary({ ...f.options, mcpToolNames: ['fixture_mcp'] });
  assert.ok(result.compressed);
  assert.deepEqual(result.tail.at(-1), image);
  assert.deepEqual(result.payload.tools.at(-1), mcp);
  assert.ok(result.diagnostics.activatedMcpSchemaTokens > 0);
  assert.equal(result.diagnostics.measurementMethod, 'server-template-tokenizer');
  assert.equal(result.diagnostics.actualTokens, result.diagnostics.prospectiveTokens);
});
test('W3 post-commit semantic mismatch compensates and never supplies a dispatch payload', async () => {
  const f = fixture(), original = history(f.id); let builds = 0;
  await assert.rejects(service.compactAtBoundary({ ...f.options, buildRequest: async (...args) => {
    const payload = await f.options.buildRequest(...args);
    if (++builds === 2) payload.tools = [];
    return payload;
  } }), /post-commit-mismatch/);
  assert.equal(history(f.id), original);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('W3 coalesces the same simultaneous source request into one generation and commit', async () => {
  const f = fixture(); let generations = 0;
  const options = { ...f.options, generate: async request => { generations++; return f.options.generate(request); } };
  const [a, b] = await Promise.all([service.compactAtBoundary(options), service.compactAtBoundary(options)]);
  assert.equal(a.checkpointId, b.checkpointId); assert.equal(generations, 1);
});
test('W3 a new authoritative brief during generation invalidates the source', async () => {
  const f = fixture();
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async request => {
    sessions.saveMessage(f.id, 'user', 'New steering requirement: preserve the public API.');
    return f.options.generate(request);
  } }), /stale-task-brief/);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  assert.ok(require('../src/main/taskBriefs').getApplicableBriefs(f.id).some(b => b.content_text.includes('public API')));
});
test('W3 H1 deletion preempts an active candidate and cannot recreate history', async () => {
  const f = fixture();
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async request => {
    const response = await f.options.generate(request);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(f.id);
    return response;
  } }), /deleted-conversation/);
  assert.equal(db.prepare('SELECT * FROM sessions WHERE id = ?').get(f.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workspace_checkpoints WHERE session_id = ?').get(f.id).n, 0);
});
test('W3 budget-measurement and prospective-build failures preserve source without a checkpoint', async () => {
  for (const mode of ['measurement', 'build']) {
    const f = fixture(), original = history(f.id);
    await assert.rejects(service.compactAtBoundary({ ...f.options,
      measure: mode === 'measurement' ? async () => { throw new Error('measurement unavailable'); } : f.options.measure,
      buildRequest: mode === 'build' ? async () => { throw new Error('prospective unavailable'); } : f.options.buildRequest,
    }), /unavailable/);
    assert.equal(history(f.id), original); assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  }
});
test('W3 an unincorporated steering instruction earlier in the live tail stays verbatim', async () => {
  const f = fixture();
  const steering = { role: 'user', content: 'User steering instruction received during this run:\nKeep the ABI stable.' };
  f.options.tail.unshift(steering);
  f.options.payload.messages.splice(f.options.payload.messages.length - 10, 0, steering);
  const result = await service.compactAtBoundary(f.options);
  assert.ok(result.compressed);
  assert.deepEqual(result.tail[0], steering);
  assert.equal(service.paired(result.payload.messages), true);
});
test('W3 active child streams defer parent compaction without touching child evidence', async () => {
  const f = fixture();
  const children = require('../src/main/subagents/sessionManager');
  const originalList = children.listChildren;
  const child = { parentSessionId: f.id, status: 'waiting', transcript: ['child-owned-evidence'], permissionMode: 'read_only' };
  children.listChildren = id => id === f.id ? [child] : [];
  try {
    await assert.rejects(service.compactAtBoundary(f.options), /pending-child-operation/);
    assert.deepEqual(child.transcript, ['child-owned-evidence']);
    assert.equal(child.permissionMode, 'read_only');
    assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  } finally { children.listChildren = originalList; }
});
test('W3 reads the durable background record shape, allows delivered completion and protects pending events', async () => {
  for (const state of ['running', 'queued', 'delivered']) {
    const f = fixture();
    const record = { status: state === 'running' ? 'running' : 'completed',
      ended_at: state === 'running' ? null : '2026-10-24T00:00:00Z', notification_state: state === 'running' ? 'pending' : state };
    db.prepare('INSERT INTO background_commands(command_id, session_id, workspace, record) VALUES (?, ?, ?, ?)')
      .run(`background-${f.id}`, f.id, directory, JSON.stringify(record));
    if (state === 'delivered') assert.equal((await service.compactAtBoundary(f.options)).compressed, true);
    else {
      await assert.rejects(service.compactAtBoundary(f.options), /pending-background-operation/);
      assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
    }
  }
});
test('W3 defers a pending child barrier while the current request still fits instead of ending the run', async () => {
  const f = fixture();
  const children = require('../src/main/subagents/sessionManager'), original = children.listChildren;
  children.listChildren = () => [{ status: 'running' }];
  let generationCalls = 0;
  try {
    const result = await service.compactAtBoundary({ ...f.options, force: false, measure: async payload => {
      const m = await f.options.measure(payload);
      m.tokens = m.budgetContract.autoCompactionTriggerTokens;
      m.budgetContract.currentInputTokens = m.tokens; return m;
    }, generate: async () => { generationCalls++; } });
    assert.equal(result.deferred, true);
    assert.equal(result.reason, 'pending-child-operation');
    assert.equal(generationCalls, 0);
    assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
    assert.equal(f.owner.signal.aborted, false);
  } finally { children.listChildren = original; }
});

function optionalFailure(f, { finalTokens = 82169, estimated = false, mutate = () => {} } = {}) {
  let calls = 0;
  return { ...f.options, force: false,
    inject: stage => { if (stage === 'optional-fallback-build') mutate(); },
    generate: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{bad Gemma JSON}' } }] }),
    measure: async request => {
      const tokens = ++calls === 1 ? 82169 : request.messages[0]?.content?.includes('Create a Workspace') ? 1000 : finalTokens;
      const method = estimated && !request.messages[0]?.content?.includes('Create a Workspace') ? 'approximate-full-request' : 'server-template-tokenizer';
      const budgetContract = budget.createRuntimeBudget({ runtimeContextTokens: 90112, payload: request, currentInputTokens: tokens, measurementMethod: method });
      return { tokens, method, budgetContract, limit: 90112, budget: budgetContract.usableInputTokens };
    } };
}
test('C6-A optional invalid candidate safely continues only after final exact fit, with original pairs and no checkpoint', async () => {
  const f = fixture(), original = history(f.id);
  const result = await service.compactAtBoundary(optionalFailure(f));
  assert.equal(result.optionalContinued, true); assert.equal(result.compressed, false);
  assert.equal(result.diagnostics.beforeTokens, 82169); assert.equal(result.diagnostics.triggerTokens, 80064);
  assert.equal(result.diagnostics.usableInputTokens, 88960);
  assert.deepEqual(result.tail, f.tail); assert.equal(service.paired(result.payload.messages), true);
  assert.equal(history(f.id), original); assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  await result.validateDispatch();
  require('./../src/main/lspExecutionContext').invalidateRules([f.id]);
  await assert.rejects(result.validateDispatch(), /runtime-state-changed/);
});
for (const [name, change, code] of [
  ['oversized', { finalTokens: 90000 }, 'prospective-context-overflow'],
  ['estimated', { estimated: true }, 'optional-fallback-measurement-unavailable'],
]) test(`C6-A optional fallback rejects ${name} final request`, async () => {
  const f = fixture(), original = history(f.id);
  await assert.rejects(service.compactAtBoundary(optionalFailure(f, change)), { code });
  assert.equal(history(f.id), original); assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
for (const name of ['cancel', 'delete', 'source', 'permission', 'owner']) test(`C6-A ${name} during fallback prevents dispatch`, async () => {
  const f = fixture();
  const mutate = () => {
    if (name === 'cancel') f.owner.abort(Object.assign(new Error('stop'), { code: 'user-cancelled' }));
    if (name === 'delete') db.prepare('INSERT INTO deleted_sessions(id) VALUES (?)').run(f.id);
    if (name === 'source') db.prepare('UPDATE messages SET content = content || ? WHERE id=?').run('changed', f.persistence.messageId);
    if (name === 'permission') require('../src/main/lspExecutionContext').invalidateRules([f.id]);
    if (name === 'owner') engine.activeStreams.set(f.id, new AbortController());
  };
  await assert.rejects(service.compactAtBoundary(optionalFailure(f, { mutate })));
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});

test('C8 bounded refinement persists the exact inspected continuation without reactivating history', async () => {
  const f = fixture(); let generations = 0;
  const result = await service.compactAtBoundary({ ...f.options, softTargetTokens: 100,
    generate: async request => {
      generations++;
      const response = await f.options.generate(request);
      const draft = JSON.parse(response.choices[0].message.content);
      const input = JSON.parse(request.messages[1].content);
      draft.research = input.evidence.map(e => ({text:'Recorded source inspection',sources:[{messageId:e.messageId,stepId:e.stepId}]}));
      response.choices[0].message.content = JSON.stringify(draft); return response;
    } });
  assert.equal(result.diagnostics.refinementPasses, 1);
  assert.equal(result.diagnostics.refinementSavedTokens, 0); // C9 already excludes previews.
  assert.equal(generations, 1);
  const row = checkpoints.getLatestCheckpoint(f.id);
  assert.equal(row.checkpoint.summaryFormat, 'c9-markdown');
  assert.equal(checkpoints.workspaceCompactSection(row.checkpoint).content, row.checkpoint.savedWorkingState);
  const display = require('../src/main/contextInspection').getCheckpointHistoryForDisplay(f.id, 1, row.id);
  assert.equal(display.checkpoints[0].workingState.content, row.checkpoint.savedWorkingState);
  assert.equal(display.checkpoints[0].workingState.consumedToolCount, 3);
  assert.equal(display.checkpoints[0].workingState.representation, 'exact-persisted-continuation');
  assert.equal(result.diagnostics.actualTokens, (await f.options.measure(result.payload)).tokens);
  assert.equal(result.diagnostics.tokensUntilNextTrigger, result.diagnostics.actualBudgetContract.autoCompactionTriggerTokens-result.diagnostics.actualTokens);
  assert.ok(result.diagnostics.protectedContextMeasurement.tokens > 0);
  assert.equal(result.diagnostics.afterMeasuredComposition.totalTokens, result.diagnostics.actualTokens);
  // Viewing a historical version is a SELECT, including outside the normal page.
  db.prepare("UPDATE workspace_checkpoints SET status='superseded' WHERE id=?").run(row.id);
  const historical = require('../src/main/contextInspection').getCheckpointHistoryForDisplay(f.id, 1, row.id);
  assert.equal(historical.checkpoints[0].workingState.content,row.checkpoint.savedWorkingState);
  assert.equal(checkpoints.getLatestCheckpoint(f.id),null);
});

test('C8 unchanged already covered same-run evidence never regenerates', async () => {
  const f=fixture(); const first=await service.compactAtBoundary(f.options);
  const second=await service.compactAtBoundary({...f.options,payload:first.payload,generate:()=>assert.fail('Covered evidence must not regenerate')});
  assert.equal(second.compressed,false);assert.equal(second.reason,'no-reducible-history');
  assert.equal(second.diagnostics.targetReason,'unchanged-evidence-already-covered');
});

test('C8 oversized provider output fails closed with explicit measured overflow', async () => {
  const f=fixture(), before=history(f.id);let calls=0;
  await assert.rejects(service.compactAtBoundary({...f.options,generate:async request=>{
    calls++;const response=await f.options.generate(request);response.usage.completion_tokens=request.max_tokens+1;return response;
  }}),{code:'output-budget-exceeded'});
  assert.equal(calls,2);assert.equal(history(f.id),before);assert.equal(checkpoints.getLatestCheckpoint(f.id),null);
});

test('C8 inspection redacts secrets, scopes historical lookup and respects deletion',async()=>{
  const f=fixture();const result=await service.compactAtBoundary(f.options);
  const row=checkpoints.getLatestCheckpoint(f.id);const saved=row.checkpoint.savedWorkingState;
  const changed={...row.checkpoint,savedWorkingState:saved+'\napi_key=sk-fixture-sensitive-secret'};
  db.prepare('UPDATE workspace_checkpoints SET checkpoint_json=? WHERE id=?').run(JSON.stringify(changed),row.id);
  const inspect=require('../src/main/contextInspection');
  const display=inspect.getCheckpointForDisplay(f.id).checkpoint;
  assert.equal(display.workingState.redacted,true);assert.doesNotMatch(JSON.stringify(display),/sk-fixture-sensitive-secret/);
  const other=fixture();assert.equal(inspect.getCheckpointHistoryForDisplay(other.id,1,result.checkpointId).checkpoints.length,0);
  db.prepare('INSERT INTO deleted_sessions(id) VALUES (?)').run(f.id);
  assert.equal(inspect.getCheckpointForDisplay(f.id).checkpoint,null);
  assert.equal(inspect.getCheckpointHistoryForDisplay(f.id,1,result.checkpointId).checkpoints.length,0);
});

for (const mode of ['over-limit', 'unavailable', 'changed-before-activation']) test(`C9 owning activation refuses ${mode} summary without archival`, async () => {
  const f = fixture(), before = history(f.id); let probes = 0, generations = 0;
  await assert.rejects(service.compactAtBoundary({ ...f.options,
    measure: async request => {
      if (request.messages[0]?.content?.startsWith?.('# Working Summary')) {
        probes++;
        return { tokens: mode === 'changed-before-activation' && probes === 1 ? 4999 : 5000,
          method: mode === 'unavailable' ? 'approximate-full-request' : 'server-template-tokenizer' };
      }
      return f.options.measure(request);
    }, generate: async request => { generations++; return f.options.generate(request); },
  }), { code: mode === 'unavailable' ? 'compaction-summary-tokenizer-unavailable' : 'compaction-summary-budget-exceeded' });
  assert.equal(generations, mode === 'over-limit' ? 2 : 1);
  assert.equal(history(f.id), before); assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('C9 owning continuation persists measured summary, one injected copy and event token metadata', async () => {
  const f = fixture(), result = await service.compactAtBoundary(f.options);
  const cp = checkpoints.getLatestCheckpoint(f.id).checkpoint;
  const contents = result.payload.messages.map(m => m.content).filter(c => typeof c === 'string').join('\n');
  assert.equal(contents.split(cp.savedWorkingState).length - 1, 1);
  assert.equal(cp.summaryMeasurement.digest, require('../src/main/compactionSummary').digest(cp.savedWorkingState));
  assert.ok(cp.summaryMeasurement.tokens <= 4999);
  const event = require('../src/main/workspaceCompactionActivity').list(f.id).at(-1);
  assert.equal(event.metadata.summaryTokens, cp.summaryMeasurement.tokens);
  assert.equal(event.metadata.summaryTokenMethod, 'server-template-tokenizer');
  assert.ok(result.diagnostics.afterComposition.categories.checkpoint.bytes > 0);
});

// C9.2 uses the real candidate validator, not a stubbed failure result.
function rejectedFinding(f, changes = {}) {
  const base = optionalFailure(f, changes);
  let calls = 0;
  return { ...base, measure: async request => request.messages.length === 1 && request.messages[0].role === 'assistant'
    ? { tokens: 100, limit: 90112, method: 'server-template-tokenizer' } : base.measure(request), generate: async request => {
    calls++;
    const response = await f.options.generate(request);
    const draft = JSON.parse(response.choices[0].message.content);
    draft.research = [{ text: 'Inspected source', evidenceQuote: 'fabricated excerpt',
      sources: [{ messageId: f.persistence.messageId, stepId: 'call-0' }] }];
    response.choices[0].message.content = JSON.stringify(draft);
    return response;
  }, calls: () => calls };
}
test('C9.2 rejected finding continues only with measured fit, retains prior checkpoint/history, and suppresses identical retry', async () => {
  const f = fixture();
  await service.compactAtBoundary(f.options);
  const prior = checkpoints.getLatestCheckpoint(f.id), original = history(f.id);
  // A new durable boundary is required after the successful checkpoint.
  sessions.saveMessage(f.id, 'user', 'Continue the unfinished review.');
  const saved = history(f.id), options = rejectedFinding(f);
  const first = await service.compactAtBoundary(options);
  assert.equal(first.optionalContinued, true);
  assert.equal(first.reason, 'unsupported-finding-claim');
  assert.equal(options.calls(), 2); // one bounded correction
  await first.validateDispatch();
  const second = await service.compactAtBoundary(options);
  assert.equal(second.optionalContinued, true);
  assert.equal(second.diagnostics.generationRetrySuppressed, true);
  assert.equal(options.calls(), 2);
  await second.validateDispatch();
  assert.equal(history(f.id), saved);
  assert.deepEqual(checkpoints.getLatestCheckpoint(f.id), prior);
  assert.equal(service.paired(second.payload.messages), true);
  assert.notEqual(saved, original);
  assert.equal(require('../src/main/workspaceCompactionActivity').list(f.id).at(-1).code, 'unsupported-finding-claim');
});
for (const [name, changes, code] of [
  ['overflow', { finalTokens: 90000 }, 'prospective-context-overflow'],
  ['estimated', { estimated: true }, 'optional-fallback-measurement-unavailable'],
]) test(`C9.2 rejected finding blocks ${name} continuation`, async () => {
  const f = fixture(), original = history(f.id), options = rejectedFinding(f, changes);
  await assert.rejects(service.compactAtBoundary(options), { code });
  assert.equal(options.calls(), 2);
  assert.equal(history(f.id), original);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
for (const name of ['cancel', 'delete', 'permission', 'owner']) test(`C9.2 ${name} blocks rejected-finding fallback`, async () => {
  const f = fixture();
  const options = rejectedFinding(f, { mutate: () => {
    if (name === 'cancel') f.owner.abort();
    if (name === 'delete') db.prepare('INSERT INTO deleted_sessions(id) VALUES (?)').run(f.id);
    if (name === 'permission') require('../src/main/lspExecutionContext').invalidateRules([f.id]);
    if (name === 'owner') engine.activeStreams.set(f.id, new AbortController());
  } });
  await assert.rejects(service.compactAtBoundary(options));
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('C9.2 changed request retries bounded generation; cached rejection never caches fit authorization', async () => {
  const f = fixture(), options = rejectedFinding(f);
  const result = await service.compactAtBoundary(options);
  assert.equal(options.calls(), 2);
  const changed = { ...options, payload: { ...options.payload, temperature: .25 } };
  await service.compactAtBoundary(changed);
  assert.equal(options.calls(), 4);
  require('../src/main/lspExecutionContext').invalidateRules([f.id]);
  await assert.rejects(result.validateDispatch(), /runtime-state-changed/);
});

function stageFailure(f, changes = {}) {
  // Inject the retired C9.5 error at the adapter boundary to preserve recovery
  // compatibility checks. New preflight feasibility is tested separately; the
  // historical zero-dispatch failure is retained in the frozen replay evidence.
  for (let i = 0; i < 13; i++) sessions.saveMessage(f.id, 'assistant', `Durable completed observation ${i}`);
  const base = optionalFailure(f, changes);
  let calls = 0;
  return { ...base, generate: async () => { calls++; throw Object.assign(Error('injected legacy stage failure'), { code: 'generation-stage-budget' }); },
    measure: async request => {
      if (request.messages[0]?.content?.includes('Create a Workspace')) {
        const input = JSON.parse(request.messages[1].content);
        return { tokens: input.messages.length > 1 ? 90000 : 1000, limit: 90112, method: 'server-template-tokenizer' };
      }
      return base.measure(request);
    }, calls: () => calls };
}
test('C9.5 stage-budget optional failure continues without replay, caches rejection but rechecks dispatch', async () => {
  const f = fixture(), options = stageFailure(f), original = history(f.id);
  const result = await service.compactAtBoundary(options);
  assert.equal(result.optionalContinued, true); assert.equal(result.reason, 'generation-stage-budget');
  await result.validateDispatch(); result.markContinued();
  const event = require('../src/main/workspaceCompactionActivity').list(f.id).at(-1);
  assert.equal(event.status, 'continued'); assert.equal(event.metadata.generationBudgetDiagnostics.providerRequestsAttempted, 1);
  assert.equal(event.metadata.continuationDiagnostics.reason, 'authoritative-original-request-fits');
  const second = await service.compactAtBoundary(options);
  assert.equal(second.diagnostics.generationRetrySuppressed, true); await second.validateDispatch();
  assert.equal(options.calls(), 1); assert.equal(history(f.id), original);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null); assert.deepEqual(result.tail, f.tail);
});
for (const [name, changes, code] of [
  ['overflow', { finalTokens: 90000 }, 'prospective-context-overflow'],
  ['estimated', { estimated: true }, 'optional-fallback-measurement-unavailable'],
  ['forced', {}, 'generation-stage-budget'],
]) test(`C9.5 stage-budget failure blocks ${name} continuation and preserves durable history`, async () => {
  const f = fixture(), options = stageFailure(f, changes), original = history(f.id);
  if (name === 'forced') options.force = true;
  await assert.rejects(service.compactAtBoundary(options), { code });
  assert.equal(options.calls(), 1); assert.equal(history(f.id), original);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  const event = require('../src/main/workspaceCompactionActivity').list(f.id).at(-1);
  assert.equal(event.status, 'failed');
  assert.equal(event.metadata.continuationDiagnostics.reason, name === 'forced' ? 'forced-compaction' : code);
});
test('C9.5 late permission change refuses stage-budget continuation and records the refusal', async () => {
  const f = fixture(), options = stageFailure(f), original = history(f.id);
  const result = await service.compactAtBoundary(options);
  require('../src/main/lspExecutionContext').invalidateRules([f.id]);
  await assert.rejects(result.validateDispatch(), { code: 'runtime-state-changed' });
  const event = require('../src/main/workspaceCompactionActivity').list(f.id).at(-1);
  assert.equal(event.status, 'failed');
  assert.equal(event.metadata.continuationDiagnostics.reason, 'runtime-state-changed');
  assert.equal(history(f.id), original); assert.equal(options.calls(), 1);
});

for (const phase of ['prospective-build','post-commit-build','dispatch']) test(`authoritative continuation measurement is required at ${phase}`, async () => {
 const f=fixture(),original=history(f.id);let unavailable=false;
 const options={...f.options,inject:stage=>{if(stage===phase)unavailable=true;},measure:async request=>{
   const value=await f.options.measure(request);
   return unavailable && request.tools?.length?{...value,method:'approximate-full-request'}:value;
 }};
 if(phase==='dispatch') {
   const result=await service.compactAtBoundary(options);unavailable=true;
   await assert.rejects(result.validateDispatch(),{code:'continuation-measurement-unavailable'});
 } else {
   await assert.rejects(service.compactAtBoundary(options),{code:'continuation-measurement-unavailable'});
   assert.equal(checkpoints.getLatestCheckpoint(f.id),null);
   assert.equal(history(f.id),original);
 }
});
