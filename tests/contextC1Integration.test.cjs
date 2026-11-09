'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-integration-'));
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  if (name === './mcpManager') return { getTools: () => [], getStatus: () => ({ servers: [] }) };
  return original.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const { measurePreparedContext, clearCache } = require('../src/main/promptMeasurement');
const { createRuntimeBudget } = require('../src/main/contextBudget');
const modelId = 'c1-local';
function session() {
  const id = randomUUID(); sessions.getOrCreateSession(id, modelId);
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `history-${i} ` + 'x'.repeat(300));
  return id;
}
test.after(() => { closeDatabase(); Module._load = original; fs.rmSync(directory, { recursive: true, force: true }); });

test('prepared cache refreshes reported capacity on same model/port and all context inputs', async () => {
  const sessionId = session();
  const engine = { port: 18080, modelPath: modelId, contextLength: 70000, runtimeIdentity: 'load-one', parallelSlots: 2 };
  let capacity = 35072, props = 0, tokenizes = 0;
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname;
    if (route === '/props') { props++; return Response.json({ model_path: modelId, chat_template: 't', default_generation_settings: { n_ctx: capacity } }); }
    if (route === '/apply-template') return Response.json({ prompt: options.body });
    tokenizes++; return Response.json({ tokens: Array(30528).fill(1) });
  };
  const measure = extra => measurePreparedContext({ sessionId, modelId, engine, fetchImpl, mcpToolsOverride: [], ...extra });
  const start = performance.now();
  const a = await measure();
  const firstMs = performance.now() - start;
  assert.equal(a.budget, 33920);
  const hitStart = performance.now(); await measure(); const hitMs = performance.now() - hitStart;
  assert.equal(tokenizes, 1);
  capacity = 16384;
  const b = await measure(); assert.equal(b.limit, 16384); assert.equal(b.budget, 15232);
  engine.parallelSlots = 4; engine.contextLength = 65536; capacity = 16448;
  assert.equal((await measure()).limit, 16448);
  engine.runtimeIdentity = 'load-two';
  assert.notEqual((await measure()).budgetContract.runtimeIdentity, b.budgetContract.runtimeIdentity);
  clearCache(); await measure();
  const before = tokenizes;
  sessions.saveMessage(sessionId, 'user', 'new attachment text');
  await measure(); assert.equal(tokenizes, before + 1);
  await measure({ mcpToolsOverride: [{ type: 'function', function: { name: 'extra', parameters: { type: 'object' } } }] });
  assert.equal(tokenizes, before + 2);
  console.log(JSON.stringify({ preparedFirstMs: firstMs, preparedCacheHitMs: hitMs, props, tokenizes }));
});
