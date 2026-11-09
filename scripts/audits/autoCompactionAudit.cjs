// HISTORICAL AUDIT: asserts defects of the retired compaction engine.
// See historical-compaction/README.md and docs/auto-compaction-replacement-2026-11-08.md.
// Reproduce against the original audit baseline, not the current production modules.
'use strict';
// Read-only production-code audit with synthetic data in a disposable database.
// Assertions describe observed defects, not desired behavior. No real provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-auto-compaction-audit-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../../src/main/db');
storage.initDatabase(directory);
const results = [];
const add = (id, observed) => results.push({ id, reproduced: true, observed });
async function main() {
  const budget = require('../../src/main/contextBudget');
  const cloudMeasure = require('../../src/main/promptMeasurement').createCloudWorkspaceMeasurer(
    { type: 'cloud', provider: 'audit', model: 'audit-model' }, {
      getProvider: () => ({ id: 'audit', apiType: 'openai', baseUrl: 'https://example.invalid/v1' }),
      getMetadata: async () => [{ providerId: 'audit', modelId: 'audit-model', contextLength: 32768 }],
    });
  const measured = await cloudMeasure({ model: 'audit-model', messages: [{ role: 'user', content: 'Synthetic task' }], tools: [], max_tokens: 1024 });
  assert.equal(measured.method, 'provider-serialized-full-request-estimate');
  await assert.rejects(require('../../src/main/compactionSummary').verifySummaryBudget({
    content: '# Working Summary\nSynthetic task', modelId: 'audit-model', measure: cloudMeasure,
  }), { code: 'compaction-summary-tokenizer-unavailable' });
  add('cloud-workspace-measurement-contract', { method: measured.method, summaryGate: 'compaction-summary-tokenizer-unavailable' });

  const sessions = require('../../src/main/sessionManager');
  const project = require('../../src/main/projectManager').createProject({ name: 'Disposable audit' });
  const id = 'audit-cloud-workspace';
  sessions.getOrCreateSession(id, 'cloud:audit:audit-model', project.id);
  sessions.saveMessage(id, 'user', 'Investigate the synthetic task.');
  sessions.saveMessage(id, 'assistant', 'Synthetic older observation.');
  sessions.saveMessage(id, 'user', 'Continue.');
  const quiet = console.info; console.info = () => {};
  let generated = 0, candidate;
  try {
    candidate = await require('../../src/main/workspaceCompactCandidate').generateWorkspaceCompactCandidate({
      sessionId: id, modelId: 'cloud:audit:audit-model', provider: 'audit', capacityTokens: 32768,
      persist: false, measure: cloudMeasure, generate: async () => { generated++; throw Error('must not dispatch'); },
    });
  } finally { console.info = quiet; }
  assert.equal(candidate.ok, false);
  assert.equal(generated, 0);
  add('cloud-workspace-production-candidate', { ok: candidate.ok, code: candidate.code, modelRequests: generated,
    fallbackReason: candidate.diagnostics.fallbackReason });

  storage.db.prepare("INSERT INTO app_settings(key,value_json) VALUES ('cloud-providers',?)")
    .run(JSON.stringify([{ id: 'audit', name: 'Audit', category: 'chat', apiType: 'openai',
      baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-fixture-key', models: ['audit-model'] }]));
  let cloudRequests = 0, recoveries = 0;
  const cloudFetch = require('../../src/main/cloudProviders').createCloudFetch(
    { type: 'cloud', provider: 'audit', model: 'audit-model' }, { fetchImpl: async () => {
      cloudRequests++; return Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 });
    } });
  await assert.rejects(cloudFetch('https://example.invalid/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'audit-model', messages: [{ role: 'user', content: 'Synthetic task' }] }),
    contextRecovery: async () => { recoveries++; return null; },
  }), /HTTP 400/);
  assert.equal(recoveries, 0);
  add('main-cloud-overflow-no-recovery', { cloudRequests, recoveryCallbacks: recoveries, result: 'generic HTTP 400 error' });

  const settings = require('../../src/main/subagents/budgetSettings');
  settings.saveBudgetSettings({ mode: 'custom', maxTurns: 100, maxToolCalls: 100,
    maxAggregateToolCalls: 1000, maxInputTokens: 1000000, maxOutputTokens: 500000 });
  const executionBudget = require('../../src/main/subagents/executionBudget');
  const recovery = require('../../src/main/subagents/contextRecovery');
  const engine = { provider: 'local', port: 9, modelId: 'audit-child', contextLength: 8192 };
  const messages = [{ role: 'system', content: 'Read only.' }, { role: 'user', content: 'Synthetic task.' }];
  for (let i = 0; i < 5; i++) messages.push({ role: 'assistant', content: null,
    tool_calls: [{ id: `audit-${i}`, type: 'function', function: { name: 'read_project_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `audit-${i}`, content: 'synthetic observation' });
  const session = { id: 'audit-child', context: messages, activity: [] };
  const state = await executionBudget.getExecutionBudget(session, { kind: 'investigation', engine });
  const adapter = recovery.createChildContextAdapter({ session, messages, engine, state,
    fetchImpl: async () => new Response('', { status: 404 }), commit: () => { session.context = messages.slice(); } });
  adapter.persist();
  const persistence = require('../../src/main/subagents/persistence');
  const priorDisk = storage.db.prepare('SELECT context_json, compaction_json FROM subagent_runs WHERE child_session_id=?').get(session.id);
  const payload = { model: engine.modelId, messages, tools: [], max_tokens: 512 };
  const snapshot = adapter.snapshot(payload);
  const persist = persistence.persistChildRun; persistence.persistChildRun = () => false;
  try {
    await adapter.commit(snapshot, { payload: { ...payload, messages: messages.slice(0, 2) }, summary: 'Synthetic compacted task',
      checkpoint: { objective: 'Synthetic task' }, selectedCount: snapshot.candidates.length,
      before: { tokens: 6000 }, after: { tokens: 1000 }, force: false });
  } finally { persistence.persistChildRun = persist; }
  const afterDisk = storage.db.prepare('SELECT context_json, compaction_json FROM subagent_runs WHERE child_session_id=?').get(session.id);
  assert.deepEqual(afterDisk, priorDisk);
  assert.equal(session.compactionState.version, 1);
  assert.equal(messages.length, 2);
  add('child-persistence-failure-accepted', { versionInMemory: 1, versionOnDisk: JSON.parse(afterDisk.compaction_json).version,
    activeMessagesInMemory: messages.length, activeMessagesOnDisk: JSON.parse(afterDisk.context_json).length });

  const generic = {
    snapshot: () => ({ candidates: [{ content: 'old', estimated_tokens: 1000 }], oldSummary: null, checkpoint: null, version: 0 }),
    measure: async p => ({ tokens: p.after ? 7600 : 8000, reserve: 500, limit: 10000, method: 'server-template-tokenizer' }),
    buildPayload: (_snapshot, summary) => ({ after: !!summary, messages: [{ role: 'user', content: 'Synthetic task' }] }),
    summarize: async () => 'Short checkpoint', estimate: () => 10,
    checkpointInput: () => ({}), draftCheckpoint: async () => ({ objective: 'Synthetic task' }),
    validationContext: () => ({ briefs: [], index: new Map(), messageExists: () => false }), validate: () => {},
    commit: async () => { throw Error('unexpected commit'); },
  };
  const useful = await require('../../src/main/compactionCore').compactTranscript({ adapter: generic, payload: {}, force: true });
  assert.equal(useful.reason, 'no-material-reduction');
  assert.equal(useful.after.tokens, 7600);
  add('forced-small-reduction-refused', { reason: useful.reason, savedTokens: 400, minimumRequired: 800,
    prospectiveFits: useful.after.tokens + useful.after.reserve <= useful.after.limit });
  let summaryAttempts = 0, checkpointAttempts = 0;
  const repeatedAdapter = { ...generic,
    summarize: async () => { summaryAttempts++; return 'Short checkpoint'; },
    draftCheckpoint: async () => { checkpointAttempts++; return { objective: 'Synthetic task' }; },
  };
  for (let i = 0; i < 2; i++) {
    const result = await require('../../src/main/compactionCore').compactTranscript({ adapter: repeatedAdapter, payload: {}, force: false });
    assert.equal(result.reason, 'no-material-reduction');
  }
  assert.equal(summaryAttempts + checkpointAttempts, 4);
  add('child-unchanged-rejected-candidate-regenerated', { identicalPreparations: 2, summaryAttempts, checkpointAttempts, committedVersions: 0 });

  const transcript = [{ role: 'system', content: 'Read only.' }, { role: 'user', content: 'Synthetic task.' }];
  for (let i = 0; i < 6; i++) transcript.push({ role: 'assistant', content: null,
    tool_calls: [{ id: `oversized-${i}`, type: 'function', function: { name: 'read_project_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `oversized-${i}`, content: '\\"'.repeat(1800) });
  const oversizedSession = { id: 'audit-oversized-child', context: transcript, activity: [] };
  const oversizedState = await executionBudget.getExecutionBudget(oversizedSession, { kind: 'investigation', engine });
  let dispatched = 0;
  const rawFetch = async (url, options = {}) => {
    const route = new URL(url).pathname;
    if (route === '/props') return Response.json({ model_path: 'audit', chat_template: 'audit-template', default_generation_settings: { n_ctx: 8192 } });
    if (route === '/apply-template') return Response.json({ prompt: JSON.stringify(JSON.parse(options.body).messages) });
    if (route === '/tokenize') return Response.json({ tokens: Array(Math.ceil(JSON.parse(options.body).content.length / 4)).fill(1) });
    dispatched++; throw Error('oversized auxiliary request should be stopped before inference');
  };
  const guarded = budget.createContextGuardedFetch(rawFetch);
  const oversizedAdapter = recovery.createChildContextAdapter({ session: oversizedSession, messages: transcript, engine,
    state: oversizedState, fetchImpl: guarded, commit: () => { oversizedSession.context = transcript.slice(); } });
  let refusal, rejectedRequestKind, simulatedSummaryInputTokens;
  const stopBeforeRequest = executionBudget.stopBeforeRequest;
  executionBudget.stopBeforeRequest = (...args) => {
    try { return stopBeforeRequest(...args); }
    catch (error) {
      rejectedRequestKind = args[1].messages[0].content.startsWith('Summarize') ? 'summary' : 'other';
      simulatedSummaryInputTokens = Math.ceil(JSON.stringify(args[1].messages).length / 4);
      throw error;
    }
  };
  try { await oversizedAdapter.prepare({ model: engine.modelId, messages: transcript, tools: [], max_tokens: 512 }, true); }
  catch (error) { refusal = error.stopReason ?? error.code; }
  finally { executionBudget.stopBeforeRequest = stopBeforeRequest; }
  assert.ok(refusal);
  assert.equal(rejectedRequestKind, 'summary');
  assert.ok(simulatedSummaryInputTokens > engine.contextLength);
  assert.equal(dispatched, 0);
  assert.equal(oversizedSession.compactionState.version, 0);
  add('child-oversized-auxiliary-request', { refusal, rejectedRequestKind, simulatedSummaryInputTokens,
    capacityTokens: engine.contextLength, auxiliaryInferenceRequests: dispatched, committedVersion: 0,
    note: 'Synthetic exact tokenizer; escaping-heavy history; no live model.' });

  const childTools = require('../../src/main/subagents/agentLoop').CHILD_TOOL_NAMES;
  assert.ok(Array.isArray(childTools));
  assert.ok(!childTools.includes('get_recent_chat_history'));
  add('child-no-raw-history-retrieval-tool', { historyToolAvailable: false, toolCount: childTools.length });
  const evidence = { date: new Date().toISOString(), sourceRevision: process.env.AUDIT_SOURCE_REVISION ?? 'Current working tree; see report for recorded baseline',
    scope: 'Synthetic source-level audit; observed defects are asserted; no production history or real inference.', results };
  const output = process.argv[2];
  if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  storage.closeDatabase(); Module._load = load;
  fs.rmSync(directory, { recursive: true, force: true });
});
