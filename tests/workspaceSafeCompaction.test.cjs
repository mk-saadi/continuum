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
      if (calls > 3) {
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
  assert.equal(result.diagnostics.measurementMethod, 'approximate-full-request');
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
