'use strict';
// Cache-aware token history: additive migration from the legacy six-column
// table, nullable cache counters (measured zero vs unknown), mixed-provider
// aggregation, session/model filtering, and snapshot upserts without erasing
// known cache values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-token-history-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

// Simulate a pre-Phase-2.0C-1 database before initDatabase runs its additive
// migration. Only token_usage is needed; the normal schema creates the rest.
fs.mkdirSync(directory, { recursive: true });
const legacy = new Database(path.join(directory, 'memory_palace.db'));
legacy.exec(`CREATE TABLE token_usage (
  turn_id TEXT PRIMARY KEY, chat_id TEXT, project_id TEXT, timestamp TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK(completion_tokens >= 0)
)`);
legacy.prepare('INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?)')
  .run('legacy-1', 'chat-legacy', 'p1', '2026-03-01T00:00:00.000Z', 100, 10);
legacy.prepare('INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?)')
  .run('legacy-2', 'chat-legacy', 'p1', '2026-03-02T00:00:00.000Z', 50, 5);
legacy.close();

const { db, initDatabase, closeDatabase } = require('../src/main/db');
const { logTokenUsage, getTokenHistory } = require('../src/main/tokenUsage');
const sessions = require('../src/main/sessionManager');
const now = new Date('2026-03-31T12:00:00Z');
try {
  initDatabase(directory);
  const columns = new Set(db.prepare('PRAGMA table_info(token_usage)').all().map(row => row.name));
  for (const column of ['cache_read_tokens', 'cache_creation_tokens', 'uncached_input_tokens', 'reasoning_tokens', 'model_id', 'provider', 'cache_read_coverage']) {
    assert.ok(columns.has(column), `migration adds ${column}`);
  }
  // Legacy rows stay readable and their cache fields remain unknown, not zero.
  const legacyHistory = getTokenHistory({ months: 12 }, now);
  assert.equal(legacyHistory.data.reduce((sum, row) => sum + row.promptTokens, 0), 150);
  assert.equal(legacyHistory.data.reduce((sum, row) => sum + row.cacheReadMeasuredTurns, 0), 0);
  assert.equal(legacyHistory.data.find(row => row.period === '2026-03-01').cacheReadTokens, null);
  assert.equal(legacyHistory.data.find(row => row.period === '2026-03-01').cacheReadCoverage, 'unavailable');

  logTokenUsage({ turnId: 'cached-1', chatId: 'chat-a', projectId: 'p1', timestamp: '2026-03-03T00:00:00Z',
    promptTokens: 200, completionTokens: 20, uncachedInputTokens: 100, cacheReadTokens: 80,
    cacheCreationTokens: 20, reasoningTokens: 10, visibleOutputTokens: 10,
    modelId: 'model-a', provider: 'openai', cacheReadCoverage: 'measured',
    cacheWriteCoverage: 'measured', usageCoverage: 'measured', inputSource: 'provider',
    cacheReadSource: 'provider', cacheWriteSource: 'provider' }, now);
  // Measured zero cache read is a real measurement, not missing data.
  logTokenUsage({ turnId: 'zero-1', chatId: 'chat-b', projectId: 'p1', timestamp: '2026-03-04T00:00:00Z',
    promptTokens: 10, completionTokens: 2, uncachedInputTokens: 10, cacheReadTokens: 0,
    modelId: 'model-a', provider: 'local', cacheReadCoverage: 'measured',
    cacheWriteCoverage: 'unavailable', usageCoverage: 'measured', inputSource: 'server-timings' }, now);
  logTokenUsage({ turnId: 'unknown-1', chatId: 'chat-c', projectId: 'p2', timestamp: '2026-03-05T00:00:00Z',
    promptTokens: 30, completionTokens: 3, modelId: 'model-b', provider: 'anthropic',
    usageCoverage: 'measured', inputSource: 'provider' }, now);

  const mixed = getTokenHistory({ months: 3 }, now);
  assert.equal(mixed.data.reduce((sum, row) => sum + row.promptTokens, 0), 390);
  assert.equal(mixed.data.reduce((sum, row) => sum + row.completionTokens, 0), 40);
  assert.equal(mixed.data.reduce((sum, row) => sum + row.cacheReadTokens, 0), 80);
  assert.equal(mixed.data.reduce((sum, row) => sum + row.cacheCreationTokens, 0), 20);
  assert.equal(mixed.data.reduce((sum, row) => sum + row.uncachedInputTokens, 0), 110);
  assert.equal(mixed.data.reduce((sum, row) => sum + row.reasoningTokens, 0), 10);
  const march = mixed.data.find(row => row.period === '2026-03-01');
  assert.equal(march.cacheReadCoverage, 'partially_measured', 'legacy/unknown rows make the bucket partial');
  assert.equal(march.cacheCreationCoverage, 'partially_measured');
  assert.equal(march.reasoningCoverage, 'partially_measured');
  assert.deepEqual(mixed.models.map(row => row.modelId).sort(), ['model-a', 'model-b']);
  assert.deepEqual(mixed.modelIds.sort(), ['model-a', 'model-b']);

  // Model and session filters never mix concurrent runs.
  const modelA = getTokenHistory({ months: 3, modelId: 'model-a' }, now);
  assert.equal(modelA.data.reduce((sum, row) => sum + row.turns, 0), 2);
  assert.equal(modelA.data.reduce((sum, row) => sum + row.cacheReadTokens, 0), 80);
  assert.equal(modelA.data.find(row => row.period === '2026-03-01').cacheReadCoverage, 'measured');
  assert.equal(modelA.data.reduce((sum, row) => sum + row.uncachedInputTokens, 0), 110);
  const modelB = getTokenHistory({ months: 3, modelId: 'model-b' }, now);
  assert.equal(modelB.data.reduce((sum, row) => sum + row.cacheReadTokens, 0), 0);
  assert.equal(modelB.data.find(row => row.period === '2026-03-01').cacheReadCoverage, 'unavailable');
  const chatB = getTokenHistory({ months: 3, chatId: 'chat-b' }, now);
  assert.equal(chatB.data.reduce((sum, row) => sum + row.turns, 0), 1);
  assert.equal(chatB.data.reduce((sum, row) => sum + row.cacheReadTokens, 0), 0);
  assert.equal(chatB.data.find(row => row.period === '2026-03-01').cacheReadCoverage, 'measured',
    'a reported zero stays measured after filtering');
  assert.equal(getTokenHistory({ months: 3, projectId: 'p2' }, now).data.reduce((sum, row) => sum + row.turns, 0), 1);

  // A later cumulative snapshot that omits cache fields must not erase the
  // earlier measured values for the same turn.
  logTokenUsage({ turnId: 'cached-1', chatId: 'chat-a', projectId: 'p1', timestamp: '2026-03-03T00:00:00Z',
    promptTokens: 200, completionTokens: 20, modelId: 'model-a', provider: 'openai' }, now);
  const afterUpsert = getTokenHistory({ months: 3, modelId: 'model-a' }, now);
  assert.equal(afterUpsert.data.reduce((sum, row) => sum + row.cacheReadTokens, 0), 80);
  assert.equal(afterUpsert.data.find(row => row.period === '2026-03-01').cacheReadCoverage, 'measured');

  assert.throws(() => logTokenUsage({ turnId: 'bad', promptTokens: 1, completionTokens: 1, cacheReadTokens: -1 }, now), /cache-read/);
  assert.throws(() => logTokenUsage({ turnId: 'bad', promptTokens: 1, completionTokens: 1, modelId: '' }, now), /model ID/);
  assert.throws(() => getTokenHistory({ modelId: 5 }, now), /model ID/);
  assert.throws(() => getTokenHistory({ chatId: 5 }, now), /chat ID/);

  // Context occupancy remains the gross/estimated prompt path. Telemetry cache
  // fields never replace or reduce the panel's total.
  sessions.getOrCreateSession('context-session', 'model-a');
  sessions.saveMessage('context-session', 'user', 'A'.repeat(400));
  sessions.saveMessage('context-session', 'assistant', 'Done.', [], {
    time: 1, promptTokens: 1000, completionTokens: 20, totalTokens: 1020,
    lastPromptTokens: 1000, peakPromptTokens: 1000, promptRequests: 1, promptCoverage: 'complete',
    cachedTokens: 900, cacheCreationTokens: 0, uncachedInputTokens: 100,
    cacheReadCoverage: 'measured', cacheWriteCoverage: 'measured', usageCoverage: 'measured',
  });
  const usage = sessions.getContextUsage('context-session', 'model-a');
  const telemetry = sessions.getLastTurnTelemetry('context-session');
  assert.equal(telemetry.cachedTokens, 900);
  assert.equal(telemetry.uncachedInputTokens, 100);
  assert.equal(telemetry.cacheReadCoverage, 'measured');
  assert.ok(usage.totalTokens > 0);
  assert.notEqual(usage.totalTokens, telemetry.uncachedInputTokens, 'occupancy is not uncached input');
  assert.notEqual(usage.totalTokens, telemetry.lastPromptTokens, 'occupancy remains its own estimate, not server telemetry');

  // Restart/readback keeps the new columns intact.
  closeDatabase(); initDatabase(directory);
  const reopened = getTokenHistory({ months: 3, modelId: 'model-a' }, now);
  assert.equal(reopened.data.reduce((sum, row) => sum + row.cacheReadTokens, 0), 80);
  assert.equal(reopened.data.reduce((sum, row) => sum + row.cacheCreationTokens, 0), 20);
  console.log('Cache token history migration, unknown-vs-zero, mixed aggregation, filters, upsert, context occupancy and reopen passed.');
} finally {
  Module._load = originalLoad;
  try { closeDatabase(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
