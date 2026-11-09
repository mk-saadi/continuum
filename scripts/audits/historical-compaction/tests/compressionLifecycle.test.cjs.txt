const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-lifecycle-'));
const load = Module._load, home = os.homedir;
os.homedir = () => directory;
const registered = new Map();
const mcp = Object.assign(new EventEmitter(), { init: async () => {}, reload: async () => {}, getTools: () => [], getStatus: () => ({ servers: [] }), configPath: path.join(directory, 'mcp.json') });
let transport;
let disposeIpc = null;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn), removeHandler: channel => registered.delete(channel) },
    Notification: { isSupported: () => false }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } };
  if (name === './mcpManager') return mcp;
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => transport.fetch(...args) };
  return load.call(this, name, ...args);
};

const { backend } = require('./fixtures/contextBackend.cjs');
const { db, initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const briefs = require('../src/main/taskBriefs');
const checkpoints = require('../src/main/taskCheckpoints');
const { prepareChatMessages, rebuildChatMessages } = require('../src/main/promptBuilder');
const compression = require('../src/main/compressionEngine');
const inspection = require('../src/main/contextInspection');

const project = projects.createProject({ name: 'Lifecycle Project' });
const MODEL = 'model';
const LIMIT = 2600;

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

const stubDraft = () => ({ objective: 'Stub objective.', outstandingRequirements: [] });

// Workspace history with evidence-bearing assistant turns. Returns ids for
// evidence references.
function seedWork(id) {
  sessions.saveMessage(id, 'user', 'Build the widget.');
  const editMsg = sessions.saveMessage(id, 'assistant', 'Editing now.', [], null, null, null, null, null,
    [{ id: 'edit-1', type: 'tool_call', toolName: 'str_replace_editor', status: 'complete',
      args: { relative_path: 'src/foo.js', old_str: 'a', new_str: 'b' }, result: { success: true } }]);
  const cmdMsg = sessions.saveMessage(id, 'assistant', 'Testing now.', [], null, null, null, null, null,
    [{ id: 'cmd-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
      args: { command: 'npm test' }, result: { stdout: '5 passed\n5 tests', stderr: '', exitCode: 0 } }]);
  for (let i = 0; i < 22; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Filler${i} `.padEnd(400, 'x'));
  return { editMsg, cmdMsg };
}

function checkpointDraft(editId, cmdId) {
  return {
    objective: 'Build the widget and keep it green.',
    outstandingRequirements: [],
    completedWork: [
      { text: 'Edited src/foo.js.', sources: [{ messageId: editId, stepId: 'edit-1' }] },
      { text: 'Ran the suite.', sources: [{ messageId: cmdId, stepId: 'cmd-1' }] },
    ],
    filesChanged: [{ path: 'src/foo.js', nature: 'edited', verified: true, stepRef: { messageId: editId, stepId: 'edit-1' } }],
    commands: [{ command: 'npm test', stepRef: { messageId: cmdId, stepId: 'cmd-1' } }],
    tests: [{ command: 'npm test', stepRef: { messageId: cmdId, stepId: 'cmd-1' } }],
    nextActions: ['Ship it.'],
  };
}

async function compressWork(id, summary, draft) {
  return require('./fixtures/w3Compaction.cjs').compact({ sessionId: id, modelId: MODEL, draft });
}

test.after(() => { if (disposeIpc) disposeIpc(); closeDatabase(); Module._load = load; os.homedir = home; fs.rmSync(directory, { recursive: true, force: true }); });

test('legacy schema upgrade preserves data and installs brief/checkpoint cleanup', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-lifecycle-legacy-'));
  try {
    closeDatabase();
    initDatabase(legacyDir);
    // Simulate a pre-upgrade app version: no brief/checkpoint tables and an
    // older session-cascade trigger covering only messages and summaries.
    // (The db facade exposes prepare/transaction only; single statements.)
    db.prepare('DROP TABLE IF EXISTS workspace_task_briefs').run();
    db.prepare('DROP TABLE IF EXISTS workspace_checkpoints').run();
    db.prepare('DROP TRIGGER IF EXISTS sessions_cascade').run();
    db.prepare(`CREATE TRIGGER sessions_cascade BEFORE DELETE ON sessions BEGIN
        DELETE FROM messages WHERE session_id = OLD.id;
        DELETE FROM session_summaries WHERE session_id = OLD.id;
      END`).run();
    sessions.getOrCreateSession('legacy-casual', 'model');
    sessions.saveMessage('legacy-casual', 'user', 'Legacy retained text');
    sessions.saveMessage('legacy-casual', 'assistant', 'Legacy reply.');
    db.prepare('INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)').run('legacy-casual', 'Legacy summary.');
    closeDatabase();
    initDatabase(legacyDir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_task_briefs', 'workspace_checkpoints') ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ['workspace_checkpoints', 'workspace_task_briefs']);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_task_briefs_session', 'idx_task_briefs_message', 'idx_checkpoints_session') ORDER BY name").all().map(row => row.name);
    assert.deepEqual(indexes, ['idx_checkpoints_session', 'idx_task_briefs_message', 'idx_task_briefs_session']);
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sessions_cascade'").get().sql;
    assert.ok(trigger.includes('workspace_task_briefs'), 'upgraded trigger cleans briefs');
    assert.ok(trigger.includes('workspace_checkpoints'), 'upgraded trigger cleans checkpoints');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const history = sessions.loadSession('legacy-casual');
    assert.equal(history.messages.length, 2);
    assert.equal(history.messages[0].content, 'Legacy retained text');
    assert.equal(sessions.getSessionSummary('legacy-casual'), 'Legacy summary.');
    // Re-running migration on the upgraded database is idempotent.
    closeDatabase();
    initDatabase(legacyDir);
    assert.equal(sessions.getSessionSummary('legacy-casual'), 'Legacy summary.');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_task_briefs', 'workspace_checkpoints')").get().n, 2);
    // Upgraded databases immediately support briefs and checkpoints.
    const legacyProject = projects.createProject({ name: 'Legacy Upgrade' });
    const upgraded = crypto.randomUUID();
    sessions.getOrCreateSession(upgraded, MODEL, legacyProject.id);
    sessions.saveMessage(upgraded, 'user', 'Post-upgrade requirement.');
    for (let i = 0; i < 20; i++) sessions.saveMessage(upgraded, i % 2 ? 'assistant' : 'user', `U${i} `.padEnd(400, 'x'));
    const upgradedResult = await compressWork(upgraded, '', stubDraft());
    assert.equal(upgradedResult.compressed, true);
    assert.ok(Number.isSafeInteger(upgradedResult.checkpointId));
    assert.ok(briefs.getApplicableBriefs(upgraded).some(brief => brief.content_text === 'Post-upgrade requirement.'));
    closeDatabase();
    initDatabase();
  } finally {
    try { closeDatabase(); } catch {}
    initDatabase();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('session deletion leaves no orphaned briefs, checkpoints, summaries, messages, or attachments', async () => {
  const id = workspaceSession(crypto.randomUUID());
  const { editMsg } = seedWork(id);
  db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type, estimated_tokens) VALUES (?, ?, ?, ?)').run(editMsg.id, '/tmp/notes.txt', 'text/plain', 4);
  const result = await compressWork(id, 'Cascade summary.', stubDraft());
  assert.equal(result.compressed, true);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM workspace_task_briefs WHERE session_id = ?').get(id).n > 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM workspace_checkpoints WHERE session_id = ?').get(id).n > 0);
  sessions.deleteSession(id);
  for (const table of ['messages', 'session_summaries', 'workspace_task_briefs', 'workspace_checkpoints']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id).n, 0, `${table} cleaned`);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE m.session_id = ?`).get(id).n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('restart clears a stuck compression lock and marks in-progress work interrupted without losing the checkpoint', async () => {
  const id = workspaceSession(crypto.randomUUID());
  seedWork(id);
  const result = await compressWork(id, 'Restart summary.', stubDraft());
  assert.equal(result.compressed, true);
  // Simulate a crash mid-generation: stuck lock plus an in-progress reply
  // carrying a running tool step.
  const running = sessions.saveMessage(id, 'assistant', 'Still working.', [], null, null, null, null, null,
    [{ id: 'run-9', type: 'tool_call', toolName: 'execute_command', status: 'running', args: { command: 'sleep 99' } }]);
  db.prepare("UPDATE messages SET status = 'in_progress' WHERE id = ?").run(running.id);
  db.prepare('UPDATE sessions SET is_compressing = 1 WHERE id = ?').run(id);
  closeDatabase();
  initDatabase();
  assert.equal(db.prepare('SELECT is_compressing AS v FROM sessions WHERE id = ?').get(id).v, 0);
  const row = db.prepare('SELECT status, content, execution_steps FROM messages WHERE id = ?').get(running.id);
  assert.equal(row.status, 'interrupted');
  assert.ok(row.content.includes('interrupted by application restart'));
  const steps = JSON.parse(row.execution_steps);
  assert.equal(steps.find(step => step.id === 'run-9').status, 'error');
  const checkpoint = checkpoints.getLatestCheckpoint(id);
  assert.ok(checkpoint);
  assert.equal(checkpoint.id, result.checkpointId);
  assert.equal(checkpoint.summary_text, '');
  assert.ok(sessions.loadSession(id).messages.length > 0);
});

test('a database failure mid-commit rolls back archival, summary, and checkpoint together', async () => {
  const id = workspaceSession(crypto.randomUUID());
  const { editMsg, cmdMsg } = seedWork(id);
  const before = sessions.loadSession(id).messages.map(row => ({ id: row.id, archived: row.archived, content: row.content }));
  // Sabotage the summary write (the last statement group of the commit):
  // SELECTs still work, so the failure lands after archival statements.
  db.prepare(`CREATE TRIGGER boom_update BEFORE UPDATE ON workspace_checkpoints BEGIN SELECT RAISE(ABORT, 'boom-update'); END`).run();
  db.prepare(`CREATE TRIGGER boom_insert BEFORE INSERT ON workspace_checkpoints BEGIN SELECT RAISE(ABORT, 'boom-insert'); END`).run();
  try {
    await assert.rejects(compressWork(id, 'Lost summary.', checkpointDraft(editMsg.id, cmdMsg.id)), /boom-/);
    assert.ok(sessions.loadSession(id).messages.every(row => row.archived === 0 && row.is_summarized === 0));
    assert.deepEqual(sessions.loadSession(id).messages.map(row => ({ id: row.id, archived: row.archived, content: row.content })), before);
    assert.equal(sessions.getSessionSummary(id), null);
    assert.equal(checkpoints.getLatestCheckpoint(id), null);
    assert.equal(sessions.loadSession(id).is_compressing, 0);
  } finally {
    db.prepare('DROP TRIGGER IF EXISTS boom_update').run();
    db.prepare('DROP TRIGGER IF EXISTS boom_insert').run();
  }
});

test('branching isolates checkpoint state and later briefs', async () => {
  const id = workspaceSession(crypto.randomUUID());
  seedWork(id);
  const first = await compressWork(id, 'Branch summary.', stubDraft());
  assert.equal(first.compressed, true);
  const target = sessions.loadSession(id).messages.find(row => row.content.startsWith('Filler5'));
  assert.ok(target);
  const { sessionId: branched } = sessions.branchChat(id, target.id);
  // The new branch has no checkpoint rows and its prompt carries none.
  assert.equal(checkpoints.getLatestCheckpoint(branched), null);
  const rebuilt = rebuildChatMessages({ sessionId: branched, modelId: MODEL });
  const joined = rebuilt.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.ok(!joined.includes(checkpoints.CHECKPOINT_MARKER));
  // Later instructions from beyond the branch point do not leak across.
  assert.ok(!joined.includes('Filler20'));
  const branchedBriefs = briefs.getApplicableBriefs(branched);
  assert.ok(branchedBriefs.length > 0);
  assert.ok(branchedBriefs.every(brief => !brief.content_text.startsWith('Filler20')));
  // The source session is untouched: checkpoint current, prompt intact.
  assert.equal(checkpoints.getLatestCheckpoint(id).id, first.checkpointId);
  const sourcePrompt = rebuildChatMessages({ sessionId: id, modelId: MODEL }).map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.ok(sourcePrompt.includes(checkpoints.CHECKPOINT_MARKER));
});

test('full lifecycle: compress, reload, continue, ordered prompt, inspect', async () => {
  const id = workspaceSession(crypto.randomUUID());
  const { editMsg, cmdMsg } = seedWork(id);
  const result = await compressWork(id, 'Lifecycle summary.', checkpointDraft(editMsg.id, cmdMsg.id));
  assert.equal(result.compressed, true);
  // Checkpoint tied to the correct summary, brief identity, archived set.
  const row = checkpoints.getLatestCheckpoint(id);
  assert.equal(row.id, result.checkpointId);
  assert.equal(row.summary_text, '');
  assert.equal(row.brief_identity, briefs.getBriefIdentity(id));
  const archivedIds = db.prepare('SELECT id FROM messages WHERE session_id = ? AND archived = 1 ORDER BY id').all(id).map(item => item.id);
  assert.deepEqual(JSON.parse(row.archived_ids_json), archivedIds);
  assert.ok(archivedIds.length > 0);
  assert.equal(checkpoints.isCheckpointStale(id, row).stale, false);
  // Reload and recover everything.
  closeDatabase();
  initDatabase();
  assert.equal(checkpoints.getLatestCheckpoint(id).id, result.checkpointId);
  assert.ok(briefs.getApplicableBriefs(id).some(brief => brief.content_text === 'Build the widget.'));
  assert.equal(sessions.getSessionSummary(id), null);
  assert.ok(sessions.loadSession(id).messages.length > 0);
  // Continue the conversation, then verify prompt order and staleness.
  sessions.saveMessage(id, 'user', 'Follow-up instruction.');
  sessions.saveMessage(id, 'assistant', 'Done.');
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const contents = prompt.map(message => typeof message.content === 'string' ? message.content : '');
  const joined = contents.join('\n');
  const iBrief = contents.findIndex(content => content.includes(briefs.SECTION_MARKER));
  const iCheckpoint = contents.findIndex(content => content.includes(checkpoints.CHECKPOINT_MARKER));
  const iSummary = contents.findIndex(content => content.includes('[EARLIER CONVERSATION SUMMARY]:'));
  assert.ok(iBrief >= 0 && iCheckpoint > iBrief && iSummary === -1, 'brief then checkpoint; obsolete rolling summary excluded');
  assert.ok(joined.includes('Follow-up instruction.'));
  assert.ok(contents[contents.length - 1].includes('Done.'));
  const checkpointSection = prompt.find(message => message.taskCheckpoint === true);
  assert.ok(checkpointSection);
  assert.equal(checkpointSection.checkpointStale, true);
  const briefSection = prompt.find(message => message.taskBrief === true);
  assert.ok(briefSection.briefIds.length >= 1);
  // Inspect through the read-only layer.
  const displayed = inspection.getCheckpointForDisplay(id);
  assert.equal(displayed.checkpoint.id, result.checkpointId);
  assert.equal(displayed.checkpoint.stale, true);
  assert.ok(displayed.checkpoint.staleReasons.length > 0);
  assert.equal(inspection.getCheckpointHistoryForDisplay(id).checkpoints.length, 1);
  assert.ok(inspection.getBriefsForDisplay(id).applicable.some(brief => brief.content_text === 'Follow-up instruction.'));
  assert.equal(inspection.getSummaryForDisplay(id).text, null);
  assert.equal(inspection.getArchivedMessagesForDisplay(id, {}).total, archivedIds.length);
});

test('forced recovery events report success with checkpointId and failure with error', async () => {
  let checkpointShouldFail = false;
  disposeIpc = require('../src/main/ipcHandlers').registerIpcHandlers({
    isTrustedSender: () => true,
    getEngineConfig: () => ({ modelPath: 'model', port: 9999, activeModelConfig: { contextLength: 32768 } }),
    llmSummarizeCallback: async () => 'Event summary.',
    llmCheckpointCallback: async (_input, _model, { candidateRequest }) => {
      if (checkpointShouldFail) throw new Error('checkpoint backend offline');
      const input = JSON.parse(candidateRequest.messages[1].content);
      const draft = { objective: 'Event task', briefIds: input.briefs.map(b => b.id) };
      for (const key of require('../src/main/workspaceCompactCandidate').ARRAY_KEYS) draft[key] = [];
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] };
    },
  });
  const sent = [];
  const localSender = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false });
  const localEvent = { sender: localSender };
  const runChat = (chatId) => registered.get('engine:chat')(localEvent, { requestId: chatId, messageId: chatId, sessionId: chatId, modelId: MODEL, activeChatProvider: { type: 'local' },
    messages: prepareChatMessages({ sessionId: chatId, modelId: MODEL, userText: 'Go.', regenerate: false }) });
  // Success path: overflow once, recover, complete. History stays small
  // enough that the post-recovery prompt fits the window.
  const okId = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(okId, 'user', 'Event brief.');
  sessions.saveMessage(okId, 'assistant', 'Working.', [], null, null, null, null, null,
    [{ id: 'ev-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
      args: { command: 'make' }, result: { stdout: 'ok', stderr: '', exitCode: 0 } }]);
  for (let i = 0; i < 12; i++) sessions.saveMessage(okId, i % 2 ? 'assistant' : 'user', `Ev${i} `.padEnd(2000, 'x'));
  // Force a backend overflow regardless of measured size; the post-recovery
  // prompt fits the production-like window below.
  const bigOverflow = () => new Response(JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 40000, n_ctx: 32768 } }), { status: 400 });
  const runWithOverflow = () => {
    transport = backend({ context: 32768, tokens: text => Math.ceil(text.length / 4),
      infer: (_payload, count) => count === 1 ? bigOverflow() : Response.json({ choices: [{ message: { content: 'Done.' } }], finish_reason: 'stop' }) });
  };
  runWithOverflow();
  const okResult = await runChat(okId);
  assert.ok(okResult.text.includes('Done.'));
  const success = sent.filter(item => item.channel === 'session:compression-complete' && item.payload.sessionId === okId).at(-1);
  assert.ok(success);
  assert.equal(success.payload.compressed, true);
  assert.ok(Number.isSafeInteger(success.payload.checkpointId));
  assert.ok(success.payload.archivedCount > 0);
  assert.ok(!/saved\s+\d+|tokens?\s+(saved|freed|reclaimed)|free\s+.*tokens?/i.test(JSON.stringify(success.payload)), 'no token-saving claims in completion events');
  // Failure path: checkpoint drafting throws mid-recovery.
  checkpointShouldFail = true;
  const failId = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(failId, 'user', 'Failing brief.');
  for (let i = 0; i < 12; i++) sessions.saveMessage(failId, i % 2 ? 'assistant' : 'user', `Fl${i} `.padEnd(100, 'x'));
  const failBefore = sessions.loadSession(failId).messages.map(row => ({ id: row.id, archived: row.archived }));
  runWithOverflow();
  await assert.rejects(runChat(failId), /cannot fit/i);
  const failure = sent.filter(item => item.channel === 'session:compression-complete' && item.payload.sessionId === failId).at(-1);
  assert.ok(failure, 'failure event sent');
  assert.equal(failure.payload.compressed, false);
  assert.equal(failure.payload.reason, 'provider-error');
  // Failed recovery archives nothing, writes no summary or checkpoint, and
  // preserves every pre-existing message (the engine may persist its own
  // in-flight user/assistant rows, which stay unarchived).
  const failAfter = sessions.loadSession(failId).messages;
  assert.ok(failAfter.every(row => row.archived === 0 && row.is_summarized === 0));
  for (const { id: messageId, archived } of failBefore) {
    assert.ok(failAfter.some(row => row.id === messageId && row.archived === archived));
  }
  assert.equal(sessions.getSessionSummary(failId), null);
  assert.equal(checkpoints.getLatestCheckpoint(failId), null);
});
