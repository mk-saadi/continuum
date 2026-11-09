'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const summary = require('../src/main/compactionSummary');
const records = [];
for (const count of [1000, 1999, 4900, 4999, 5000, 5001]) test(`C9 whole summary envelope: ${count} tokens`, async () => {
  const content = '# Working Summary\n\n## Requirements\n- Keep 日本語 বাংলা العربية and all constraints.';
  const measure = async request => {
    assert.deepEqual(request.messages, [{ role: 'system', content }, { role: 'user', content: '' }]);
    assert.deepEqual(request.tools, []);
    return { tokens: count, method: 'server-template-tokenizer' };
  };
  if (count < 5000) {
    const result = await summary.verifySummaryBudget({ content, measure });
    assert.equal(result.tokens, count); assert.equal(result.digest, summary.digest(content));
  } else await assert.rejects(summary.verifySummaryBudget({ content, measure }), { code: 'compaction-summary-budget-exceeded' });
  records.push({ case: `boundary-${count}`, source: 'injected exact-count test double, not Qwen', accepted: count < 5000 });
});
for (const measured of [null, { tokens: 100, method: 'approximate-full-request' }, { tokens: NaN, method: 'server-template-tokenizer' }, { tokens: -1, method: 'server-template-tokenizer' }]) test(`C9 unavailable or invalid authoritative count ${JSON.stringify(measured)}`, async () => {
  await assert.rejects(summary.verifySummaryBudget({ content: 'summary', measure: measured ? async () => measured : undefined }), { code: 'compaction-summary-tokenizer-unavailable' });
});
test('C9 current working Markdown replaces old pending state without evidence catalogs or placeholders', () => {
  const state = { objective: 'Fix deletion undo', outstandingRequirements: [{ text: 'Preserve tags; do not publish.', status: 'open' }],
    completedWork: [{ text: 'Edited App.jsx to connect undo; verification recorded separately.' }],
    research: [{ text: 'taskLogic.js: restoreTask preserves metadata; DOM behavior remains unverified.' }],
    inProgress: [{ text: 'Need to implement undo' }], evidence: [{ messageId: 1, stepId: 'fail', toolName: 'run_tests', command: 'npm test', outcome: 'failed', exitCode: 1, diagnostics: ['FAIL multi-delete'] },
    { messageId: 1, stepId: 'pass', toolName: 'run_tests', command: 'npm test', outcome: 'success', exitCode: 0 }] };
  const current = { ...state, inProgress: [{ text: 'Component DOM verification remains unfinished.' }], blockers: ['Browser is unavailable.'], nextActions: ['Verify the multi-delete DOM flow.'] };
  const rendered = summary.renderWorkingSummary(state, current);
  for (const text of ['# Working Summary', '## Requirements', '## Progress', '## Bugs and Blockers', '## Next Steps', '## References', 'Preserve tags', 'restoreTask', 'exit 0', 'FAIL multi-delete', 'Browser is unavailable']) assert.ok(rendered.includes(text), text);
  assert.doesNotMatch(rendered, /Need to implement undo|Bugs: none|outputDigest|sourceCoverage|storedEvidence|observationPartial/);
  assert.equal(rendered.match(/# Working Summary/g).length, 1);
});

// All persistence and source fixtures are disposable. No live profile initializer.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c9-tests-')), originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return originalLoad.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager'), checkpoints = require('../src/main/taskCheckpoints');
const candidate = require('../src/main/workspaceCompactCandidate');
const project = require('../src/main/projectManager').createProject({ name: 'C9 disposable' });
let serial = 0;
function fixture() {
  const id = `c9-${++serial}`;
  sessions.getOrCreateSession(id, 'fixture', project.id);
  sessions.saveMessage(id, 'user', 'Repair undo. Preserve metadata; do not publish.');
  const source = sessions.saveMessage(id, 'assistant', 'Inspecting undo', [], null, null, null, null, null, [
    { id: 'read', type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: 'taskLogic.js' }, result: { content: 'restoreTask preserves metadata. Missing multi-delete test.' } },
    { id: 'test', type: 'tool_call', toolName: 'run_tests', status: 'complete', args: { command: 'npm test' }, result: { exitCode: 1, stdout: 'FAIL multi-delete' } },
  ]);
  return { id, source };
}
function draftFor(request, source, text = 'restoreTask preserves metadata; a multi-delete test is missing.') {
  const input = JSON.parse(request.messages[1].content), draft = { objective: 'Repair undo', briefIds: input.briefs.map(b => b.id) };
  for (const key of candidate.ARRAY_KEYS) draft[key] = [];
  draft.outstandingRequirements = [{ text: 'Preserve metadata; do not publish.', briefId: input.briefs[0].id, status: 'open' }];
  draft.research = [{ text, sources: [{ messageId: source.id, stepId: 'read' }] }];
  draft.blockers = ['Multi-delete test fails.']; draft.nextActions = ['Repair and rerun the failing test.'];
  return draft;
}
const envelope = draft => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] });
function run(f, { summaryCounts = [2000], estimated = false, generate, signal } = {}) {
  let probes = 0, generations = 0;
  return candidate.generateWorkspaceCompactCandidate({ sessionId: f.id, modelId: 'fixture', capacityTokens: 65536, persist: false, signal,
    measure: async request => {
      if (request.messages[0].content.startsWith('# Working Summary')) return { tokens: summaryCounts[Math.min(probes++, summaryCounts.length - 1)], method: estimated ? 'approximate-full-request' : 'server-template-tokenizer' };
      return { tokens: 500, limit: 65536, method: 'server-template-tokenizer' };
    }, generate: async request => { generations++; return generate ? generate(request, generations) : envelope(draftFor(request, f.source)); },
  }).then(result => ({ ...result, probes, generations }));
}
for (const [name, counts, expected, attempts] of [
  ['short summary', [1700], true, 1], ['exact hard limit', [4999], true, 1],
  ['one correction succeeds', [5000, 2100], true, 2], ['one correction remains too long', [5000, 5000], false, 2],
]) test(`C9 generation: ${name}`, async () => {
  const f = fixture(), before = JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id=?').all(f.id));
  const result = await run(f, { summaryCounts: counts });
  assert.equal(result.ok, expected); assert.equal(result.generations, attempts);
  assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id=?').all(f.id)), before);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
  if (expected) {
    assert.equal(result.candidate.summaryFormat, 'c9-markdown');
    assert.equal(result.candidate.evidence.length, 2);
    assert.equal(result.candidate.summaryMeasurement.tokens, counts.at(-1));
    assert.equal(checkpoints.workspaceCompactSection(result.candidate).content, result.candidate.savedWorkingState);
    assert.match(require('../src/main/workspaceEvidence').retrieve(f.id, { source_message_id: f.source.id, source_step_id: 'test' }).text, /FAIL multi-delete/);
  } else {
    assert.equal(result.code, 'compaction-summary-budget-exceeded');
    assert.equal(result.diagnostics.checkpointActivated, false);
  }
  records.push({ case: name, ok: result.ok, code: result.code, generationAttempts: result.generations, summaryTokens: result.candidate?.summaryMeasurement.tokens, sourceValidation: 'production validator; durable sources', model: 'scripted fixture' });
});
test('C9 estimated count never authorizes candidate persistence or activation', async () => {
  const f = fixture(), result = await run(f, { estimated: true });
  assert.equal(result.code, 'compaction-summary-tokenizer-unavailable'); assert.equal(result.generations, 1);
  assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('C9 fabricated passing tests from a failed source are rejected before summary measurement', async () => {
  const f = fixture(), result = await run(f, { generate: request => {
    const draft = draftFor(request, f.source);
    draft.completedWork = [{ text: 'All tests passed.', sources: [{ messageId: f.source.id, stepId: 'test' }] }];
    return envelope(draft);
  } });
  assert.equal(result.code, 'unsupported-completion-claim'); assert.equal(result.generations, 2); assert.equal(result.probes, 0);
});
test('C9 no truncation: over-budget mandatory Unicode requirements are retained in rejected drafts', async () => {
  const f = fixture(); let seen = '';
  const result = await run(f, { summaryCounts: [5100], generate: request => {
    const draft = draftFor(request, f.source); draft.outstandingRequirements[0].text = 'MANDATORY বাংলা 日本語 '.repeat(900);
    seen = draft.outstandingRequirements[0].text;
    return envelope(draft);
  } });
  assert.equal(result.code, 'compaction-summary-budget-exceeded'); assert.equal(result.generations, 2);
  assert.equal(seen.match(/MANDATORY/g).length, 900); assert.equal(checkpoints.getLatestCheckpoint(f.id), null);
});
test('C9 tokenizer transport failure is explicit and cancellation remains cancellation', async () => {
  await assert.rejects(summary.verifySummaryBudget({ content: 'summary', measure: async () => { throw Error('offline'); } }), { code: 'compaction-summary-tokenizer-unavailable' });
  const owner = new AbortController();
  await assert.rejects(summary.verifySummaryBudget({ content: 'summary', signal: owner.signal, measure: async () => { owner.abort(); throw Error('offline'); } }), { name: 'AbortError' });
});
test('C9 incremental pending work is replaced; passing and failed evidence remains durable', async () => {
  const f = fixture();
  const first = await run(f, { generate: request => {
    const draft = draftFor(request, f.source);
    draft.inProgress = [{ text: 'Need to implement restoreTask.', sources: [{ messageId: f.source.id, stepId: 'read' }] }];
    return envelope(draft);
  } });
  assert.equal(first.ok, true);
  checkpoints.persistCheckpointRow({ sessionId: f.id, modelId: 'fixture', checkpoint: { ...first.candidate, lifecycle: 'w3-current' } });
  const added = sessions.saveMessage(f.id, 'assistant', 'Edited and verified', [], null, null, null, null, null, [
    { id: 'edit', type: 'tool_call', toolName: 'write_project_file', status: 'complete', args: { relative_path: 'taskLogic.js' }, result: { success: true } },
    { id: 'pass', type: 'tool_call', toolName: 'run_tests', status: 'complete', args: { command: 'npm test' }, result: { exitCode: 0, stdout: '1 passed' } },
  ]);
  const second = await run(f, { generate: request => {
    const input = JSON.parse(request.messages[1].content);
    assert.ok(input.evidence.every(e => e.messageId === added.id));
    const draft = draftFor(request, f.source);
    draft.blockers = [];
    draft.completedWork = [{ text: 'Implemented restoreTask.', sources: [{ messageId: added.id, stepId: 'edit' }] },
      { text: 'Tests passed.', sources: [{ messageId: added.id, stepId: 'pass' }] }];
    draft.nextActions = ['Verify DOM behavior.'];
    return envelope(draft);
  } });
  assert.equal(second.ok, true);
  assert.doesNotMatch(second.candidate.savedWorkingState, /Need to implement restoreTask/);
  assert.match(second.candidate.savedWorkingState, /Implemented restoreTask|Tests passed/);
  assert.match(second.candidate.savedWorkingState, /earlier\/stored failed execution/);
  assert.equal(second.candidate.evidence.length, 4);
  assert.equal(second.candidate.inProgress.length, 0);
  assert.equal(first.candidate.inProgress.length, 1);
});
test('C9 exact Markdown ablation preserves independently retained instructions and full request accounting', async () => {
  const content = '# Working Summary\n\n## Objective\nRepair undo.\n\n## References\n- get_recent_chat_history';
  const payload = { messages: [{ role: 'system', content: `Required safety\n\n${content}\n\n[WORKSPACE TASK BRIEF]\nDo not publish\n[END OF WORKSPACE TASK BRIEF]` }, { role: 'user', content: 'Continue' }], tools: [] };
  const { approximateTokens } = require('../src/main/contextBudget');
  const full = { tokens: approximateTokens(payload), method: 'deterministic-estimate' };
  const perf = require('../src/main/compactionPerformance');
  const breakdown = perf.requestComposition(payload, full, { summaryContent: content });
  assert.ok(breakdown.categories.checkpoint.bytes > 0);
  assert.equal(Object.values(breakdown.categories).reduce((sum, c) => sum + c.bytes, 0), Buffer.byteLength(JSON.stringify(payload)));
  const parts = await perf.measuredComposition(payload, async request => ({ tokens: approximateTokens(request), method: full.method }), full, { summaryContent: content });
  assert.equal(parts.entries.checkpoint.present, true); assert.ok(parts.entries.checkpoint.marginalTokens > 0);
  assert.equal(parts.entries.taskBriefs.present, true);
});
test.after(() => {
  if (process.env.C9_OUTPUT) fs.writeFileSync(process.env.C9_OUTPUT, JSON.stringify(records, null, 2));
  storage.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true });
});
