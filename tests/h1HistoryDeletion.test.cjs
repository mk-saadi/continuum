'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-h1-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const { db } = storage;
const sessions = require('../src/main/sessionManager');
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
for (const mode of ['casual', 'workspace']) test(`H1 existing ${mode} delete removes durable history and briefs transactionally`, () => {
  const project = mode === 'workspace' ? require('../src/main/projectManager').createProject({ name: 'fixture' }) : null;
  const id = `idle-${mode}`;
  sessions.getOrCreateSession(id, 'fixture', project?.id ?? null);
  sessions.saveMessage(id, 'user', 'fixture instruction');
  sessions.saveMessage(id, 'assistant', 'fixture result');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  sessions.deleteSession(id);
  for (const table of ['sessions', 'messages', 'workspace_task_briefs'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'} = ?`).get(id).n, 0);
});
test('H1 deleted identifier cannot be recreated by stale renderer even after restart', () => {
  sessions.getOrCreateSession('stale', 'fixture'); sessions.deleteSession('stale');
  storage.closeDatabase(); storage.initDatabase(directory);
  assert.throws(() => sessions.getOrCreateSession('stale', 'fixture'), /deleted/i);
});
test('H1 deletion removes background command history', () => {
  sessions.getOrCreateSession('background-history', 'fixture');
  db.prepare('INSERT INTO background_commands VALUES (?, ?, ?, ?)').run('fixture-cmd', 'background-history', directory, '{}');
  sessions.deleteSession('background-history');
  assert.equal(db.prepare('SELECT count(*) AS n FROM background_commands WHERE session_id = ?').get('background-history').n, 0);
});

test('H1 checkpoint, tool evidence, plan, steering and recovery ownership survive compaction then delete atomically', () => {
  const project = require('../src/main/projectManager').createProject({ name: 'shared fixture' });
  for (const id of ['owned', 'neighbor']) {
    sessions.getOrCreateSession(id, 'fixture', project.id);
    sessions.saveMessage(id, 'user', 'fixture brief');
    const assistant = sessions.saveMessage(id, 'assistant', 'fixture tool evidence', [], null, null, null, null, null,
      [{ id: 'tool', type: 'tool_call', toolName: 'read_project_file', status: 'complete', result: 'fixture' }]);
    db.prepare('INSERT INTO workspace_checkpoints(session_id, checkpoint_json) VALUES (?, ?)').run(id, '{}');
    db.prepare('INSERT INTO workspace_plans(session_id, objective) VALUES (?, ?)').run(id, 'fixture');
    db.prepare('INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)').run(id, 'fixture summary');
    // Active-context exclusion preserves originals and their execution evidence.
    db.prepare('UPDATE messages SET archived = 1, is_summarized = 1 WHERE id = ?').run(assistant.id);
    assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(assistant.id).content, 'fixture tool evidence');
  }
  const recovery = require('../src/main/recoveryStore'); recovery.ensureRecoverySchema();
  db.prepare('INSERT INTO recovery_sessions(project_root) VALUES (?)').run(directory);
  const rid = db.prepare('SELECT id FROM recovery_sessions WHERE project_root = ?').get(directory).id;
  for (const id of ['owned', 'neighbor']) db.prepare('INSERT INTO recovery_checkpoints(session_id, chat_session_id, manifest_json, coverage_json) VALUES (?, ?, ?, ?)').run(rid, id, '{}', '{}');
  // A database error must roll back all primary and recovery cleanup.
  db.prepare("CREATE TRIGGER h1_failure BEFORE DELETE ON sessions WHEN OLD.id = 'owned' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
  assert.throws(() => sessions.deleteSession('owned'), /fixture failure/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_checkpoints WHERE chat_session_id = ?').get('owned').n, 1);
  assert.equal(sessions.loadSession('owned').messages.length, 2);
  db.prepare('DROP TRIGGER h1_failure').run();
  sessions.deleteSession('owned');
  for (const table of ['messages', 'workspace_task_briefs', 'workspace_checkpoints', 'workspace_plans', 'session_summaries']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get('owned').n, 0);
    assert.ok(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get('neighbor').n > 0);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_checkpoints WHERE chat_session_id = ?').get('owned').n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_checkpoints WHERE chat_session_id = ?').get('neighbor').n, 1);
  assert.throws(() => db.prepare('INSERT INTO recovery_checkpoints(session_id, chat_session_id, manifest_json, coverage_json) VALUES (?, ?, ?, ?)').run(rid, 'owned', '{}', '{}'), /deleted/);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('H1 late message, checkpoint, brief, child, background and usage writes cannot restore deleted content', () => {
  sessions.getOrCreateSession('late', 'fixture');
  const turn = require('../src/main/engineManager').createMessagePersistence({ sessionId: 'late', modelId: 'fixture', displayName: 'fixture' });
  sessions.deleteSession('late');
  assert.throws(() => sessions.saveMessage('late', 'assistant', 'late result'), /FOREIGN KEY/);
  assert.throws(() => turn.update({ content: 'late result', executionSteps: [] }), /deleted/);
  assert.throws(() => db.prepare('INSERT INTO workspace_checkpoints(session_id, checkpoint_json) VALUES (?, ?)').run('late', '{}'), /FOREIGN KEY/);
  assert.throws(() => db.prepare('INSERT INTO workspace_task_briefs(session_id, kind, content_text) VALUES (?, ?, ?)').run('late', 'original', 'fixture'), /FOREIGN KEY/);
  assert.throws(() => db.prepare('INSERT INTO subagent_runs(child_session_id, parent_session_id, status, updated_at) VALUES (?, ?, ?, ?)').run('late-child', 'late', 'completed', 'fixture'), /deleted/);
  assert.throws(() => db.prepare('INSERT INTO background_commands VALUES (?, ?, ?, ?)').run('late-cmd', 'late', directory, '{}'), /deleted/);
  assert.throws(() => db.prepare('INSERT INTO sessions(id) VALUES (?)').run('late'), /deleted/);
});

test('H1 shared project files, managed attachment pool and independent memory are preserved', async () => {
  const projectFile = path.join(directory, 'user-owned.txt'); fs.writeFileSync(projectFile, 'fixture file');
  const memory = require('../src/main/memoryManager').addPermanentMemory({ category: 'preference', content: 'fixture preference' });
  const attachments = await require('../src/main/fileUploads').processUploads([projectFile]);
  for (const id of ['retention', 'attachment-neighbor']) {
    sessions.getOrCreateSession(id, 'fixture');
    sessions.saveMessage(id, 'user', 'fixture attachment', attachments);
  }
  sessions.deleteSession('retention');
  assert.equal(fs.readFileSync(attachments[0].file_path, 'utf8'), 'fixture file');
  assert.equal(sessions.loadSession('attachment-neighbor').messages[0].attachments[0].file_path, attachments[0].file_path);
  assert.equal(fs.readFileSync(projectFile, 'utf8'), 'fixture file');
  assert.ok(db.prepare('SELECT id FROM permanent_memories WHERE id = ?').get(memory.id ?? memory));
});

for (const phase of ['streaming', 'tool result', 'authorized foreground command', 'approval', 'MCP result', 'context recovery'])
  test(`H1 deletion during ${phase} revokes authority and waits for settlement`, async () => {
    const id = `running-${phase}`;
    sessions.getOrCreateSession(id, 'fixture');
    const contexts = require('../src/main/lspExecutionContext');
    contexts.createContext(id, 'full_access');
    const revision = contexts.revision(id);
    const controller = new AbortController();
    let settle;
    controller.settled = new Promise(resolve => { settle = resolve; });
    const streams = require('../src/main/engineManager').activeStreams;
    streams.set(id, controller);
    const deletion = require('../src/main/sessionDeletion').deleteConversation(id, null, () => true);
    assert.equal(controller.signal.aborted, true);
    assert.notEqual(contexts.revision(id), revision);
    assert.throws(() => sessions.getOrCreateSession(id, 'fixture'), /deleted/);
    assert.ok(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id));
    streams.delete(id); settle();
    assert.deepEqual(await deletion, { deleted: true });
    assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), undefined);
  });

test('H1 foreign run owner cannot cancel or delete another active conversation', async () => {
  sessions.getOrCreateSession('foreign', 'fixture');
  const streams = require('../src/main/engineManager').activeStreams, controller = new AbortController();
  streams.set('foreign', controller);
  assert.throws(() => require('../src/main/sessionDeletion').deleteConversation('foreign', null, () => false), /another session/);
  assert.equal(controller.signal.aborted, false); streams.delete('foreign'); sessions.deleteSession('foreign');
});

test('H1 owned background operation settles before deletion and leaves no in-memory history', async () => {
  const id = 'active-background'; sessions.getOrCreateSession(id, 'fixture');
  const registry = require('../src/main/backgroundCommands');
  const controller = new AbortController(), context = { sessionId: id, runId: 'fixture-run', workspace: directory };
  registry.openRun({ ...context, signal: controller.signal });
  let stopped = false;
  registry.start(context, 'fixture operation', 10000, signal => new Promise(resolve => {
    const stop = () => { stopped = true; resolve({ status: 'cancelled', exitCode: null }); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  }), () => {});
  await require('../src/main/sessionDeletion').deleteConversation(id, null, () => true);
  assert.equal(stopped, true);
  assert.deepEqual(registry.list(id, directory), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM background_commands WHERE session_id = ?').get(id).n, 0);
});

test('H1 child attempts are aborted, evicted and cannot be recovered after owner deletion', async () => {
  const id = 'child-owner'; sessions.getOrCreateSession(id, 'fixture');
  const sm = require('../src/main/subagents/sessionManager');
  const es = require('../src/main/subagents/executionStore');
  const child = sm.createSession({ parentSessionId: id });
  const controller = new AbortController();
  const attempt = es.createExecution({ sessionId: child.id, controller });
  controller.signal.addEventListener('abort', () => es.cancelExecution(attempt), { once: true });
  await require('../src/main/sessionDeletion').deleteConversation(id, null, () => true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(sm.getSession(child.id), null);
  assert.deepEqual(es.listExecutions(child.id), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM subagent_runs WHERE parent_session_id = ?').get(id).n, 0);
});

test('H1 supported normal compaction preserves durable messages and changes active context only', async () => {
  const id = 'normal-compaction'; sessions.getOrCreateSession(id, 'fixture');
  for (let i = 0; i < 24; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `fixture ${i} `.padEnd(800, 'x'));
  const result = await require('../src/main/compressionEngine').checkAndCompressContext({ sessionId: id, modelId: 'fixture', contextWindowLimit: 5000,
    llmSummarizeCallback: async () => 'Fixture compact state.', force: true });
  assert.equal(result.compressed, true, JSON.stringify(result));
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(id).n, 24);
  assert.ok(sessions.getActiveMessages(id).length < 24);
  assert.ok(require('../src/main/promptBuilder').rebuildChatMessages({ sessionId: id, modelId: 'fixture' }).some(message => String(message.content).includes('Fixture compact state.')));
  await require('../src/main/sessionDeletion').deleteConversation(id, null, () => true);
  storage.closeDatabase(); storage.initDatabase(directory);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(id).n, 0);
  assert.equal(sessions.getSessionSummary(id), null);
});
