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

test('floor-passing candidate with exact over-budget measurement refuses without archival', async () => {
  const id = workspaceSession(crypto.randomUUID());
  seedTurns(id, 12);
  const contents = sessions.loadSession(id).messages.map(row => row.content);
  const briefTexts = briefs.getAllBriefs(id).map(row => row.content_text);
  let calls = 0;
  let seen = null;
  const result = await compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => { calls++; return 'Candidate summary that must never persist.'; },
    llmCheckpointCallback: stubCheckpoint,
    measurePrompt: async ({ messages, tools, limit }) => {
      seen = { messages, tools, limit };
      return { tokens: 99999, method: 'server-template-tokenizer', budget: 7000 };
    } });
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'prospective-prompt-exceeds-budget');
  assert.equal(result.measuredMethod, 'server-template-tokenizer');
  assert.equal(result.measuredTokens, 99999);
  assert.equal(calls, 1);
  assert.equal(checkpoints.getLatestCheckpoint(id), null);
  // The prospective prompt reflected the candidate: new summary, brief,
  // retained tail, and no archived rows.
  const texts = seen.messages.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).slice(0, 4000).replace(/\s+/g, ' '));
  const joined = texts.join('\n');
  assert.ok(joined.includes('Candidate summary that must never persist.'));
  assert.ok(joined.includes(briefs.SECTION_MARKER));
  assert.ok(joined.includes('V0'));
  assert.equal(seen.limit, LIMIT);
  // Nothing persisted: no archival, no summary, briefs and history intact.
  assert.equal(sessions.getSessionSummary(id), null);
  assert.ok(sessions.loadSession(id).messages.every(row => row.archived === 0 && row.is_summarized === 0));
  assert.deepEqual(sessions.loadSession(id).messages.map(row => row.content), contents);
  assert.deepEqual(briefs.getAllBriefs(id).map(row => row.content_text), briefTexts);
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});

test('repeated unfit attempts stay bounded with no additional archival', async () => {
  const id = workspaceSession(crypto.randomUUID());
  seedTurns(id, 12);
  let calls = 0;
  const attempt = () => compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => { calls++; return 'Summary.'; },
    measurePrompt: async () => ({ tokens: 99999, method: 'server-template-tokenizer', budget: 7000 }) });
  const first = await attempt();
  const second = await attempt();
  assert.equal(first.compressed, false);
  assert.equal(second.compressed, false);
  assert.equal(first.reason, second.reason);
  assert.equal(calls, 2);
  assert.equal(sessions.getSessionSummary(id), null);
  assert.ok(sessions.loadSession(id).messages.every(row => row.archived === 0));
  assert.equal(sessions.loadSession(id).messages.length, 12);
});

test('measured fit through the real tokenizer path still commits and recovers', async () => {
  const id = workspaceSession(crypto.randomUUID());
  seedTurns(id, 12);
  const transport = backend({ tokens: text => Math.ceil(text.length / 4) });
  const measure = createPromptMeasurer(transport.fetch);
  let calls = 0;
  const result = await compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => { calls++; return 'Fitting summary.'; },
    llmCheckpointCallback: stubCheckpoint,
    measurePrompt: ({ messages, tools, limit, signal }) =>
      measure('http://127.0.0.1:9/v1/chat/completions', { model: MODEL, messages, tools }, { signal, contextWindowLimit: limit }) });
  assert.equal(result.compressed, true);
  assert.equal(result.measuredMethod, 'server-template-tokenizer');
  assert.equal(calls, 1);
  assert.equal(result.archivedCount, 2);
  assert.equal(sessions.getSessionSummary(id), 'Fitting summary.');
  assert.ok(Number.isSafeInteger(result.checkpointId));
  const latest = checkpoints.getLatestCheckpoint(id);
  assert.equal(latest.id, result.checkpointId);
  assert.equal(latest.checkpoint.objective, 'Stub objective.');
  assert.ok(latest.checkpoint.outstandingRequirements.length > 0);
  // The rebuilt prompt carries the brief, the committed summary, and only
  // retained history. Archived rows are excluded as messages (their brief
  // quotes remain by design).
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const joined = rebuilt.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.ok(joined.includes(briefs.SECTION_MARKER));
  assert.ok(joined.includes('Fitting summary.'));
  const archivedContents = new Set(sessions.getFullChatHistory(id).messages
    .filter(row => row.archived === 1).map(row => row.content));
  assert.equal(archivedContents.size, 2);
  assert.ok(rebuilt.filter(message => !message.taskBrief).every(message =>
    typeof message.content !== 'string' || !archivedContents.has(message.content)));
  assert.ok(briefs.getApplicableBriefs(id).length > 0);
  assert.ok(transport.probes.includes('/props'));
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

test('unavailable tokenizer is recorded, never silent proof of fit', async () => {
  const id = workspaceSession(crypto.randomUUID());
  seedTurns(id, 12);
  const result = await compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Approximately measured summary.',
    llmCheckpointCallback: stubCheckpoint,
    // Absurd over-count with a fallback label: the floor gate (which passes
    // here) justifies proceeding, and the method must say so explicitly.
    measurePrompt: async () => ({ tokens: 10 ** 9, method: 'approximate-full-request', budget: 1 }) });
  assert.equal(result.compressed, true);
  assert.equal(result.measuredMethod, 'approximate-full-request');
  assert.equal(sessions.getSessionSummary(id), 'Approximately measured summary.');
  assert.ok(Number.isSafeInteger(result.checkpointId));
});
