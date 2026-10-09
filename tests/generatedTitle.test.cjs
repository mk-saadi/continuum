const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Generated titles are guarded by a snapshot of the session's title: the AI
// title is written only when the title is still what it was before the model
// ran, so a manual rename always wins over a generated one.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-title-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => global.fetch(...args) };
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');

(async () => {
  try {
    initDatabase();

    // A fresh session has no title yet (the column starts NULL).
    sessions.getOrCreateSession('t1', 'model');
    assert.equal(sessions.getSessionTitle('t1'), null, 'a new session has no title');

    // The first user message names the session (existing first-message guard).
    sessions.saveMessage('t1', 'user', 'Fix the flaky login test', []);
    assert.equal(sessions.getSessionTitle('t1'), 'Fix the flaky login test');

    // An unchanged snapshot lets the generated title in.
    assert.equal(
      sessions.applyGeneratedTitle('t1', 'Fix the flaky login test', 'Flaky login test fix'),
      true,
      'generated title applies while the title is unchanged',
    );
    assert.equal(sessions.getSessionTitle('t1'), 'Flaky login test fix');

    // A manual rename that lands while the model was thinking must win: the
    // snapshot no longer matches, so the generated title is rejected.
    sessions.updateSession('t1', 'title', 'My own name');
    assert.equal(
      sessions.applyGeneratedTitle('t1', 'Flaky login test fix', 'Too late'),
      false,
      'a rename during generation rejects the generated title',
    );
    assert.equal(sessions.getSessionTitle('t1'), 'My own name', 'the manual rename survives');

    // A NULL snapshot only applies while the title is still NULL.
    sessions.getOrCreateSession('t2', 'model');
    assert.equal(sessions.applyGeneratedTitle('t2', null, 'From nothing'), true);
    assert.equal(sessions.getSessionTitle('t2'), 'From nothing');
    assert.equal(sessions.applyGeneratedTitle('t2', null, 'Nope'), false, 'NULL snapshot is single-use');

    // Unknown sessions have no title and accept no write.
    assert.equal(sessions.getSessionTitle('missing'), undefined);
    assert.equal(sessions.applyGeneratedTitle('missing', null, 'Nope'), false, 'unknown session is never written');

    // Blank titles are rejected outright.
    assert.throws(() => sessions.applyGeneratedTitle('t1', 'My own name', '   '), TypeError);

    console.log('Generated titles: snapshot guard, manual rename wins, NULL handling OK.');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
