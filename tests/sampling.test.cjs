const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-test-'));
const originalLoad = Module._load;
const handlers = new Map();
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const Database = require('better-sqlite3');
const legacy = new Database(path.join(directory, 'memory_palace.db'));
legacy.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, model_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_active_at TEXT DEFAULT CURRENT_TIMESTAMP, is_compressing INTEGER DEFAULT 0); INSERT INTO sessions(id, model_id) VALUES ('legacy', 'model');");
legacy.close();
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sampling = require('../src/main/samplingManager');
const sessions = require('../src/main/sessionManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
(async () => {
  let dispose;
  try {
    initDatabase();
    assert.equal(db.prepare("SELECT sampling_params FROM sessions WHERE id = 'legacy'").get().sampling_params, null);
    assert.deepEqual(sessions.getSessionSamplingParams('legacy').params, sampling.DEFAULT_SAMPLING_PARAMS);
    sampling.saveGlobalSamplingParams({ temperature: 1.2, max_tokens: 1000 });
    assert.equal(sessions.getSessionSamplingParams('legacy').params.temperature, 1.2);
    sessions.saveSessionSamplingParams('legacy', '', { temperature: 0, top_p: 0 });
    sampling.saveGlobalSamplingParams({ temperature: 1.5, top_k: 60 });
    const params = sessions.getSessionSamplingParams('legacy').params;
    assert.equal(params.temperature, 0); assert.equal(params.top_p, 0); assert.equal(params.top_k, 60);
    closeDatabase(); initDatabase();
    assert.deepEqual(sessions.getSessionSamplingParams('legacy').params, params);
    const saved = sessions.saveMessage('legacy', 'user', 'branch');
    const { sessionId } = sessions.branchChat('legacy', saved.id);
    assert.deepEqual(sessions.getSessionSamplingParams(sessionId).overrides, { temperature: 0, top_p: 0 });
    sessions.saveSessionSamplingParams(sessionId, '', null);
    assert.equal(sessions.getSessionSamplingParams(sessionId).params.temperature, 1.5);
    assert.equal(sessions.getSessionSamplingParams('legacy').params.temperature, 0);
    const draft = sessions.saveSessionSamplingParams('draft', 'model', { max_tokens: -1 });
    assert.equal(draft.exists, true);
    assert.equal(draft.params.max_tokens, -1);
    for (const invalid of [{ temperature: 2.1 }, { top_p: -1 }, { top_k: 1.5 }, { top_k: 101 }, { repeat_penalty: 0.9 }, { max_tokens: 0 }, { max_tokens: -2 }, { max_tokens: Infinity }, { tools: [] }]) {
      assert.throws(() => sessions.saveSessionSamplingParams('legacy', 'model', invalid), /Invalid sampling/);
    }
    assert.equal(sessions.getSessionSamplingParams('legacy').params.temperature, 0);
    db.prepare("UPDATE sessions SET sampling_params = 'broken' WHERE id = 'draft'").run();
    assert.equal(sessions.getSessionSamplingParams('draft').params.temperature, 1.5);
    dispose = registerIpcHandlers({ isTrustedSender: event => event.trusted });
    await assert.rejects(handlers.get('sampling:save')({ trusted: false }, { params: { top_k: 20 } }), /Unauthorized/);
    await handlers.get('sampling:save')({ trusted: true }, { sessionId: 'legacy', modelId: 'model', params: { repeat_penalty: 1.25 } });
    assert.equal((await handlers.get('sampling:get')({ trusted: true }, { sessionId: 'legacy' })).params.repeat_penalty, 1.25);
    console.log('Legacy migration, global/session inheritance, live updates, persistence, branch/reset, validation, and IPC passed.');
  } finally { dispose?.(); closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
