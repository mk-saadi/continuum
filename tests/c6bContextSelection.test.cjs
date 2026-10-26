'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-c6b-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const { db } = storage;
const sessions = require('../src/main/sessionManager');
const briefs = require('../src/main/taskBriefs');
const checkpoints = require('../src/main/taskCheckpoints');
const builder = require('../src/main/promptBuilder');
const w2 = require('../src/main/workspaceCompactCandidate');
const evidence = require('../src/main/workspaceEvidence');
const budget = require('../src/main/contextBudget');
const project = require('../src/main/projectManager').createProject({ name: 'C6-B disposable' });
let serial = 0;
const measurements = [], comparisons = [], compactions = [], continuity = [];
function fixture() {
  const id = `c6b-${++serial}`;
  sessions.getOrCreateSession(id, 'fixture-model', project.id);
  return id;
}
const save = (id, role, text, steps) => sessions.saveMessage(id, role, text, [], null, null, null, null, null, steps);
const originalModule = new Module(path.resolve('src/main/taskBriefs.js'), module);
originalModule.filename = path.resolve('src/main/taskBriefs.js');
originalModule.paths = module.paths;
originalModule._compile(fs.readFileSync(path.join(__dirname, 'fixtures/c6b-taskBriefs-before.cjs'), 'utf8'), originalModule.filename);
async function dispatch(messages) {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  let captured;
  await runMemoryChat({ modelId: 'fixture-model', baseUrl: 'http://fixture.invalid', messages, projectId: project.id, chatTools: require('../src/main/tools/agentTools').agentTools.filter(t => ['read_project_file', 'get_recent_chat_history'].includes(t.function.name)),
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } });
  return captured;
}
function breakdown(request) {
  const groups = { systemDeveloper: [], tools: request.tools ?? [], activeTask: [], historicalBriefs: [], persistentConstraints: [], checkpoints: [], archivedHistory: [], recentMessages: [], evidence: [], workLogs: [], subagentReports: [] };
  for (const m of request.messages) {
    const text = String(m.content ?? '');
    if (m.role === 'system') {
      const start = text.indexOf(briefs.SECTION_MARKER), end = text.indexOf(briefs.SECTION_END);
      if (start >= 0 && end >= 0) {
        const block = text.slice(start, end + briefs.SECTION_END.length);
        const entries = [...block.matchAll(/\[Brief #(\d+)[^\n]*\]:\n([\s\S]*?)\[End of brief #\1\]/g)];
        const latest = entries.at(-1)?.[1];
        for (const entry of entries) groups[entry[1] === latest ? 'activeTask' : entry[2].includes('Persistent constraint:') ? 'persistentConstraints' : 'historicalBriefs'].push(entry[0]);
        let wrappers = block; for (const entry of entries) wrappers = wrappers.replace(entry[0], '');
        groups.systemDeveloper.push(text.replace(block, wrappers));
      } else groups.systemDeveloper.push(m);
    } else if (m.role === 'user') groups[text.includes('Persistent constraint:') ? 'persistentConstraints' : 'activeTask'].push(m);
    else if (text.includes('CRITICAL_C6B_FACT')) groups.evidence.push(m);
    else groups.recentMessages.push(m);
  }
  return { method: 'approximate-full-request; no real tokenizer', total: budget.approximateTokens(request),
    serializedBytes: Buffer.byteLength(JSON.stringify(request)),
    categories: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.length ? budget.approximateTokens(key === 'tools' ? { messages: [], tools: value } : { messages: value.map(v => typeof v === 'string' ? { role: 'system', content: v } : v) }) - budget.approximateTokens({ messages: [] }) : 0])),
    categoryCaveat: 'Component estimates partition serialized content but differ in wrapper overhead from total. Active/persistent originals duplicated in dialogue and brief blocks are counted in their respective categories.' };
}
for (const count of [1, 5, 20, 50]) test(`serialized provider comparison with ${count} historical briefs`, async () => {
  const id = fixture();
  save(id, 'user', 'Persistent constraint: never publish.');
  const historical = [];
  for (let i = 0; i < count; i++) {
    const m = save(id, 'user', `Historical task ${i}: ${'Implement an isolated completed widget. '.repeat(20)}`);
    historical.push(briefs.getAllBriefs(id).at(-1));
    db.prepare('UPDATE messages SET archived = 1 WHERE id = ?').run(m.id);
  }
  const finding = save(id, 'assistant', 'CRITICAL_C6B_FACT: feature list is offline export, retry queue, and audit view.');
  save(id, 'user', historical.map(b => `[workspace-brief #${b.id} state=completed]`).join('\n') + '\nCurrent task: inspect the current implementation.');
  const build = briefs.buildTaskBriefSection, select = briefs.selectHistoryMessages;
  let before;
  try {
    briefs.buildTaskBriefSection = originalModule.exports.buildTaskBriefSection;
    briefs.selectHistoryMessages = (_id, messages) => messages;
    before = await dispatch(builder.rebuildChatMessages({ sessionId: id, modelId: 'fixture-model' }));
  } finally { briefs.buildTaskBriefSection = build; briefs.selectHistoryMessages = select; }
  const after = await dispatch(builder.rebuildChatMessages({ sessionId: id, modelId: 'fixture-model' }));
  assert.match(JSON.stringify(after), /CRITICAL_C6B_FACT/);
  assert.match(JSON.stringify(after), /never publish/);
  assert.doesNotMatch(JSON.stringify(after), /Implement an isolated completed widget/);
  assert.equal(briefs.getAllBriefs(id).length, count + 2);
  assert.match(evidence.retrieve(id, { source_message_id: finding.id }).text, /offline export/);
  const result = { count, before: breakdown(before), after: breakdown(after), durableBriefCount: count + 2, necessaryFindingsRetained: true };
  assert.ok(result.after.total < result.before.total);
  measurements.push(result);
  if (count === 20) comparisons.push({ count, before, after });
});
test('legacy, explicit completion, supersession, persistent constraints, dependencies and reopening', () => {
  const id = fixture();
  save(id, 'user', 'Do not modify payment code.');
  save(id, 'user', 'commit all to git');
  const git = briefs.getAllBriefs(id).at(-1);
  save(id, 'user', `[workspace-brief #${git.id} state=completed]\nInspect widgets.`);
  assert.doesNotMatch(briefs.buildTaskBriefSection(id).content, /commit all to git/);
  assert.match(briefs.buildTaskBriefSection(id).content, /payment code/);
  assert.equal(briefs.getAllBriefs(id).find(b => b.id === git.id).content_text, 'commit all to git');
  save(id, 'user', 'Implement the features you suggested earlier.');
  assert.ok(!briefs.selectModelBriefs(id).some(b => b.id === git.id)); // C6-E: ambiguous recall must not reactivate completed actions
  assert.match(briefs.buildTaskBriefSection(id).content, /never standing authorization/);
  const current = briefs.getAllBriefs(id).at(-1);
  const source = save(id, 'user', `[workspace-brief #${current.id} state=superseded]\nNew independent task.`);
  assert.ok(!briefs.selectModelBriefs(id).some(b => b.id === current.id));
  const final = briefs.getAllBriefs(id).at(-1);
  assert.throws(() => briefs.recordLifecycle(id, final.id, { state: 'active', sourceMessageId: source.id, dependencies: [] }), /user source/);
  save(id, 'user', `[workspace-brief #${final.id} state=active]\nNew dependency task.`);
  const active = briefs.getAllBriefs(id).at(-1);
  briefs.recordLifecycle(id, final.id, { state: 'active', sourceMessageId: active.message_id, dependencies: [git.id] });
  assert.ok(briefs.selectModelBriefs(id).some(b => b.id === git.id));
});
test('eleven incremental checkpoints retain contradictory findings and exclude archived generation sources', async () => {
  const id = fixture();
  save(id, 'user', 'Inspect config; preserve unresolved errors.');
  let firstMessage;
  for (let round = 1; round <= 11; round++) {
    const stepId = `source-${round}`;
    const message = save(id, 'assistant', `Inspection ${round}`, [{ id: stepId, type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: 'config.js' }, result: round === 1 ? 'CRITICAL_INCREMENTAL: feature=offline-export; test failed E_CONFIG' : `observation ${round}: feature=${round % 2 ? 'enabled' : 'disabled'}` }]);
    firstMessage ??= message;
    const requests = [];
    const result = await w2.generateWorkspaceCompactCandidate({ sessionId: id, modelId: 'fixture-model', capacityTokens: 65536, persist: false,
      generate: async request => {
        const input = JSON.parse(request.messages[1].content); requests.push(input);
        const draft = { objective: 'Inspect config', briefIds: input.briefs.map(b => b.id) };
        for (const key of w2.ARRAY_KEYS) draft[key] = [];
        draft.inProgress = [{ text: 'Resolve E_CONFIG', sources: [{ messageId: firstMessage.id, stepId: 'source-1' }] }];
        draft.nextActions = ['Verify configuration'];
        // Source 1 is available in prior checkpoint for later rounds.
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] };
      } });
    assert.ok(result.ok, JSON.stringify(result));
    if (round > 1) {
      assert.ok(requests.every(input => input.messages.every(m => m.id === message.id)));
      assert.ok(requests.every(input => input.evidence.every(e => e.messageId === message.id)));
      assert.ok(requests.every(input => input.priorCheckpoint.inProgress.some(e => e.text === 'Resolve E_CONFIG')));
    }
    assert.match(JSON.stringify(result.candidate.evidence), /CRITICAL_INCREMENTAL/);
    assert.equal(result.candidate.evidence.length, round);
    db.transaction(() => {
      checkpoints.persistCheckpointRow({ sessionId: id, modelId: 'fixture-model', checkpoint: { ...result.candidate, lifecycle: 'w3-current' }, briefIdentity: briefs.getBriefIdentity(id) });
      db.prepare('UPDATE messages SET archived = 1 WHERE session_id = ?').run(id);
    })();
    compactions.push({ round, newMessages: result.diagnostics.newSourceMessageIds, reused: result.diagnostics.reusedSourceCount, newEvidence: result.diagnostics.newEvidenceCount, generationStages: requests.length, inputTokens: result.diagnostics.inputTokens, method: result.diagnostics.measurement });
  }
  assert.match(evidence.retrieve(id, { source_message_id: firstMessage.id, source_step_id: 'source-1' }).text, /E_CONFIG/);
  assert.match(JSON.stringify(checkpoints.getLatestCheckpoint(id).checkpoint.evidence), /feature=enabled/);
  assert.match(JSON.stringify(checkpoints.getLatestCheckpoint(id).checkpoint.evidence), /feature=disabled/);
  const checkpoint = checkpoints.getLatestCheckpoint(id);
  checkpoint.checkpoint.sourceCoverage[0].digest = 'invalid';
  db.prepare('UPDATE workspace_checkpoints SET checkpoint_json = ? WHERE id = ?').run(JSON.stringify(checkpoint.checkpoint), checkpoint.id);
  const rejected = await w2.generateWorkspaceCompactCandidate({ sessionId: id, modelId: 'fixture-model', generate: () => assert.fail('Invalid source must not generate') });
  assert.equal(rejected.code, 'invalid-checkpoint-reference');
});
test('retrieval is bounded, on-branch, session-owned, supports MCP/child bodies and deletion guards', () => {
  const id = fixture(), other = fixture();
  save(id, 'user', 'Inspect stored evidence.');
  const m = save(id, 'assistant', '', [
    { id: 'mcp-body', type: 'tool_call', toolName: 'mcp_fixture', status: 'complete', result: { content: [{ type: 'text', text: 'MCP_CRITICAL_BODY' }] } },
    { id: 'child-report', type: 'tool_call', toolName: 'spawn_sub_agent', status: 'complete', result: { childSessionId: 'child-owned', report: 'CHILD_FINDING' } },
  ]);
  assert.match(evidence.retrieve(id, { source_step_id: 'mcp-body' }).text, /MCP_CRITICAL_BODY/);
  assert.match(evidence.retrieve(id, { source_step_id: 'child-report' }).text, /child-owned/);
  assert.throws(() => evidence.retrieve(other, { source_message_id: m.id }), /unavailable/);
  assert.throws(() => evidence.retrieve(id, { source_message_id: m.id, length: 8001 }), /Invalid/);
  const page = evidence.retrieve(id, { source_step_id: 'mcp-body', length: 8 });
  assert.equal(page.text.length, 8); assert.equal(page.nextOffset, 8);
  sessions.deleteMessage(id, m.id);
  assert.throws(() => evidence.retrieve(id, { source_step_id: 'mcp-body' }), /unavailable/);
});
test('reopen preserves lifecycle facts and originals', () => {
  const id = fixture(); save(id, 'user', 'Old task');
  const old = briefs.getAllBriefs(id)[0];
  save(id, 'user', `[workspace-brief #${old.id} state=completed]\nInspect new task`);
  storage.closeDatabase(); storage.initDatabase(directory);
  assert.equal(briefs.getAllBriefs(id)[0].content_text, 'Old task');
  assert.doesNotMatch(briefs.buildTaskBriefSection(id).content, /Old task/);
});
test.after(() => {
  if (process.env.C6B_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.C6B_EVIDENCE_OUTPUT, JSON.stringify({ measurements, comparisons, compactions, continuity }, null, 2));
  storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true });
});
for (const large of [false, true]) test(`twenty below-threshold tool rounds retain early findings (${large ? 'truncated output' : 'ordinary'})`, async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const engine = require('../src/main/engineManager');
  const id = fixture(); save(id, 'user', 'Inspect twenty files and retain diagnostic history.');
  const row = save(id, 'assistant', '');
  const requests = [], executions = [];
  const owner = new AbortController(); let boundaryChecks = 0;
  const tool = { type: 'function', function: { name: 'read_project_file', description: 'fixture read', parameters: { type: 'object' } } };
  await runMemoryChat({ modelId: 'fixture-model', baseUrl: 'http://fixture.invalid', projectId: project.id,
    messages: [{ role: 'system', content: 'Fixture rules' }, { role: 'user', content: 'Inspect twenty files.' }], chatTools: [tool], maxAutoTurns: 25,
    guardToolContent: engine.truncateToolOutput,
    workspaceCompaction: async boundary => {
      boundaryChecks++;
      const result = await require('../src/main/workspaceCompaction').compactAtBoundary({ ...boundary,
        sessionId: id, modelId: 'fixture-model', owner, messageId: row.id, isCurrent: () => true,
        generate: () => assert.fail('Below-threshold run must not generate a checkpoint'),
        measure: async payload => {
          const tokens = budget.approximateTokens(payload);
          const contract = budget.createRuntimeBudget({ runtimeContextTokens: 262144, payload, currentInputTokens: tokens });
          assert.ok(tokens < contract.autoCompactionTriggerTokens);
          return { tokens, method: 'approximate-full-request', limit: 262144, budget: contract.usableInputTokens, budgetContract: contract };
        } });
      assert.equal(result.compressed, false); return result;
    },
    onExecutionSteps: steps => sessions.saveMessage(id, 'assistant', 'Inspecting', [], null, null, null, row.id, null, steps),
    executeTool: async call => {
      executions.push(call.id);
      if (call.id === 'round-1') return (large ? 'large-output '.repeat(4000) : '') + 'MIDRUN_CRITICAL_FACT: queue uses monotonic IDs.';
      return call.id === 'round-2' ? 'Earlier test failure: E_QUEUE' : call.id === 'round-10' ? 'Later test success; E_QUEUE occurred earlier.' : `File observation ${call.id}`;
    },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      const round = requests.length;
      const message = round <= 20 ? { tool_calls: [{ id: `round-${round}`, type: 'function', function: { name: 'read_project_file', arguments: '{}' } }] } : { content: 'Done [TASK COMPLETE]' };
      return Response.json({ choices: [{ message, finish_reason: round <= 20 ? 'tool_calls' : 'stop' }] });
    } });
  for (const round of [5, 10, 15, 20]) {
    const request = requests[round]; // request after that completed round
    assert.match(JSON.stringify(request), /round-1/);
    if (large) {
      assert.match(JSON.stringify(request), /source_step_id/);
      const head = evidence.retrieve(id, { source_step_id: 'round-1', length: 1 });
      assert.match(evidence.retrieve(id, { source_step_id: 'round-1', offset: head.totalCharacters - 1000 }).text, /MIDRUN_CRITICAL_FACT/);
    } else assert.match(JSON.stringify(request), /MIDRUN_CRITICAL_FACT/);
    assert.match(JSON.stringify(request), /E_QUEUE/);
  }
  assert.equal(executions.length, 20); assert.equal(new Set(executions).size, 20);
  assert.equal(boundaryChecks, 21); assert.equal(checkpoints.getLatestCheckpoint(id), null);
  const rewound = engine.rewindFailedTurnRange([{ role: 'assistant', tool_calls: [{ id: 'failed-step' }] },
    { role: 'tool', tool_call_id: 'failed-step', content: JSON.stringify({ success: false, error: 'E_QUEUE' }) }], 0);
  assert.match(JSON.stringify(rewound), /failed-step/); assert.match(JSON.stringify(rewound), /source_step_id/);
  continuity.push({ largeOutput: large, completedRounds: executions.length, duplicateExecutions: executions.length - new Set(executions).size, boundaryChecks, checkpoints: 0, captures: [5,10,15,20].map(round => ({ round, inputTokens: budget.approximateTokens(requests[round]), priorFinding: large ? 'retrieved from stored source page' : 'direct in serialized request', earlierDiagnosticVisible: JSON.stringify(requests[round]).includes('E_QUEUE'), serializedRequestSHA256: require('node:crypto').createHash('sha256').update(JSON.stringify(requests[round])).digest('hex') })) });
});

test('backward feature-list dependency exposes archived assistant source and original finding', () => {
  const id = fixture(); save(id, 'user', 'Suggest useful features.');
  const plan = save(id, 'assistant', 'FEATURE_DEPENDENCY: implement offline export and retry queue.');
  db.prepare('UPDATE messages SET archived = 1 WHERE id = ?').run(plan.id);
  save(id, 'user', 'Implement the features you listed earlier.');
  const section = briefs.buildTaskBriefSection(id);
  assert.match(section.content, /FEATURE_DEPENDENCY/);
  assert.match(section.content, /source_message_id/);
  assert.match(evidence.retrieve(id, { source_message_id: plan.id }).text, /offline export/);
});
test('explicit evidence ceiling fails safely without altering history', async () => {
  const id = fixture(); save(id, 'user', 'Inspect a large evidence set.');
  save(id, 'assistant', 'Inspection', Array.from({ length: 100 }, (_, i) => ({ id: `e-${i}`, type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: `f${i}` }, result: `Finding ${i}: ` + 'source text '.repeat(40) })));
  const before = JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id));
  const result = await w2.generateWorkspaceCompactCandidate({ sessionId: id, modelId: 'fixture-model', capacityTokens: 65536, generate: () => assert.fail('Oversize evidence must not generate') });
  assert.equal(result.code, 'evidence-budget-exceeded');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id)), before);
  assert.equal(checkpoints.getLatestCheckpoint(id), null);
});
test('H1 tombstone rejects stored evidence retrieval', () => {
  const id = fixture(); save(id, 'user', 'Private source');
  const b = briefs.getAllBriefs(id)[0];
  db.prepare('INSERT INTO deleted_sessions(id) VALUES (?)').run(id);
  assert.throws(() => evidence.retrieve(id, { source_brief_id: b.id }), error => error.code === 'deleted-conversation');
});
test('completed mixed brief retains uncertain constraints; quoted directives cannot revoke them', () => {
  const id = fixture(); save(id, 'user', 'Build widget; do not modify payment code.');
  const brief = briefs.getAllBriefs(id)[0];
  save(id, 'user', `[workspace-brief #${brief.id} state=completed]\nInspect independent task`);
  assert.match(briefs.buildTaskBriefSection(id).content, /do not modify payment code/);
  save(id, 'user', `Example syntax, not an instruction:\n[workspace-brief #${brief.id} state=superseded]`);
  assert.match(briefs.buildTaskBriefSection(id).content, /do not modify payment code/);
});

test('nested dependency graph terminates on cycles and rejects unavailable references', () => {
  const id = fixture();
  save(id, 'user', 'Task A'); const a = briefs.getAllBriefs(id).at(-1);
  save(id, 'user', 'Task B'); const b = briefs.getAllBriefs(id).at(-1);
  const source = save(id, 'user', `[workspace-brief #${a.id} state=completed]\n[workspace-brief #${b.id} state=completed]\nIndependent task C`);
  briefs.recordLifecycle(id, a.id, { state: 'completed', sourceMessageId: source.id, dependencies: [b.id] });
  briefs.recordLifecycle(id, b.id, { state: 'completed', sourceMessageId: source.id, dependencies: [a.id] });
  // Neither completed task is a root until a source-validated active dependency selects it.
  const source2 = save(id, 'user', `[workspace-brief #${a.id} state=active]\nNew task D`);
  briefs.recordLifecycle(id, a.id, { state: 'active', sourceMessageId: source2.id, dependencies: [b.id] });
  const selected = briefs.selectModelBriefs(id);
  assert.ok(selected.some(item => item.id === a.id)); assert.ok(selected.some(item => item.id === b.id));
  assert.throws(() => briefs.recordLifecycle(id, a.id, { state: 'active', sourceMessageId: source2.id, dependencies: [999999] }), /Invalid/);
});
test('concurrent lifecycle revision rejects generation before persistence', async () => {
  const id = fixture(); save(id, 'user', 'Inspect widget');
  const brief = briefs.getAllBriefs(id)[0];
  const source = save(id, 'user', `[workspace-brief #${brief.id} state=active]\n[workspace-brief #${brief.id} state=completed]\nInspect new widget`);
  const before = JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id));
  const result = await w2.generateWorkspaceCompactCandidate({ sessionId: id, modelId: 'fixture-model', capacityTokens: 65536,
    generate: async request => {
      const input = JSON.parse(request.messages[1].content);
      briefs.recordLifecycle(id, brief.id, { state: 'active', sourceMessageId: source.id });
      const draft = { objective: 'Inspect widget', briefIds: input.briefs.map(b => b.id) };
      for (const key of w2.ARRAY_KEYS) draft[key] = [];
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] };
    } });
  assert.equal(result.code, 'concurrent-state-change');
  assert.equal(checkpoints.getLatestCheckpoint(id), null);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id)), before);
});
