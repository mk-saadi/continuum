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

// W3 retires the legacy Workspace archive API. Transaction, stale-source,
// restart, prospective-fit and repeated-run coverage lives in
// workspaceSafeCompaction.test.cjs against the owning-loop pipeline.
test('legacy Workspace compression cannot activate checkpoints or archive history', async () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Retain this authoritative requirement.');
  sessions.saveMessage(id, 'assistant', 'Historical completed investigation.');
  const before = sessions.loadSession(id).messages;
  let calls = 0;
  const result = await compression.checkAndCompressContext({ sessionId: id, modelId: MODEL,
    contextWindowLimit: 8192, force: true,
    llmSummarizeCallback: async () => { calls++; throw new Error('unsafe fallback'); },
    llmCheckpointCallback: async () => { calls++; throw new Error('unsafe fallback'); } });
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'workspace-safe-boundary-required');
  assert.equal(calls, 0);
  assert.deepEqual(sessions.loadSession(id).messages, before);
  assert.equal(checkpoints.getLatestCheckpoint(id), null);
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
