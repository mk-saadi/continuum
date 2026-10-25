'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-w4-'));
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
  const measure = async request => {
    const tokens = budget.approximateTokens(request);
    const budgetContract = budget.createRuntimeBudget({ runtimeContextTokens: 40000, payload: request, currentInputTokens: tokens });
    return { tokens, method: 'approximate-full-request', budgetContract, limit: 40000, budget: budgetContract.usableInputTokens };
  };
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
  if (process.env.W4_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.W4_EVIDENCE_OUTPUT, JSON.stringify(records, null, 2));
  storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true });
});
const backgrounds = require('../src/main/backgroundCommands');
async function runningBackground(f) {
  const context = { runId: f.owner.runId, sessionId: f.id, workspace: directory, signal: f.owner.signal };
  backgrounds.openRun(context);
  let finish;
  const handle = backgrounds.start(context, 'synthetic test; no shell launched', 10000,
    async () => new Promise(resolve => { finish = resolve; }), () => {});
  await Promise.resolve();
  return { context, handle, finish: () => finish({ status: 'completed', exitCode: 0, stdout: 'ok synthetic test' }) };
}
test('W4 background handle stays live across compaction and completion is consumed once', async () => {
  const f = fixture(), operation = await runningBackground(f);
  try {
    const result = await service.compactAtBoundary(f.options);
    assert.ok(result.compressed);
    const checkpoint = checkpoints.getLatestCheckpoint(f.id).checkpoint;
    assert.equal(checkpoint.pending.operations[0].id, operation.handle.command_id);
    assert.equal(backgrounds.status(operation.handle.command_id, operation.context).status, 'starting');
    await result.validateDispatch();
    operation.finish(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(result.validateDispatch, /concurrent-state-change|operation-state-changed/);
    const events = backgrounds.take(operation.context);
    assert.equal(events.length, 1);
    backgrounds.acknowledge(operation.context, events.map(event => event.id), true);
    assert.equal(backgrounds.take(operation.context).length, 0);
    records.push({ scenario: 'background-handle', runId: f.owner.runId, launches: 1, completionCount: events.length, ...result.diagnostics });
  } finally { operation.finish(); await backgrounds.closeRun(operation.context); }
});
test('W4 background completion during generation prevents stale commit', async () => {
  const f = fixture(), operation = await runningBackground(f);
  try {
    await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async request => {
      operation.finish(); await new Promise(resolve => setImmediate(resolve)); return f.options.generate(request);
    } }), /concurrent-state-change/);
    assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  } finally { operation.finish(); await backgrounds.closeRun(operation.context); }
});
test('W4 detached child with durable identity keeps its independent execution and transcript', async () => {
  const f = fixture(), children = require('../src/main/subagents/sessionManager');
  const child = children.createSession({ parentSessionId: f.id, model: 'model' });
  child.parentToolCallId = 'call-0'; child.status = 'running'; child.context = [{ role: 'user', content: 'Child-owned task' }];
  const attempt = require('../src/main/subagents/executionStore').createExecution({ sessionId: child.id, background: true });
  assert.equal(require('../src/main/subagents/persistence').persistChildRun(child), true);
  const original = JSON.stringify(child.context);
  const result = await service.compactAtBoundary(f.options);
  assert.ok(result.compressed);
  assert.equal(checkpoints.getLatestCheckpoint(f.id).checkpoint.pending.operations[0].executionId, attempt.id);
  assert.equal(JSON.stringify(child.context), original);
  assert.equal(attempt.status, 'running');
  child.status = 'completed';
  await assert.rejects(result.validateDispatch, /concurrent-state-change/);
  records.push({ scenario: 'detached-child', runId: f.owner.runId, childId: child.id, executionId: attempt.id, transcriptUnchanged: true, ...result.diagnostics });
});
test('W4 three successive compactions carry consumed identities and original evidence', async () => {
  const f = fixture();
  f.steps[0] = { ...f.steps[0], toolName: 'run_tests', args: { command: 'fixture-regression' }, result: { exitCode: 1, stdout: 'not ok 7 - exact W4 regression identity\n# fail 1' } };
  f.persistence.update({ content: 'Unresolved failed test', executionSteps: f.steps });
  const originalGenerate = f.options.generate; let generations = 0;
  f.options.generate = async request => {
    const envelope = await originalGenerate(request), draft = JSON.parse(envelope.choices[0].message.content);
    draft.blockers = ['Exact W4 regression remains unresolved'];
    if (!generations++) {
      draft.tests = [{ command: 'fixture-regression', stepRef: { messageId: f.persistence.messageId, stepId: 'call-0' } }];
      draft.decisions = [{ text: 'Preserve the public API', sources: [{ messageId: f.persistence.messageId }] }];
    }
    envelope.choices[0].message.content = JSON.stringify(draft); return envelope;
  };
  let options = f.options; const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const result = await service.compactAtBoundary(options); assert.ok(result.compressed); outcomes.push(result.diagnostics);
    const tail = [...result.tail];
    for (let i = 0; i < 3; i++) {
      const id = `round-${round}-${i}`, call = { id, type: 'function', function: { name: 'read_project_file', arguments: '{"relative_path":"next.js"}' } };
      f.steps.push({ id, type: 'tool_call', toolName: 'read_project_file', args: { relative_path: 'next.js' }, status: 'complete', result: 'source '.repeat(1000) });
      tail.push({ role: 'assistant', content: 'Read next', tool_calls: [call] }, { role: 'tool', tool_call_id: id, content: 'source '.repeat(1000) });
    }
    f.persistence.update({ content: 'Continuing same run', executionSteps: f.steps });
    options = { ...f.options, tail, payload: { ...result.payload, messages: [...result.payload.messages, ...tail.slice(result.tail.length)] } };
    const checkpoint = checkpoints.getLatestCheckpoint(f.id).checkpoint;
    assert.equal(checkpoint.projection.runId, f.owner.runId);
    assert.ok(checkpoint.evidence.some(record => record.stepId === 'call-0' && record.diagnostics.includes('not ok 7 - exact W4 regression identity')));
    assert.equal(checkpoint.tests[0].command, 'fixture-regression');
    assert.equal(checkpoint.tests[0].exitCode, 1);
    assert.equal(checkpoint.decisions[0].text, 'Preserve the public API');
    assert.equal(new Set(checkpoint.projection.consumedToolIds).size, checkpoint.projection.consumedToolIds.length);
  }
  records.push({ scenario: 'three-compactions', runId: f.owner.runId, outcomes });
});
test('W4 oversized generation uses bounded source-bound segments without activating intermediates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); engine.activeStreams.delete(f.id);
  db.prepare("UPDATE messages SET status = 'complete' WHERE id = ?").run(f.persistence.messageId);
  for (let i = 0; i < 25; i++) sessions.saveMessage(f.id, 'assistant', `Historical observation ${i}: ` + 'detail '.repeat(550));
  const w2 = require('../src/main/workspaceCompactCandidate');
  const result = await w2.generateWorkspaceCompactCandidate({ sessionId: f.id, modelId: 'model', capacityTokens: 18000, persist: false, generate: async (request, meta) => {
    for (let i = 0; i < 5; i++) { t.mock.timers.tick(30000); meta.onProgress(); assert.equal(meta.signal.aborted, false); }
    return f.options.generate(request);
  } });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.staged.segments.length > 1);
  assert.ok(result.diagnostics.staged.segments.length <= 12);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  assert.ok(result.candidate.evidence.some(record => record.stepId === 'call-0'));
  assert.deepEqual(result.candidate.briefIds, require('../src/main/taskBriefs').getApplicableBriefs(f.id).map(brief => brief.id));
  records.push({ scenario: 'long-horizon', ...result.diagnostics });
});
for (const apiType of ['anthropic', 'openai']) test(`W4 ${apiType === 'openai' ? 'OpenRouter' : 'Anthropic'} serialized cloud parent loop compacts and continues`, async () => {
  const f = fixture(), providers = require('../src/main/cloudProviders');
  const providerId = `w4-${apiType}`;
  providers.saveCloudProvider({ id: providerId, name: providerId, apiType,
    baseUrl: apiType === 'anthropic' ? 'https://anthropic.invalid/v1' : 'https://openrouter.ai/api/v1', apiKey: 'synthetic-key', modelId: 'fixture-model' });
  const target = { type: 'cloud', provider: providerId, model: 'fixture-model' };
  const metadata = async () => [{ providerId, modelId: target.model, contextLength: 40000 }];
  const measure = require('../src/main/promptMeasurement').createCloudWorkspaceMeasurer(target, { getMetadata: metadata });
  let turns = 0, generations = 0; const executions = [], measurements = [], compactions = [];
  const transport = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = apiType === 'anthropic' ? JSON.stringify(body.system) : JSON.stringify(body.messages.filter(m => m.role === 'system'));
    if (system.includes('Create a Workspace task-state candidate')) {
      generations++;
      const user = body.messages.find(m => m.role === 'user');
      const text = typeof user.content === 'string' ? user.content : user.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const response = await f.options.generate({ messages: [{}, { content: text }] });
      const content = response.choices[0].message.content;
      return new Response(JSON.stringify(apiType === 'anthropic' ? { stop_reason: 'end_turn', content: [{ type: 'text', text: content }], usage: { output_tokens: 80 } } : response));
    }
    if (apiType === 'anthropic') {
      const pending = new Set();
      for (const message of body.messages) for (const block of message.content) {
        if (block.type === 'tool_use') { assert.ok(!pending.has(block.id)); pending.add(block.id); }
        if (block.type === 'tool_result') assert.ok(pending.delete(block.tool_use_id));
      }
      assert.equal(pending.size, 0);
    } else assert.equal(service.paired(body.messages), true);
    turns++;
    const call = turns <= 7 ? { id: `cloud-${turns}`, type: 'function', function: { name: 'read_project_file', arguments: '{"relative_path":"fixture.js"}' } } : null;
    const data = apiType === 'anthropic' ? { stop_reason: call ? 'tool_use' : 'end_turn', content: call ? [{ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }] : [{ type: 'text', text: 'Finished fixture' }] }
      : { choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: { content: call ? '' : 'Finished fixture', ...(call ? { tool_calls: [call] } : {}) } }] };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const adapter = providers.createCloudFetch(target, { fetchImpl: transport, getMetadata: metadata, stream: false });
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const outcomes = await runMemoryChat({ baseUrl: 'https://fixture.invalid', modelId: 'model', cloud: true, casualMode: false,
    messages: builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model', excludeMessageIds: [f.persistence.messageId] }), projectId: project.id,
    signal: f.owner.signal, chatTools: f.options.payload.tools, samplingParams: { max_tokens: 1024 }, fetchImpl: async (url, options) => {
      measurements.push((await measure(JSON.parse(options.body))).tokens); return adapter(url, options);
    },
    onExecutionSteps: steps => f.persistence.update({ content: 'Working', executionSteps: steps }),
    rebuildWorkspacePrefix: projection => builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model', excludeMessageIds: [f.persistence.messageId], compactionProjection: projection }),
    workspaceCompaction: async boundary => {
      const result = await service.compactAtBoundary({ ...f.options, ...boundary, force: false, measure,
        generate: async (request, { signal }) => (await adapter('fixture:candidate', { body: JSON.stringify({ ...request, stream: false }), signal })).json() });
      if (result.compressed) compactions.push(result.diagnostics); return result;
    },
    executeTool: async call => { executions.push(call.id); return { content: 'observed fixture source '.repeat(700) }; },
  });
  assert.match(outcomes, /Finished/);
  assert.equal(executions.length, 7); assert.equal(new Set(executions).size, 7);
  assert.ok(compactions.length > 0); assert.ok(generations > 0);
  assert.equal(checkpoints.getLatestCheckpoint(f.id).checkpoint.projection.runId, f.owner.runId);
  records.push({ scenario: `cloud-${apiType}`, provider: providerId, model: target.model, runId: f.owner.runId, toolCalls: executions,
    inferenceRequests: turns, generations, measurements, compactions, protocol: 'validated', duplicateExecutions: 0 });
});
test('W4 unknown cloud capacity cannot certify a fit', async () => {
  const measure = require('../src/main/promptMeasurement').createCloudWorkspaceMeasurer({ provider: 'unknown', model: 'unknown' }, { getMetadata: async () => [], getProvider: () => ({}) });
  await assert.rejects(measure({ messages: [] }), /Unknown cloud model context capacity/);
});
test('W4 staged intermediate cancellation cannot activate a checkpoint', async () => {
  const f = fixture(); engine.activeStreams.delete(f.id);
  db.prepare("UPDATE messages SET status = 'complete' WHERE id = ?").run(f.persistence.messageId);
  for (let i = 0; i < 25; i++) sessions.saveMessage(f.id, 'assistant', 'history '.repeat(500));
  const signal = new AbortController(); let intermediate = 0;
  const result = await require('../src/main/workspaceCompactCandidate').generateWorkspaceCompactCandidate({ sessionId: f.id, modelId: 'model', capacityTokens: 18000,
    signal: signal.signal, generate: async (request, meta) => { if (meta.intermediate) { intermediate++; signal.abort(); } return f.options.generate(request); } });
  assert.equal(intermediate, 1); assert.equal(result.code, 'unexpected-abort');
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  assert.equal(db.prepare('SELECT is_compressing FROM sessions WHERE id = ?').get(f.id).is_compressing, 0);
});
test('W4 detached child settlement during generation invalidates the source barrier', async () => {
  const f = fixture(), children = require('../src/main/subagents/sessionManager');
  const child = children.createSession({ parentSessionId: f.id, model: 'model' });
  child.parentToolCallId = 'call-0'; child.status = 'running';
  require('../src/main/subagents/executionStore').createExecution({ sessionId: child.id, background: true });
  require('../src/main/subagents/persistence').persistChildRun(child);
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async request => {
    child.status = 'completed'; return f.options.generate(request);
  } }), /concurrent-state-change/);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('W4 dispatch capacity change rejects a committed payload', async () => {
  const f = fixture(); let changed = false;
  const result = await service.compactAtBoundary({ ...f.options, measure: async payload => {
    const measured = await f.options.measure(payload);
    if (changed) measured.budgetContract.capacityTokens--;
    return measured;
  } });
  changed = true; await assert.rejects(result.validateDispatch, /capacity-changed/);
});
test('W4 protocol validator rejects duplicate/out-of-order missing results and accepts complete parallel batches', () => {
  const a = { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(service.paired([a, { role: 'tool', tool_call_id: 'b' }, { role: 'tool', tool_call_id: 'a' }]), true);
  assert.equal(service.paired([a, { role: 'tool', tool_call_id: 'a' }]), false);
  assert.equal(service.paired([a, { role: 'tool', tool_call_id: 'a' }, { role: 'tool', tool_call_id: 'a' }]), false);
});
for (const kind of ['background', 'child', 'long-horizon']) test(`W4 full parent loop: ${kind}`, async () => {
  const f = fixture(), { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  db.prepare("UPDATE messages SET content = 'Earlier inspection', variants = NULL WHERE session_id = ? AND role = 'assistant' AND id != ?").run(f.id, f.persistence.messageId);
  if (kind === 'long-horizon') for (let i = 0; i < 40; i++) sessions.saveMessage(f.id, 'assistant', `Historical decision ${i}: ` + 'recorded detail '.repeat(260));
  const names = kind === 'long-horizon' ? Array(32).fill('read_project_file')
    : ['read_project_file', kind === 'background' ? 'execute_command' : 'spawn_sub_agent', ...Array(12).fill('read_project_file'), kind === 'background' ? 'get_command_status' : 'get_child_result'];
  const tools = [...new Set(names)].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } }));
  let next = 0, operation, child, attempt, settlementCount = 0;
  const executed = [], compactions = [], sizes = [];
  const bg = require('../src/main/subagents/backgroundStore');
  const onSettled = () => settlementCount++;
  bg.backgroundEvents.on('completed', onSettled);
  const prefix = projection => builder.rebuildChatMessages({ sessionId: f.id, modelId: 'model', excludeMessageIds: [f.persistence.messageId], compactionProjection: projection });
  try {
    const answer = await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'model', projectId: project.id, signal: f.owner.signal,
      messages: prefix(), chatTools: tools, samplingParams: { max_tokens: 1024 },
      onExecutionSteps: steps => f.persistence.update({ content: 'Working in same run', executionSteps: steps }),
      rebuildWorkspacePrefix: prefix,
      workspaceCompaction: async boundary => {
        const result = await service.compactAtBoundary({ ...f.options, ...boundary, force: false });
        if (result.compressed) {
          compactions.push(result.diagnostics);
          if (kind !== 'long-horizon') assert.ok(checkpoints.getLatestCheckpoint(f.id).checkpoint.pending.operations.length);
        }
        return result;
      },
      executeTool: async call => {
        executed.push(call.id);
        if (call.name === 'execute_command') { operation = await runningBackground(f); return operation.handle; }
        if (call.name === 'spawn_sub_agent') {
          child = require('../src/main/subagents/sessionManager').createSession({ parentSessionId: f.id, model: 'model' });
          child.parentToolCallId = call.id; child.status = 'running'; child.context = [{ role: 'user', content: 'Independent research' }];
          attempt = require('../src/main/subagents/executionStore').createExecution({ sessionId: child.id, background: true });
          require('../src/main/subagents/persistence').persistChildRun(child);
          bg.track({ childSessionId: child.id, executionId: attempt.id, controller: new AbortController(), kind: 'investigation' });
          return { childSessionId: child.id, executionId: attempt.id, status: 'running' };
        }
        if (call.name === 'get_command_status') {
          assert.ok(compactions.length); operation.finish(); await new Promise(resolve => setImmediate(resolve));
          const status = backgrounds.status(operation.handle.command_id, operation.context);
          assert.equal(status.exitCode, 0); return status;
        }
        if (call.name === 'get_child_result') {
          assert.ok(compactions.length); child.status = 'completed'; child.result = { text: 'Research evidence' };
          assert.equal(bg.settle(attempt.id, 'completed'), true); assert.equal(bg.settle(attempt.id, 'completed'), false);
          assert.equal(settlementCount, 1); return child.result;
        }
        return { content: 'verified source observation '.repeat(700) };
      },
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body); assert.equal(service.paired(payload.messages), true);
        sizes.push((await f.options.measure(payload)).tokens);
        const name = names[next++];
        const message = name ? { content: '', tool_calls: [{ id: `${kind}-${next}`, type: 'function', function: { name, arguments: '{"relative_path":"fixture.js"}' } }] } : { content: 'Completed the same task' };
        return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
      },
    });
    assert.match(answer, /Completed/); assert.equal(executed.length, names.length); assert.equal(new Set(executed).size, names.length);
    assert.ok(compactions.length >= (kind === 'long-horizon' ? 3 : 1), JSON.stringify(compactions));
    assert.ok(compactions.every(item => item.beforeTokens >= item.triggerTokens && item.prospectiveTokens === item.actualTokens));
    const activity = require('../src/main/workspaceCompactionActivity').list(f.id);
    const completedActivity = activity.filter(event => event.status === 'completed');
    assert.equal(completedActivity.length, compactions.length);
    assert.equal(new Set(completedActivity.map(event => event.id)).size, compactions.length);
    assert.ok(completedActivity.every(event => event.run_id === f.owner.runId && event.message_id === f.persistence.messageId && event.metadata.continued === true));
    assert.ok(completedActivity.every((event, index) => event.metadata.afterTokens === compactions[index].actualTokens));
    if (kind === 'long-horizon') assert.equal(completedActivity.length, 11);
    records.push({ scenario: `full-loop-${kind}`, runId: f.owner.runId, toolCalls: executed, inferenceRequests: next,
      duplicateExecutions: 0, childSettlements: settlementCount, compactions, dispatchedInputEstimates: sizes });
  } finally {
    bg.backgroundEvents.off('completed', onSettled);
    if (operation) { operation.finish(); await backgrounds.closeRun(operation.context); }
  }
});
for (const mode of ['intermediate-provider', 'intermediate-json', 'merge-provider', 'intermediate-source-change']) test(`W4 staged failure: ${mode}`, async () => {
  const f = fixture(); engine.activeStreams.delete(f.id);
  db.prepare("UPDATE messages SET status = 'complete' WHERE id = ?").run(f.persistence.messageId);
  for (let i = 0; i < 25; i++) sessions.saveMessage(f.id, 'assistant', 'source history '.repeat(250));
  let calls = 0;
  const result = await require('../src/main/workspaceCompactCandidate').generateWorkspaceCompactCandidate({ sessionId: f.id, modelId: 'model', capacityTokens: 18000,
    generate: async (request, meta) => {
      calls++;
      if ((mode === 'intermediate-provider' && meta.intermediate) || (mode === 'merge-provider' && !meta.intermediate)) throw new Error('Synthetic provider interruption');
      if (mode === 'intermediate-json' && meta.intermediate) return { choices: [{ finish_reason: 'stop', message: { content: '{' } }] };
      if (mode === 'intermediate-source-change' && meta.intermediate) sessions.saveMessage(f.id, 'user', 'New task revision');
      return f.options.generate(request);
    } });
  assert.equal(result.ok, false);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  assert.ok(calls <= 12 * 2);
  assert.equal(db.prepare('SELECT is_compressing FROM sessions WHERE id = ?').get(f.id).is_compressing, 0);
});
test('W4 pending approval on the owner blocks an otherwise completed protocol boundary', async () => {
  const f = fixture(); f.owner.toolApprovals = new Map([['pending-approval', () => {}]]);
  await assert.rejects(service.compactAtBoundary(f.options), /pending-tool-operation/);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});

test('W6 progressing local candidate exceeds 120 seconds and commits with same-run dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = await service.compactAtBoundary({ ...f.options, generate: async (request, meta) => {
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(30000); meta.onProgress(); assert.equal(meta.signal.aborted, false); }
    return f.options.generate(request);
  } });
  assert.ok(result.compressed); await result.validateDispatch(); result.markContinued();
  assert.equal(checkpoints.getLatestCheckpoint(f.id).checkpoint.projection.runId, f.owner.runId);
  assert.equal(service.paired(result.payload.messages), true);
});
for (const code of ['user-cancelled', 'deleted-conversation', 'generation-inactivity-timeout']) test(`W6 ${code} cannot archive or activate`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const before = db.prepare('SELECT id, archived FROM messages WHERE session_id = ? ORDER BY id').all(f.id);
  await assert.rejects(service.compactAtBoundary({ ...f.options, generate: async (request, meta) => {
    if (code === 'generation-inactivity-timeout') t.mock.timers.tick(600001);
    else f.owner.abort(require('../src/main/workspaceGenerationRuntime').reason(code));
    assert.equal(meta.signal.aborted, true);
    return f.options.generate(request);
  } }), { code });
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  assert.deepEqual(db.prepare('SELECT id, archived FROM messages WHERE session_id = ? ORDER BY id').all(f.id), before);
});
test('W6 managed startup keeps configured total and explicit slot count separate', () => {
  const args = engine.buildLlamaServerArgs({ modelPath: '/tmp/disposable-fixture.gguf' }, { contextLength: 70000, parallel: 2 }, 8123);
  assert.equal(args[args.indexOf('-c') + 1], '70000');
  assert.equal(args[args.indexOf('-np') + 1], '2');
});
