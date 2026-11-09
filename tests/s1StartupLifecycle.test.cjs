'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's1-startup-'));
const handlers = new Map(), load = Module._load;
const mcp = Object.assign(new EventEmitter(), { getTools: () => [], getMcpMode: () => 'auto', init: async () => {}, getStatus: () => ({ servers: [] }) });
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false }, ipcMain: { handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k) } };
  if (name === './mcpManager') return mcp;
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager');
const measurement = require('../src/main/promptMeasurement');
const modelId = 'fixture';
let dispose;
test.after(async () => { dispose?.(); await compression.shutdownCompression(); storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function seed(id) { sessions.getOrCreateSession(id, modelId); sessions.saveMessage(id, 'user', 'Hello'); }
function measuredOptions(id, gate, started) {
  return { sessionId: id, modelId, engine: { port: 12345, modelPath: modelId, contextLength: 32768 }, mcpToolsOverride: [],
    fetchImpl: async (url, options) => {
      if (url.endsWith('/props')) return Response.json({ model_path: modelId, chat_template: 'fixture', default_generation_settings: { n_ctx: 32768 } });
      if (url.endsWith('/apply-template')) { started.resolve(); await gate.promise; return Response.json({ prompt: options.body }); }
      if (url.endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
      throw new Error('Unexpected transport');
    } };
}
test('offline startup measurements remain labeled estimates; deleted references stay guarded', async () => {
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => null });
  seed('valid'); seed('deleted'); sessions.deleteSession('deleted');
  const invoke = (name, payload) => handlers.get(name)({ sender: {} }, payload);
  const valid = await invoke('session:measure-context', { sessionId: 'valid', modelId });
  assert.equal(valid.note, 'engine-not-ready');
  for (let i = 0; i < 4; i++) assert.deepEqual(await invoke('session:measure-context', { sessionId: 'deleted', modelId }), { sessionId: 'deleted', modelId, cancelled: true, code: 'deleted-conversation' });
  assert.deepEqual(await invoke('session:validate-references', { sessionIds: ['deleted', 'valid', 'blank'] }), ['deleted']);
  assert.throws(() => sessions.getOrCreateSession('deleted', modelId), { code: 'deleted-conversation' });
  assert.equal(storage.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('deleted'), undefined);
});
test('concurrent identical measurements coalesce; persistence rejects the obsolete snapshot', async () => {
  seed('race'); const gate = deferred(), started = deferred();
  const options = measuredOptions('race', gate, started);
  const first = measurement.measurePreparedContext(options), second = measurement.measurePreparedContext(options);
  assert.equal(first, second);
  await started.promise;
  sessions.saveMessage('race', 'assistant', 'Persisted while tokenizing');
  gate.resolve();
  await assert.rejects(first, { code: 'stale-measurement' });
  const fresh = await measurement.measurePreparedContext(options);
  assert.equal(fresh.sessionId, 'race');
  assert.equal(sessions.getActiveMessages('race').length, 2);
});
test('deletion during measurement prevents cache publication or resurrection', async () => {
  seed('delete-race'); const gate = deferred(), started = deferred();
  const options = measuredOptions('delete-race', gate, started);
  const pending = measurement.measurePreparedContext(options);
  await started.promise;
  measurement.invalidateMeasuredContext('delete-race');
  sessions.deleteSession('delete-race'); gate.resolve();
  await assert.rejects(pending, { code: 'stale-measurement' });
  await assert.rejects(measurement.measurePreparedContext(options), { code: 'deleted-conversation' });
});
