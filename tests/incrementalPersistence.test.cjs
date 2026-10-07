const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const directory = process.env.PERSISTENCE_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-persistence-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');
const { createMessagePersistence } = require('../src/main/engineManager');
const { loadSession } = require('../src/main/sessionManager');
if (process.env.PERSISTENCE_TEST_DIR) {
  initDatabase(directory);
  db.prepare("INSERT INTO sessions(id) VALUES ('test')").run();
  const turn = createMessagePersistence({ sessionId: 'test', modelId: 'model', displayName: 'Assistant' });
  assert.equal(db.prepare('SELECT status FROM messages WHERE id = ?').get(turn.messageId).status, 'in_progress');
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(turn.messageId).content, '');
  const executionSteps = [
    { id: 'thought', type: 'thought', content: 'Investigating', durationMs: 12 },
    { id: 'tool', type: 'tool_call', toolName: 'read', status: 'complete', result: 'saved output' },
    { id: 'next', type: 'tool_call', toolName: 'write', status: 'running' },
  ];
  turn.update({ content: 'Partial answer', executionSteps });
  assert.equal(loadSession('test').messages[0].executionSteps[1].result, 'saved output');
  const complete = createMessagePersistence({ sessionId: 'test', modelId: 'model', displayName: 'Assistant' });
  complete.update({ content: 'Done', executionSteps: [], status: 'completed' });
  // Terminate without closing SQLite or checkpointing its WAL.
  process.kill(process.pid, 'SIGKILL');
} else {
  try {
    const child = spawnSync(process.execPath, [__filename], { env: { ...process.env, PERSISTENCE_TEST_DIR: directory }, encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    initDatabase(directory);
    let messages = loadSession('test').messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].status, 'interrupted');
    assert.equal(messages[0].content, 'Partial answer\n\n*[Response interrupted by application restart]*');
    assert.equal(messages[0].variants[0].content, messages[0].content);
    assert.equal(messages[0].executionSteps[0].content, 'Investigating');
    assert.equal(messages[0].executionSteps[1].result, 'saved output');
    assert.equal(messages[0].executionSteps[2].status, 'error');
    assert.equal(messages[1].status, 'completed');
    assert.equal(messages[1].content, 'Done');
    closeDatabase();
    initDatabase(directory);
    assert.equal(loadSession('test').messages[0].content, messages[0].content);
    console.log('Incremental persistence and abrupt crash recovery passed');
  } finally {
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
