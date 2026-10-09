const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// End-to-end shape of the AI title flow: the renderer fires
// session:generate-title after the first reply, the provider call runs against
// a mocked local server, and the title is written only while it still matches
// the snapshot taken before the model ran (a manual rename always wins).
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-title-'));
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  // ipcHandlers and localProvider reach the same module by different paths.
  if (String(name).includes('localEngineFetch')) return { localEngineFetch: (...args) => global.fetch(...args) };
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');

(async () => {
  let dispose;
  const originalFetch = global.fetch;
  try {
    initDatabase();
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
      isTrustedSender: () => true,
      getEngineConfig: () => ({ port: 12345, modelPath: 'model' }),
    });
    const sender = { isDestroyed: () => false, send: () => {}, once() {}, removeListener() {} };
    const generate = payload => handlers.get('session:generate-title')({ sender }, payload);

    // 1) The first prompt's generated title is applied and sanitized.
    sessions.getOrCreateSession('s1', 'model');
    sessions.saveMessage('s1', 'user', 'Fix the flaky login test', []);
    let requested = null;
    global.fetch = async (url, options) => {
      requested = JSON.parse(options.body);
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:12345\/v1\/chat\/completions$/);
      return Response.json({ choices: [{ message: { content: 'Title: Flaky login test fix' } }] });
    };
    const applied = await generate({ sessionId: 's1', prompt: 'Fix the flaky login test', modelId: 'model', activeChatProvider: { type: 'local' } });
    assert.deepEqual(applied, { applied: true, title: 'Flaky login test fix' });
    assert.equal(sessions.getSessionTitle('s1'), 'Flaky login test fix');
    // The side request is a single tool-free non-streaming completion.
    assert.equal(requested.model, 'model');
    assert.equal(requested.stream, false);
    assert.deepEqual(requested.tools, []);
    assert.equal(requested.tool_choice, 'none');
    assert.equal(requested.temperature, 0.2);
    assert.equal(requested.max_tokens, 48);
    assert.match(requested.messages.find(m => m.role === 'system').content, /title/i);
    assert.deepEqual(requested.messages.filter(m => m.role === 'user').map(m => m.content), ['Fix the flaky login test']);

    // 2) A manual rename that lands while the model was thinking wins.
    sessions.getOrCreateSession('s2', 'model');
    sessions.saveMessage('s2', 'user', 'Second chat prompt', []);
    global.fetch = async () => {
      sessions.updateSession('s2', 'title', 'Renamed while you thought');
      return Response.json({ choices: [{ message: { content: 'Generated but rejected' } }] });
    };
    const raced = await generate({ sessionId: 's2', prompt: 'Second chat prompt', modelId: 'model', activeChatProvider: { type: 'local' } });
    assert.deepEqual(raced, { applied: false, title: null }, 'a rename during generation rejects the generated title');
    assert.equal(sessions.getSessionTitle('s2'), 'Renamed while you thought');

    // 3) Unusable model output keeps the existing title untouched.
    sessions.getOrCreateSession('s3', 'model');
    sessions.saveMessage('s3', 'user', 'Third chat prompt', []);
    global.fetch = async () => Response.json({ choices: [{ message: { content: '" "' } }] });
    const blank = await generate({ sessionId: 's3', prompt: 'Third chat prompt', modelId: 'model', activeChatProvider: { type: 'local' } });
    assert.deepEqual(blank, { applied: false, title: null });
    assert.equal(sessions.getSessionTitle('s3'), 'Third chat prompt');

    // 4) Invalid requests are rejected before any model call.
    global.fetch = async () => { throw new Error('fetch must not be called'); };
    await assert.rejects(generate({ sessionId: 's1', prompt: '   ', modelId: 'model', activeChatProvider: { type: 'local' } }), /Invalid prompt/);
    await assert.rejects(generate({ sessionId: 'missing', prompt: 'Hello', modelId: 'model', activeChatProvider: { type: 'local' } }), /Session not found/);
    await assert.rejects(generate({ sessionId: 's1', prompt: 'Hello', modelId: '', activeChatProvider: { type: 'local' } }), /Invalid model/);

    console.log('Generate title IPC: apply, rename race, blank output, validation OK.');
  } finally {
    dispose?.();
    global.fetch = originalFetch;
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
