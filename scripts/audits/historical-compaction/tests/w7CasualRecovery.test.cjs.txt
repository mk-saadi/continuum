'use strict';
// Investigation regression: documents the current oversized-summary failure,
// without changing Casual Chat behavior or using a live model/database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-casual-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager');
const profiles = require('../src/main/profileSettings');
const compression = require('../src/main/compressionEngine');
const { backend } = require('./fixtures/contextBackend.cjs');
const { createRuntimeBudget } = require('../src/main/contextBudget');
const core = require('../src/main/compactionCore');
const url = 'http://localhost:9999/v1/chat/completions';
const history = id => JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id));
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });

test('W7 Casual header and nested summarizer budgets explain the exact 512-token difference', () => {
  const header = createRuntimeBudget({ configuredContextTokens: 70000, runtimeContextTokens: 35072, payload: {} });
  const summary = createRuntimeBudget({ configuredContextTokens: 70000, runtimeContextTokens: 35072, payload: { max_tokens: 512 } });
  assert.equal(header.usableInputTokens, 33920);
  assert.equal(summary.usableInputTokens, 34432);
  assert.equal(header.capacityTokens, summary.capacityTokens);
});

test('W7 recoverable older Casual history can overflow the summarizer before inference; failure preserves all rows', async () => {
  const id = 'casual-overflow'; sessions.getOrCreateSession(id, 'model');
  profiles.saveSessionMemorySettings(id, 'model', { compactionEnabled: true });
  for (let i = 0; i < 30; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `${i}:` + 'x'.repeat(i < 20 ? 14000 : 100));
  const before = history(id), batches = [];
  const summarizer = backend({ context: 35072, tokens: 55676 });
  const outer = backend({ context: 35072, tokens: 61500 });
  let recoveries = 0;
  await assert.rejects(outer.fetch(url, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'outer fixture' }] }),
    contextWindowLimit: 70000,
    contextRecovery: async ({ contextWindowLimit }) => {
      recoveries++; assert.equal(contextWindowLimit, 35072);
      await compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit,
        llmSummarizeCallback: async (old, batch) => {
          batches.push(batch.length);
          const response = await summarizer.fetch(url, { method: 'POST', body: JSON.stringify({ max_tokens: 512, stream: false,
            messages: [{ role: 'system', content: core.WORKSPACE_SUMMARY_PROMPT }, { role: 'user', content: core.summaryUserContent(old, batch) }] }) });
          return (await response.json()).choices?.[0]?.message?.content;
        } });
      assert.fail('Oversized summarization cannot rebuild the outer request');
    } }), error => error.code === 'CONTEXT_BUDGET_EXCEEDED' && /55676 server-template-tokenizer input tokens; budget 34432/.test(error.message));
  assert.equal(recoveries, 1); assert.deepEqual(batches, [20]);
  assert.equal(summarizer.calls.length, 0); assert.equal(outer.calls.length, 0);
  assert.equal(history(id), before); assert.equal(sessions.getSessionSummary(id), null);
  assert.equal(storage.db.prepare('SELECT is_compressing FROM sessions WHERE id=?').get(id).is_compressing, 0);
  // The same old history is not an immutable floor: a fitting summary permits
  // safe archival. This callback is deliberately synthetic, not a production fix.
  const recovered = await compression.recoverContextOverflow({ sessionId: id, modelId: 'model', contextWindowLimit: 35072,
    llmSummarizeCallback: async () => 'Earlier conversation facts retained (controlled fixture).',
    measurePrompt: async () => ({ tokens: 12000, budget: 33920, method: 'server-template-tokenizer' }) });
  assert.equal(recovered.compressed, true); assert.equal(recovered.archivedCount, 20);
  const rows = storage.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id);
  assert.equal(rows.length, 30); assert.equal(rows.filter(r => r.archived).length, 20);
  assert.deepEqual(rows.map(r => r.content), JSON.parse(before).map(r => r.content));
});
