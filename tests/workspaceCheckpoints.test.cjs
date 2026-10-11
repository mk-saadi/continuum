const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-checkpoints-'));
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const briefs = require('../src/main/taskBriefs');
const checkpoints = require('../src/main/taskCheckpoints');
const { prepareChatMessages, rebuildChatMessages } = require('../src/main/promptBuilder');
const compression = require('../src/main/compressionEngine');

const project = projects.createProject({ name: 'Checkpoint Project' });
const MODEL = 'model';
const LIMIT = 2600;

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

function checkpointSections(prompt) {
  return prompt.filter(message => message.taskCheckpoint === true
    || (message.role === 'system' && typeof message.content === 'string'
      && message.content.includes(checkpoints.CHECKPOINT_MARKER)));
}

const toolStep = (overrides) => ({
  id: 'step', type: 'tool_call', toolName: 'execute_command', status: 'complete',
  args: { command: 'run' }, result: { stdout: 'ok', stderr: '', exitCode: 0 }, ...overrides,
});
const assistantWithSteps = (id, steps) => ({ id, role: 'assistant', execution_steps: JSON.stringify(steps) });
const indexFor = (rows) => checkpoints.evidenceIndex(checkpoints.collectEvidence(rows));
const stubDraft = () => ({ objective: 'Stub objective.', outstandingRequirements: [] });

test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('validator accepts verified claims and repairs or rejects the rest', () => {
  const rows = [
    assistantWithSteps(11, [
      toolStep({ id: 'edit-1', toolName: 'str_replace_editor', args: { relative_path: 'src/foo.js', old_str: 'a', new_str: 'b' }, result: { success: true } }),
      toolStep({ id: 'cmd-ok', args: { command: 'npm test' }, result: { stdout: '5 passed\n5 tests', stderr: '', exitCode: 0 } }),
      toolStep({ id: 'cmd-fail', args: { command: 'npm run bad' }, result: { stdout: '1 failed', stderr: '', exitCode: 1 } }),
      toolStep({ id: 'run-1', toolName: 'execute_command', status: 'running', args: { command: 'sleep 99' } }),
    ]),
  ];
  const index = indexFor(rows);
  const ctx = { sessionId: 'missing-session', briefs: [{ id: 7, content_text: 'Keep the widget green.' }], index };
  const draft = {
    objective: 'Build the widget.',
    outstandingRequirements: [{ text: 'Other note.', briefId: null, status: 'open' }],
    decisions: [{ text: 'Use X.', verified: true, sources: [{ messageId: 11, stepId: 'edit-1' }] }],
    completedWork: [
      { text: 'Edited foo.', sources: [{ messageId: 11, stepId: 'edit-1' }] },
      { text: 'Still running it.', sources: [{ messageId: 11, stepId: 'run-1' }] },
      { text: 'Invented triumph.', sources: [{ messageId: 11, stepId: 'nope' }] },
    ],
    inProgress: [{ text: 'Sleeping.', status: 'whatever', stepRef: { messageId: 11, stepId: 'run-1' } }],
    filesChanged: [
      { path: 'src/foo.js', nature: 'edited', verified: true, stepRef: { messageId: 11, stepId: 'edit-1' } },
      { path: 'src/ghost.js', nature: 'edited', verified: true, stepRef: { messageId: 11, stepId: 'edit-1' } },
    ],
    commands: [
      { command: 'npm test', stepRef: { messageId: 11, stepId: 'cmd-ok' } },
      { command: 'npm run bad', stepRef: { messageId: 11, stepId: 'cmd-fail' } },
    ],
    tests: [
      { command: 'npm test', stepRef: { messageId: 11, stepId: 'cmd-ok' }, passed: 99, failed: 99, total: 99 },
      { command: 'npm run bad', stepRef: { messageId: 11, stepId: 'cmd-fail' } },
    ],
    blockers: [' waiting '],
    risks: [], unknowns: [], nextActions: ['Ship it.'],
  };
  const result = checkpoints.validateCheckpoint(draft, ctx);
  assert.equal(result.ok, true);
  const checkpoint = result.checkpoint;
  // Brief coverage repaired, never lost.
  assert.ok(checkpoint.outstandingRequirements.some(req => req.briefId === 7 && req.text === 'Keep the widget green.'));
  assert.equal(checkpoint.decisions[0].verified, true);
  // Only the evidence-backed completion survives as verified; the running
  // and dangling claims are demoted to unknowns.
  assert.deepEqual(checkpoint.completedWork.map(item => item.text), ['Edited foo.']);
  assert.ok(checkpoint.unknowns.some(text => text.includes('Still running it.')));
  assert.ok(checkpoint.unknowns.some(text => text.includes('Invented triumph.')));
  assert.equal(checkpoint.inProgress[0].status, 'unknown');
  assert.deepEqual(checkpoint.inProgress[0].stepRef, { messageId: 11, stepId: 'run-1' });
  assert.equal(checkpoint.filesChanged[0].verified, true);
  assert.equal(checkpoint.filesChanged[1].verified, false);
  // Exit codes come from evidence; model counts are replaced by parsed output.
  assert.equal(checkpoint.commands[0].exitCode, 0);
  assert.equal(checkpoint.commands[0].verified, true);
  assert.equal(checkpoint.commands[1].exitCode, 1);
  assert.equal(checkpoint.commands[1].verified, false);
  assert.deepEqual([checkpoint.tests[0].passed, checkpoint.tests[0].failed, checkpoint.tests[0].total], [5, null, 5]);
  assert.equal(checkpoint.tests[0].parsedAs, 'regex');
  assert.equal(checkpoint.tests[0].verified, true);
  assert.equal(checkpoint.tests[1].verified, false);
  assert.deepEqual(checkpoint.blockers, ['waiting']);
  assert.ok(result.repaired.length > 0);
});

test('validator fails structurally invalid drafts', () => {
  const ctx = { sessionId: 's', briefs: [], index: new Map() };
  assert.equal(checkpoints.validateCheckpoint(null, ctx).ok, false);
  assert.equal(checkpoints.validateCheckpoint('text', ctx).ok, false);
  assert.equal(checkpoints.validateCheckpoint({ outstandingRequirements: [] }, ctx).ok, false);
  assert.equal(checkpoints.validateCheckpoint({ objective: '  ', outstandingRequirements: [] }, ctx).ok, false);
  assert.equal(checkpoints.validateCheckpoint({ objective: 'x', outstandingRequirements: {} }, ctx).ok, false);
  // Brief-anchored requirements keep full verbatim text; briefs totaling
  // over the cap fail closed instead of truncating requirements away.
  const hugeBriefs = [{ id: 1, content_text: 'a'.repeat(5000) }, { id: 2, content_text: 'b'.repeat(5000) }];
  const oversized = checkpoints.validateCheckpoint({ objective: 'x', outstandingRequirements: [] },
    { sessionId: 's', briefs: hugeBriefs, index: new Map() });
  assert.equal(oversized.ok, false);
  assert.ok(oversized.errors.some(error => error.includes('size cap')));
});

test('checkpoint creation persists a validated, evidence-bound row', async () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Build the widget.');
  const editMsg = sessions.saveMessage(id, 'assistant', 'Editing now.', [], null, null, null, null, null,
    [{ id: 'edit-1', type: 'tool_call', toolName: 'str_replace_editor', status: 'complete',
      args: { relative_path: 'src/foo.js', old_str: 'a', new_str: 'b' }, result: { success: true } }]);
  const cmdMsg = sessions.saveMessage(id, 'assistant', 'Testing now.', [], null, null, null, null, null,
    [{ id: 'cmd-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
      args: { command: 'npm test' }, result: { stdout: '5 passed\n5 tests', stderr: '', exitCode: 0 } }]);
  for (let i = 0; i < 22; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Filler${i} `.padEnd(400, 'x'));
  const result = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'First summary.',
    llmCheckpointCallback: async () => ({
      objective: 'Build the widget and keep it green.',
      outstandingRequirements: [],
      completedWork: [
        { text: 'Edited src/foo.js.', sources: [{ messageId: editMsg.id, stepId: 'edit-1' }] },
        { text: 'Ran the suite.', sources: [{ messageId: cmdMsg.id, stepId: 'cmd-1' }] },
      ],
      filesChanged: [{ path: 'src/foo.js', nature: 'edited', verified: true, stepRef: { messageId: editMsg.id, stepId: 'edit-1' } }],
      commands: [{ command: 'npm test', stepRef: { messageId: cmdMsg.id, stepId: 'cmd-1' } }],
      tests: [{ command: 'npm test', stepRef: { messageId: cmdMsg.id, stepId: 'cmd-1' } }],
      nextActions: ['Ship it.'],
    }),
  });
  assert.equal(result.compressed, true);
  assert.ok(Number.isSafeInteger(result.checkpointId));
  const row = checkpoints.getLatestCheckpoint(id);
  assert.equal(row.id, result.checkpointId);
  assert.equal(row.status, 'current');
  assert.equal(row.checkpoint.objective, 'Build the widget and keep it green.');
  assert.ok(row.checkpoint.outstandingRequirements.some(req => req.text === 'Build the widget.'));
  assert.equal(row.checkpoint.commands[0].exitCode, 0);
  assert.equal(row.summary_text, 'First summary.');
  assert.ok(JSON.stringify(row.checkpoint).length <= checkpoints.CHECKPOINT_BYTE_CAP);
  const stale = checkpoints.isCheckpointStale(id, row);
  assert.equal(stale.stale, false);
});

test('repeated compressions version checkpoints without losing requirements', async () => {
  const id = workspaceSession(crypto.randomUUID());
  // Short instructions (small briefs) with long assistant outputs, mirroring
  // real coding sessions where tool results dominate token usage.
  sessions.saveMessage(id, 'user', 'First requirement.');
  for (let i = 0; i < 10; i++) sessions.saveMessage(id, 'user', `Note A${i}.`);
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, 'assistant', `A${i} `.padEnd(500, 'x'));
  const compress = (summary) => compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => summary,
    llmCheckpointCallback: stubDraft,
  });
  const first = await compress('Summary one.');
  assert.equal(first.compressed, true);
  sessions.saveMessage(id, 'user', 'Second requirement.');
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, 'user', `Note B${i}.`);
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, 'assistant', `B${i} `.padEnd(500, 'y'));
  const second = await compress('Summary two.');
  assert.equal(second.compressed, true);
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, 'user', `Note C${i}.`);
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, 'assistant', `C${i} `.padEnd(500, 'z'));
  sessions.saveMessage(id, 'user', 'Third requirement.');
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, 'user', `Note D${i}.`);
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, 'assistant', `D${i} `.padEnd(500, 'w'));
  const third = await compress('Summary three.');
  assert.equal(third.compressed, true);
  assert.ok(first.checkpointId < second.checkpointId && second.checkpointId < third.checkpointId);
  const history = checkpoints.getCheckpointHistory(id);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(row => row.status), ['current', 'superseded', 'superseded']);
  for (const row of history) {
    assert.ok(JSON.stringify(row.checkpoint).length <= checkpoints.CHECKPOINT_BYTE_CAP);
    const texts = row.checkpoint.outstandingRequirements.map(req => req.text);
    assert.ok(texts.includes('First requirement.'));
  }
  const latest = checkpoints.getLatestCheckpoint(id);
  const latestTexts = latest.checkpoint.outstandingRequirements.map(req => req.text);
  assert.ok(latestTexts.includes('Second requirement.'));
  assert.ok(latestTexts.includes('Third requirement.'));
  assert.ok(latest.checkpoint.completedWork.length <= 15);
});

test('checkpoint-generation failure leaves no partial archival or summary', async () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Doomed requirement.');
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `E${i} `.padEnd(400, 'x'));
  const before = sessions.loadSession(id).messages.map(row => row.content);
  const failing = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Unpersisted summary.',
    llmCheckpointCallback: async () => { throw new Error('checkpoint backend offline'); },
  });
  assert.equal(failing.compressed, false);
  assert.equal(failing.reason, 'checkpoint-generation-failed');
  const invalid = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Unpersisted summary.',
    llmCheckpointCallback: async () => ({ objective: '   ', outstandingRequirements: [] }),
  });
  assert.equal(invalid.compressed, false);
  assert.equal(invalid.reason, 'checkpoint-invalid');
  assert.equal(sessions.getSessionSummary(id), null);
  assert.ok(sessions.loadSession(id).messages.every(row => row.archived === 0 && row.is_summarized === 0));
  assert.deepEqual(sessions.loadSession(id).messages.map(row => row.content), before);
  assert.equal(checkpoints.getLatestCheckpoint(id), null);
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});

test('stale snapshots reject without partial persistence', async () => {
  // Summary change mid-operation.
  const a = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(a, 'user', 'Stale A.');
  for (let i = 0; i < 20; i++) sessions.saveMessage(a, i % 2 ? 'assistant' : 'user', `A${i} `.padEnd(400, 'x'));
  await assert.rejects(compression.checkAndCompressContext({
    sessionId: a, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => {
      db.prepare("INSERT INTO session_summaries(session_id, summary_text) VALUES (?, 'Sneaky.')").run(a);
      return 'Discarded.';
    },
    llmCheckpointCallback: stubDraft,
  }), /Session summary changed during compression/);
  assert.equal(sessions.getSessionSummary(a), 'Sneaky.');
  assert.ok(sessions.loadSession(a).messages.every(row => row.archived === 0));
  assert.equal(checkpoints.getLatestCheckpoint(a), null);

  // Execution-step change mid-operation (bypasses message predicates).
  const b = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(b, 'user', 'Stale B.');
  const target = sessions.saveMessage(b, 'assistant', 'Work.', [], null, null, null, null, null,
    [{ id: 'w-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
      args: { command: 'make' }, result: { stdout: '', stderr: '', exitCode: 0 } }]);
  for (let i = 0; i < 20; i++) sessions.saveMessage(b, i % 2 ? 'assistant' : 'user', `B${i} `.padEnd(400, 'x'));
  await assert.rejects(compression.checkAndCompressContext({
    sessionId: b, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Discarded.',
    llmCheckpointCallback: async () => {
      db.prepare('UPDATE messages SET execution_steps = ? WHERE id = ?')
        .run(JSON.stringify([{ id: 'w-1', type: 'tool_call', toolName: 'execute_command', status: 'complete',
          args: { command: 'make clean' }, result: { stdout: '', stderr: '', exitCode: 0 } }]), target.id);
      return stubDraft();
    },
  }), /Task evidence changed during compression/);
  assert.equal(sessions.getSessionSummary(b), null);
  assert.ok(sessions.loadSession(b).messages.every(row => row.archived === 0));
  assert.equal(checkpoints.getLatestCheckpoint(b), null);
  assert.equal(sessions.loadSession(b).is_compressing, 0);
});

test('restart recovery retrieves the latest valid checkpoint', async () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Surviving requirement.');
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `R${i} `.padEnd(400, 'x'));
  const result = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Restart summary.',
    llmCheckpointCallback: stubDraft,
  });
  assert.equal(result.compressed, true);
  closeDatabase();
  initDatabase();
  const row = checkpoints.getLatestCheckpoint(id);
  assert.equal(row.id, result.checkpointId);
  assert.equal(row.checkpoint.objective, 'Stub objective.');
  assert.ok(row.checkpoint.outstandingRequirements.some(req => req.text === 'Surviving requirement.'));
  assert.equal(row.summary_text, 'Restart summary.');
  assert.equal(checkpoints.isCheckpointStale(id, row).stale, false);
  assert.ok(sessions.loadSession(id).messages.length > 0);
});

test('normal and forced construction select the same brief and checkpoint', async () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Parity requirement.');
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `P${i} `.padEnd(400, 'x'));
  await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Parity summary.',
    llmCheckpointCallback: stubDraft,
  });
  const prepared = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'Follow-up.', regenerate: false });
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const sections = (prompt) => prompt.filter(message => message.taskBrief === true || message.taskCheckpoint === true);
  const preparedSections = sections(prepared);
  const rebuiltSections = sections(rebuilt);
  assert.deepEqual(preparedSections.map(message => message.briefIds), rebuiltSections.map(message => message.briefIds));
  assert.equal(preparedSections.find(message => message.taskCheckpoint).checkpointId,
    rebuiltSections.find(message => message.taskCheckpoint).checkpointId);
  assert.equal(preparedSections.find(message => message.taskCheckpoint).checkpointStale, true);
  assert.ok(preparedSections.find(message => message.taskBrief).content.includes('Follow-up.'));
});

test('prospective measurement includes the candidate checkpoint', async () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Measured requirement.');
  for (let i = 0; i < 12; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `M${i} `.padEnd(100, 'x'));
  let seen = null;
  const result = await compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: 8192,
    llmSummarizeCallback: async () => 'Measured summary.',
    llmCheckpointCallback: async () => ({ objective: 'Measured objective.', outstandingRequirements: [] }),
    measurePrompt: async ({ messages, tools, limit }) => {
      seen = { messages, tools, limit };
      return { tokens: 10 ** 9, method: 'server-template-tokenizer', budget: 1 };
    } });
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'prospective-prompt-exceeds-budget');
  const joined = seen.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.ok(joined.includes(checkpoints.CHECKPOINT_MARKER));
  assert.ok(joined.includes('Measured objective.'));
  assert.ok(joined.includes('Measured summary.'));
  assert.ok(joined.includes(briefs.SECTION_MARKER));
  assert.equal(checkpoints.getLatestCheckpoint(id), null);
  assert.equal(sessions.getSessionSummary(id), null);
});

test('casual chat creates no checkpoints and receives no injection', async () => {
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL);
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `C${i} `.padEnd(400, 'x'));
  const result = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Casual summary.',
    llmCheckpointCallback: async () => { throw new Error('must never be called for Casual Chat'); },
  });
  assert.equal(result.compressed, true);
  assert.equal(result.checkpointId, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_checkpoints WHERE session_id = ?').get(id).n, 0);
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.ok(!rebuilt.some(message => message.taskCheckpoint === true));
  assert.ok(!JSON.stringify(rebuilt).includes(checkpoints.CHECKPOINT_MARKER));
});
