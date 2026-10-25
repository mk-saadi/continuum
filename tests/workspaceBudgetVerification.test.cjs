const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-budget-verify-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const { backend } = require('./fixtures/contextBackend.cjs');
const { initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const briefs = require('../src/main/taskBriefs');
const { rebuildChatMessages } = require('../src/main/promptBuilder');
const compression = require('../src/main/compressionEngine');
const { createPromptMeasurer } = require('../src/main/contextBudget');
const checkpoints = require('../src/main/taskCheckpoints');

// Minimal valid checkpoint draft; the engine validator repairs brief
// coverage, so stubs need not enumerate briefs.
const stubCheckpoint = async () => ({ objective: 'Stub objective.', outstandingRequirements: [] });

const project = projects.createProject({ name: 'Verify Project' });
const MODEL = 'model';
const LIMIT = 8192;

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

function seedTurns(id, count, chars = 100) {
  for (let i = 0; i < count; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `V${i} `.padEnd(chars, 'x'));
}

test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

const safeCompact = require('./fixtures/w3Compaction.cjs').compact;
const budgets = require('../src/main/contextBudget');
function measurement(payload, method = 'approximate-full-request') {
  const tokens = budgets.approximateTokens(payload);
  const budgetContract = budgets.createRuntimeBudget({ runtimeContextTokens: 524288, payload, currentInputTokens: tokens, measurementMethod: method });
  return { tokens, method, budgetContract, limit: 524288, budget: budgetContract.usableInputTokens };
}
for (const method of ['server-template-tokenizer', 'approximate-full-request']) {
  test(`W3 ${method} over-budget prospective request refuses without archival`, async () => {
    const id = workspaceSession(crypto.randomUUID()); seedTurns(id, 12, 1000);
    const before = sessions.loadSession(id).messages;
    let seen = false;
    await assert.rejects(safeCompact({ sessionId: id, measureOverride: async payload => {
      const result = measurement(payload, method);
      if (payload.messages.some(m => m.workspaceCompactState)) {
        seen = true; result.tokens = result.budget + 1; result.budgetContract.currentInputTokens = result.tokens;
      }
      return result;
    } }), /prospective-context-overflow/);
    assert.equal(seen, true);
    assert.deepEqual(sessions.loadSession(id).messages, before);
    assert.equal(checkpoints.getLatestCheckpoint(id), null);
  });
}
test('W3 measured fit through tokenizer mock commits and recovers with authoritative briefs', async () => {
  const id = workspaceSession(crypto.randomUUID()); seedTurns(id, 12, 1000);
  const transport = backend({ context: 524288, tokens: text => Math.ceil(text.length / 4) });
  const measure = createPromptMeasurer(transport.fetch);
  const result = await safeCompact({ sessionId: id, draft: { objective: 'Preserve task' }, measureOverride: payload =>
    measure('http://127.0.0.1:9/v1/chat/completions', payload, { contextWindowLimit: 524288 }) });
  assert.equal(result.compressed, true);
  assert.equal(result.diagnostics.measurementMethod, 'server-template-tokenizer');
  assert.equal(result.diagnostics.prospectiveTokens, result.diagnostics.actualTokens);
  assert.equal(result.archivedCount, 11);
  assert.equal(sessions.getSessionSummary(id), null);
  assert.equal(checkpoints.getLatestCheckpoint(id).checkpoint.lifecycle, 'w3-current');
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.ok(rebuilt.some(m => m.taskBrief));
  assert.ok(rebuilt.some(m => m.workspaceCompactState));
  assert.ok(transport.probes.includes('/props'));
});
test('repeated legacy Workspace attempts never launch an unsafe fallback', async () => {
  const id = workspaceSession(crypto.randomUUID()); seedTurns(id, 12);
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    const result = await compression.recoverContextOverflow({ sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
      llmSummarizeCallback: async () => { calls++; return 'unsafe'; } });
    assert.equal(result.reason, 'workspace-safe-boundary-required');
  }
  assert.equal(calls, 0);
  assert.ok(sessions.loadSession(id).messages.every(row => !row.archived));
});

test('concurrent history change during measurement invalidates without partial persistence', async () => {
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL);
  seedTurns(id, 12);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Raced summary.',
    measurePrompt: async () => { await gate; return { tokens: 10, method: 'server-template-tokenizer', budget: 7000 }; } });
  await new Promise(resolve => setImmediate(resolve));
  sessions.saveMessage(id, 'user', 'Appended mid-measurement.');
  release();
  await assert.rejects(pending, /Session history changed during compression/);
  assert.equal(sessions.getSessionSummary(id), null);
  const rows = sessions.loadSession(id).messages;
  assert.ok(rows.every(row => row.archived === 0 && row.is_summarized === 0));
  assert.ok(rows.some(row => row.content === 'Appended mid-measurement.'));
  assert.equal(rows.length, 13);
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});
