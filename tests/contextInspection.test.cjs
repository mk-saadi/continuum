const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-inspection-'));
const load = Module._load;
const registered = new Map();
const mcp = Object.assign(new EventEmitter(), { init: async () => {}, reload: async () => {}, getTools: () => [], getStatus: () => ({ servers: [] }), configPath: path.join(directory, 'mcp.json') });
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn), removeHandler: channel => registered.delete(channel) },
    Notification: { isSupported: () => false }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } };
  if (name === './mcpManager') return mcp;
  return load.call(this, name, ...args);
};

const { db, initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const compression = require('../src/main/compressionEngine');
const inspection = require('../src/main/contextInspection');

const project = projects.createProject({ name: 'Inspection Project' });
const MODEL = 'model';
const LIMIT = 2600;

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

const SUMMARY_TEXT = 'First summary.';
function checkpointDraft(editId, cmdId, bigId) {
  return {
    objective: 'Build the widget and keep it green.',
    outstandingRequirements: [],
    completedWork: [
      { text: 'Edited src/foo.js.', sources: [{ messageId: editId, stepId: 'edit-1' }] },
      { text: 'Ran the suite.', sources: [{ messageId: cmdId, stepId: 'cmd-1' }] },
      { text: 'Big output observed.', sources: [{ messageId: bigId, stepId: 'big-1' }] },
    ],
    decisions: [{ text: 'Use the existing runner.', verified: false }],
    inProgress: [{ text: 'Waiting on review.', status: 'unknown' }],
    filesChanged: [{ path: 'src/foo.js', nature: 'edited', verified: true, stepRef: { messageId: editId, stepId: 'edit-1' } }],
    commands: [{ command: 'npm test', stepRef: { messageId: cmdId, stepId: 'cmd-1' } }],
    tests: [{ command: 'npm test', stepRef: { messageId: cmdId, stepId: 'cmd-1' } }],
    blockers: ['Waiting on review.'],
    risks: [],
    unknowns: ['Unknown perf impact.'],
    nextActions: ['Ship it.'],
  };
}

// Rich workspace session: briefs, evidence-bearing assistant turns (one with
// oversized tool output), filler history, then a real compression.
async function seedCompressed() {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Build the widget.');
  const editMsg = sessions.saveMessage(id, 'assistant', 'Editing now.', [], null, null, null, null, null,
    [{ id: 'edit-1', type: 'tool_call', toolName: 'str_replace_editor', status: 'complete',
      args: { relative_path: 'src/foo.js', old_str: 'a', new_str: 'b' }, result: { success: true } }]);
  const cmdMsg = sessions.saveMessage(id, 'assistant', 'Testing now.', [], null, null, null, null, null,
    [{ id: 'cmd-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
      args: { command: 'npm test' }, result: { stdout: '5 passed\n5 tests', stderr: '', exitCode: 0 } }]);
  const bigMsg = sessions.saveMessage(id, 'assistant', 'Large output.', [], null, null, null, null, null,
    [{ id: 'big-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
      args: { command: 'yes' }, result: { stdout: 'y'.repeat(5000), stderr: '', exitCode: 0 } }]);
  sessions.saveMessage(id, 'user', 'Second instruction.');
  for (let i = 0; i < 22; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Filler${i} `.padEnd(400, 'x'));
  const result = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => SUMMARY_TEXT,
    llmCheckpointCallback: async () => checkpointDraft(editMsg.id, cmdMsg.id, bigMsg.id),
  });
  assert.equal(result.compressed, true);
  assert.ok(Number.isSafeInteger(result.checkpointId));
  return { id, editMsg, cmdMsg, bigMsg, result };
}

const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true });
const sender = Object.assign(new EventEmitter(), { send: () => {}, isDestroyed: () => false });
const event = { sender };
const invoke = (channel, payload) => registered.get(channel)(event, payload);

test.after(() => { dispose(); closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });

test('checkpoint retrieval exposes version, status, evidence, and summary bindings', async () => {
  const { id, editMsg, cmdMsg } = await seedCompressed();
  const { checkpoint, evidence } = inspection.getCheckpointForDisplay(id);
  assert.ok(checkpoint);
  assert.ok(Number.isSafeInteger(checkpoint.id));
  assert.equal(checkpoint.status, 'current');
  assert.ok(typeof checkpoint.created_at === 'string' && checkpoint.created_at.length > 0);
  assert.equal(checkpoint.stale, false);
  assert.deepEqual(checkpoint.staleReasons, []);
  assert.equal(checkpoint.checkpoint.objective, 'Build the widget and keep it green.');
  assert.equal(checkpoint.summary.text, SUMMARY_TEXT);
  assert.ok(checkpoint.archivedCount > 0);
  const editKey = `${editMsg.id}:edit-1`;
  assert.equal(evidence[editKey].found, true);
  assert.equal(evidence[editKey].toolName, 'str_replace_editor');
  assert.equal(evidence[editKey].status, 'success');
  const cmdKey = `${cmdMsg.id}:cmd-1`;
  assert.equal(evidence[cmdKey].found, true);
  assert.ok(evidence[cmdKey].snippet.includes('5 passed'));
  // Fresh session without compression has no checkpoint.
  const fresh = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(fresh, 'user', 'Hello.');
  assert.deepEqual(inspection.getCheckpointForDisplay(fresh), { checkpoint: null });
});

test('missing evidence resolves explicitly and staleness names the cause', async () => {
  const { id, cmdMsg } = await seedCompressed();
  // Wipe the recorded steps of one covered message: the reference stays in
  // the checkpoint but no longer resolves to a persisted record.
  db.prepare('UPDATE messages SET execution_steps = ? WHERE id = ?').run(JSON.stringify([]), cmdMsg.id);
  const { checkpoint, evidence } = inspection.getCheckpointForDisplay(id);
  assert.ok(checkpoint);
  assert.deepEqual(evidence[`${cmdMsg.id}:cmd-1`], { found: false });
  assert.equal(checkpoint.stale, true);
  assert.ok(checkpoint.staleReasons.includes('covered execution evidence changed'));
  // Other evidence still resolves.
  const keys = Object.keys(evidence).filter(key => evidence[key].found);
  assert.ok(keys.length > 0);
});

test('checkpoint history lists versions with bounds and staleness', async () => {
  const { id } = await seedCompressed();
  const first = inspection.getCheckpointHistoryForDisplay(id);
  assert.equal(first.limit, 10);
  assert.equal(first.checkpoints.length, 1);
  assert.equal(first.checkpoints[0].status, 'current');
  const one = inspection.getCheckpointHistoryForDisplay(id, 1);
  assert.equal(one.limit, 1);
  assert.equal(one.checkpoints.length, 1);
  const clamped = inspection.getCheckpointHistoryForDisplay(id, 999);
  assert.equal(clamped.limit, 25);
  assert.ok(clamped.checkpoints.length <= 25);
});

test('brief display is verbatim with branch applicability and attachment flags', async () => {
  const { id } = await seedCompressed();
  // Direct brief row referencing a missing file exercises the availability flag.
  const ghostId = Number(db.prepare(`INSERT INTO workspace_task_briefs
    (session_id, message_id, kind, content_text, attachments_json) VALUES (?, NULL, 'instruction', 'Ghost note.', ?)`)
    .run(id, JSON.stringify([{ file_path: '/nonexistent/ghost.txt', mime_type: 'text/plain', file_name: 'ghost.txt', size: 12 }])).lastInsertRowid);
  assert.ok(Number.isSafeInteger(ghostId));
  const before = inspection.getBriefsForDisplay(id);
  assert.ok(before.applicable.some(brief => brief.content_text === 'Build the widget.'));
  assert.ok(before.applicable.some(brief => brief.content_text === 'Second instruction.'));
  assert.ok(before.applicable.every(brief => brief.applicable === true));
  // Switch branches: editing the first user message moves the active leaf to
  // a sibling branch, so the original brief is retained but not applicable.
  const firstUser = db.prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1").get(id);
  sessions.editMessage(firstUser.id, 'Build the widget, revised.');
  const after = inspection.getBriefsForDisplay(id);
  const revised = after.applicable.find(brief => brief.content_text === 'Build the widget, revised.');
  assert.ok(revised && revised.kind === 'revision');
  const original = after.others.find(brief => brief.content_text === 'Build the widget.');
  assert.ok(original, 'superseded brief retained with full text');
  assert.equal(original.applicable, false);
  const ghost = after.others.find(brief => brief.id === ghostId);
  assert.ok(ghost);
  assert.equal(ghost.attachments[0].available, false);
  assert.equal(ghost.attachments[0].file_name, 'ghost.txt');
});

test('summary display returns text and null states', async () => {
  const { id } = await seedCompressed();
  assert.equal(inspection.getSummaryForDisplay(id).text, SUMMARY_TEXT);
  const fresh = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(fresh, 'user', 'Hello.');
  assert.equal(inspection.getSummaryForDisplay(fresh).text, null);
});

test('archived messages paginate on the active branch with bounded steps', async () => {
  const { id, bigMsg, result } = await seedCompressed();
  const total = result.archivedCount;
  assert.ok(total > 5);
  const first = inspection.getArchivedMessagesForDisplay(id, { limit: 5, offset: 0 });
  assert.equal(first.total, total);
  assert.equal(first.limit, 5);
  assert.equal(first.offset, 0);
  assert.equal(first.messages.length, 5);
  assert.ok(first.messages[0].id < first.messages[4].id);
  const second = inspection.getArchivedMessagesForDisplay(id, { limit: 5, offset: 5 });
  assert.deepEqual(second.messages.map(message => message.id).filter(messageId => first.messages.some(message => message.id === messageId)), []);
  const beyond = inspection.getArchivedMessagesForDisplay(id, { limit: 5, offset: total + 50 });
  assert.deepEqual(beyond.messages, []);
  assert.equal(beyond.total, total);
  const clamped = inspection.getArchivedMessagesForDisplay(id, { limit: 9999 });
  assert.equal(clamped.limit, 100);
  // Roles, timestamps, full content, and bounded execution output.
  const big = first.messages.concat(second.messages).find(message => message.id === bigMsg.id)
    ?? inspection.getArchivedMessagesForDisplay(id, { limit: total }).messages.find(message => message.id === bigMsg.id);
  assert.ok(big);
  assert.equal(big.role, 'assistant');
  assert.ok(typeof big.created_at === 'string');
  assert.ok(big.content.includes('Large output.'));
  const step = big.executionSteps.find(entry => entry.id === 'big-1');
  assert.ok(step);
  assert.equal(step.toolName, 'execute_command');
  assert.equal(step.status, 'complete');
  assert.equal(step.resultTruncated, true);
  assert.equal(step.result.length, 2000);
});

test('archived inspection is read-only and branch-aware', async () => {
  const { id } = await seedCompressed();
  const fingerprint = () => ({
    messages: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS len FROM messages').get(),
    briefs: db.prepare('SELECT COUNT(*) AS n FROM workspace_task_briefs').get(),
    checkpoints: db.prepare('SELECT COUNT(*) AS n FROM workspace_checkpoints').get(),
  });
  const before = fingerprint();
  inspection.getArchivedMessagesForDisplay(id, { limit: 50 });
  inspection.getCheckpointForDisplay(id);
  inspection.getCheckpointHistoryForDisplay(id);
  inspection.getBriefsForDisplay(id);
  inspection.getSummaryForDisplay(id);
  assert.deepEqual(fingerprint(), before);
  // Branching to an early message resets archival on the new branch; the
  // source session keeps its own archived rows.
  const target = db.prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND content = 'Second instruction.'").get(id);
  const { sessionId: branched } = sessions.branchChat(id, target.id);
  assert.equal(inspection.getArchivedMessagesForDisplay(branched, {}).total, 0);
  assert.ok(inspection.getArchivedMessagesForDisplay(id, {}).total > 0);
  const branchedBriefs = inspection.getBriefsForDisplay(branched);
  assert.ok(branchedBriefs.applicable.some(brief => brief.content_text === 'Build the widget.'));
  assert.ok(branchedBriefs.applicable.every(brief => !brief.content_text.startsWith('Filler')));
});

test('IPC handlers return inspection payloads through the guarded dispatch', async () => {
  const { id } = await seedCompressed();
  assert.equal((await invoke('session:get-checkpoint', { sessionId: id })).checkpoint.id,
    inspection.getCheckpointForDisplay(id).checkpoint.id);
  assert.deepEqual(await invoke('session:get-checkpoint-history', { sessionId: id, limit: 2 }),
    inspection.getCheckpointHistoryForDisplay(id, 2));
  assert.deepEqual(await invoke('session:get-briefs', { sessionId: id }),
    inspection.getBriefsForDisplay(id));
  assert.deepEqual(await invoke('session:get-archived-messages', { sessionId: id, limit: 3, offset: 1 }),
    inspection.getArchivedMessagesForDisplay(id, { limit: 3, offset: 1 }));
});

test('IPC handlers reject unauthorized senders and invalid input', async () => {
  const { id } = await seedCompressed();
  const denied = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => false });
  try {
    await assert.rejects(invoke('session:get-checkpoint', { sessionId: id }), /Unauthorized IPC sender/);
    await assert.rejects(invoke('session:get-briefs', { sessionId: id }), /Unauthorized IPC sender/);
  } finally {
    denied();
    require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true });
  }
  assert.deepEqual(await invoke('session:get-checkpoint', { sessionId: 'missing-session' }), { checkpoint: null });
  await assert.rejects(invoke('session:get-briefs', { sessionId: '' }), /non-empty string/);
  await assert.rejects(invoke('session:get-briefs', { sessionId: 'a\0b' }), /null characters/);
  await assert.rejects(invoke('session:get-archived-messages', { sessionId: id, limit: 'many' }), /safe integers/);
  await assert.rejects(invoke('session:get-archived-messages', { sessionId: id, offset: -1 }), /non-negative/);
  await assert.rejects(invoke('session:get-checkpoint', undefined), /destructure|undefined/);
});

test('casual sessions return empty inspection states', async () => {
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL);
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Casual${i} `.padEnd(100, 'x'));
  assert.deepEqual(inspection.getCheckpointForDisplay(id), { checkpoint: null });
  assert.deepEqual(inspection.getCheckpointHistoryForDisplay(id), { checkpoints: [], limit: 10 });
  assert.deepEqual(inspection.getBriefsForDisplay(id), { applicable: [], others: [] });
  assert.equal(inspection.getSummaryForDisplay(id).text, null);
  assert.deepEqual(await invoke('session:get-checkpoint', { sessionId: id }), { checkpoint: null });
});


test('draft and deleted sessions have empty inspection without creating a database row', async () => {
  const id = crypto.randomUUID();
  const empty = async () => {
    assert.deepEqual(await invoke('session:get-checkpoint', { sessionId: id }), { checkpoint: null });
    assert.deepEqual(await invoke('session:get-checkpoint-history', { sessionId: id, limit: 3 }), { checkpoints: [], limit: 3 });
    assert.deepEqual(await invoke('session:get-briefs', { sessionId: id }), { applicable: [], others: [] });
    assert.deepEqual(await invoke('session:get-archived-messages', { sessionId: id, limit: 5, offset: 2 }), { messages: [], total: 0, limit: 5, offset: 2 });
    assert.deepEqual(inspection.getSummaryForDisplay(id), { text: null });
    assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), undefined);
    await assert.rejects(invoke('session:get-archived-messages', { sessionId: id, offset: -1 }), /non-negative/);
  };
  await empty();
  sessions.getOrCreateSession(id, MODEL);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  await empty();
});
