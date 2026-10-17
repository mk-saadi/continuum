'use strict';
// Phase 3: work-log display serialization (brief attachment, staleness,
// token contribution). No UI framework here; the Electron render test lives
// in tests/workLogPanel.ui.cjs.
// Run with: node --test tests/workLogDisplay.test.cjs
// Temp dirs under os.tmpdir() only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-display-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const briefs = require('../src/main/taskBriefs');
const workLog = require('../src/main/workLog');
const inspection = require('../src/main/contextInspection');

const MODEL = 'model';

function workspace(id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-ws-'));
  const project = projects.createProject({ name: `wld-${id.slice(0, 8)}`, root_path: root });
  sessions.getOrCreateSession(id, MODEL, project.id);
  return { id, root };
}

function userTurn(id, text) {
  return sessions.saveMessage(id, 'user', text);
}

function assistantTurn(id, text, steps) {
  return sessions.saveMessage(id, 'assistant', text, [], null, null, null, null, null, steps);
}

const toolStep = (overrides) => ({
  id: `step-${crypto.randomUUID()}`,
  type: 'tool_call',
  status: 'complete',
  ...overrides,
});

test.after(() => {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('work log attaches to the correct brief, never the newest', () => {
  const { id, root } = workspace(crypto.randomUUID());
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  userTurn(id, 'First requirement.');
  const first = assistantTurn(id, 'First done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a\n' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: first.id, partial: false });
  userTurn(id, 'Second requirement.');
  const second = assistantTurn(id, 'Second done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'b.txt' }, result: { content: 'b\n' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: second.id, partial: false });

  const shown = inspection.getBriefsForDisplay(id);
  assert.equal(shown.applicable.length, 2);
  const [brief1, brief2] = shown.applicable;
  assert.ok(brief1.workLog);
  assert.ok(brief2.workLog);
  assert.deepEqual(brief1.workLog.turns.map((turn) => turn.turnSeq), [1]);
  assert.deepEqual(brief2.workLog.turns.map((turn) => turn.turnSeq), [2]);
  assert.match(brief1.workLog.turns[0].entries[0].summary, /a\.txt/);
  assert.doesNotMatch(brief1.workLog.turns[0].entries[0].summary, /b\.txt/);
  assert.match(brief2.workLog.turns[0].entries[0].summary, /b\.txt/);
  // Chips aggregate per brief, not across briefs.
  assert.equal(brief1.workLog.chips.turns, 1);
  assert.deepEqual(brief1.workLog.chips.read, ['a.txt']);
  assert.deepEqual(brief2.workLog.chips.read, ['b.txt']);
  assert.ok(!('unassignedWorkLog' in shown));
  fs.rmSync(root, { recursive: true, force: true });
});

test('revisions keep each digest under its own brief row', () => {
  const { id, root } = workspace(crypto.randomUUID());
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  const user = userTurn(id, 'Original wording.');
  const first = assistantTurn(id, 'Done once.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a\n' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: first.id, partial: false });
  sessions.editMessage(user.id, 'Corrected wording.');
  const second = assistantTurn(id, 'Done twice.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a\n' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: second.id, partial: false });

  const shown = inspection.getBriefsForDisplay(id);
  const all = [...shown.applicable, ...shown.others];
  const withLogs = all.filter((brief) => brief.workLog);
  assert.equal(withLogs.length, 2);
  const kinds = withLogs.map((brief) => brief.kind).sort();
  assert.deepEqual(kinds, ['original', 'revision']);
  // Each digest sits under its own brief row regardless of list placement.
  for (const brief of withLogs) {
    assert.equal(brief.workLog.turns.length, 1);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('digests without brief association surface as unassigned, never attached elsewhere', () => {
  const { id, root } = workspace(crypto.randomUUID());
  fs.writeFileSync(path.join(root, 'solo.txt'), 'solo\n');
  // Assistant turn with no preceding user message: no brief anchor exists.
  const assistant = assistantTurn(id, 'Background note.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'solo.txt' }, result: { content: 'solo\n' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  const shown = inspection.getBriefsForDisplay(id);
  assert.deepEqual(shown.applicable, []);
  assert.deepEqual(shown.others, []);
  assert.ok(shown.unassignedWorkLog);
  assert.equal(shown.unassignedWorkLog.turns.length, 1);
  assert.equal(shown.unassignedWorkLog.chips.turns, 1);
  assert.deepEqual(shown.unassignedWorkLog.chips.read, ['solo.txt']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('turns render chronologically with partial, issues, and omission data', () => {
  const { id, root } = workspace(crypto.randomUUID());
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  userTurn(id, 'Do things.');
  const first = assistantTurn(id, 'Tried.', [
    toolStep({ toolName: 'execute_command', args: { command: 'npm test' }, status: 'error', error: 'fail', result: { exitCode: 1 } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: first.id, partial: false });
  const second = assistantTurn(id, 'Partial progress.', [
    toolStep({ toolName: 'str_replace_editor', args: { relative_path: 'a.txt', old_str: 'a', new_str: 'b' }, status: 'running' }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: second.id, partial: true });
  const shown = inspection.getBriefsForDisplay(id);
  const work = shown.applicable[0].workLog;
  assert.deepEqual(work.turns.map((turn) => turn.turnSeq), [1, 2]);
  assert.equal(work.turns[0].partial, false);
  assert.equal(work.turns[1].partial, true);
  assert.equal(work.turns[0].openIssues.length, 1);
  assert.equal(work.turns[0].openIssues[0].kind, 'check-failure');
  // The fix turn is partial and records nothing resolved yet; the issue stays open.
  assert.equal(work.turns[1].resolvedIssues.length, 0);
  // Third turn resolves it: resolved presentation comes from the ledger.
  const third = assistantTurn(id, 'Fixed.', [
    toolStep({ toolName: 'execute_command', args: { command: 'npm test' }, result: { stdout: '', stderr: '', exitCode: 0 } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: third.id, partial: false });
  const refreshed = inspection.getBriefsForDisplay(id);
  const turns = refreshed.applicable[0].workLog.turns;
  assert.equal(turns[2].resolvedIssues.length, 1);
  assert.equal(turns[2].resolvedIssues[0].kind, 'check-failure');
  assert.equal(turns[2].openIssues.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('omission accounting survives serialization', () => {
  const { id, root } = workspace(crypto.randomUUID());
  userTurn(id, 'Bulk work.');
  const steps = Array.from({ length: 45 }, (_, i) => ({
    id: `bulk-${i}`,
    type: 'tool_call',
    toolName: 'read_project_file',
    status: 'complete',
    args: { relative_path: `src/deeply/nested/module/file-number-${i}.javascript` },
    result: { content: 'x'.repeat(300) },
  }));
  const assistant = assistantTurn(id, 'Bulk done.', steps);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  const shown = inspection.getBriefsForDisplay(id);
  const turn = shown.applicable[0].workLog.turns[0];
  assert.ok(turn.omitted.entries > 0, 'expected omission accounting');
  fs.rmSync(root, { recursive: true, force: true });
});

test('stale markers appear only on verifiable change', () => {
  const { id, root } = workspace(crypto.randomUUID());
  const staleFile = path.join(root, 'stale.txt');
  const keptFile = path.join(root, 'kept.txt');
  fs.writeFileSync(staleFile, 'v1\n');
  fs.writeFileSync(keptFile, 'same\n');
  // Old mtimes first so the recorded turn predates any later touch.
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(staleFile, past, past);
  fs.utimesSync(keptFile, past, past);
  userTurn(id, 'Read both files.');
  const assistant = assistantTurn(id, 'Read them.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'stale.txt' }, result: { content: 'v1\n' } }),
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'kept.txt' }, result: { content: 'same\n' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  // Touch one file after recording (explicit future mtime: deterministic).
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(staleFile, future, future);
  fs.writeFileSync(staleFile, 'v2\n');
  fs.utimesSync(staleFile, future, future);

  const shown = inspection.getBriefsForDisplay(id);
  const stale = shown.applicable[0].workLog.turns[0].stalePaths;
  assert.ok(stale.includes('stale.txt'), `expected stale marker, got ${JSON.stringify(stale)}`);
  assert.ok(!stale.includes('kept.txt'), `unexpected stale marker: ${JSON.stringify(stale)}`);

  // Missing files omit the marker rather than guessing.
  fs.rmSync(staleFile);
  const missing = inspection.getBriefsForDisplay(id);
  assert.deepEqual(missing.applicable[0].workLog.turns[0].stalePaths, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('brief payload keeps every existing field intact', () => {
  const { id, root } = workspace(crypto.randomUUID());
  userTurn(id, 'Keep me.');
  const shown = inspection.getBriefsForDisplay(id);
  const brief = shown.applicable[0];
  assert.equal(brief.kind, 'original');
  assert.equal(brief.content_text, 'Keep me.');
  assert.ok(typeof brief.message_id === 'number');
  assert.ok(Array.isArray(brief.attachments));
  assert.equal(brief.workLog, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('context usage carries the approximate work-log contribution', () => {
  const { id, root } = workspace(crypto.randomUUID());
  userTurn(id, 'Count me.');
  const usageBefore = require('../src/main/sessionManager').getContextUsage(id, MODEL);
  assert.equal(usageBefore.workLogTokens, 0);
  const assistant = assistantTurn(id, 'Counted.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a'.repeat(400) } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  const usage = require('../src/main/sessionManager').getContextUsage(id, MODEL);
  assert.ok(usage.workLogTokens > 0, 'expected a work-log contribution');
  assert.ok(usage.totalTokens >= usage.workLogTokens);
  // Same inclusion and budgeting semantics as the prompt builder: the figure
  // equals the estimate of the exact section text that would be injected.
  const section = workLog.buildWorkLogSection(id, {});
  assert.ok(section);
  assert.equal(usage.workLogTokens, Math.ceil(section.content.length / 4));
  fs.rmSync(root, { recursive: true, force: true });
});

test('casual chats expose no work-log surface', () => {
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL, null);
  sessions.saveMessage(id, 'user', 'Hello casual.');
  const shown = inspection.getBriefsForDisplay(id);
  assert.deepEqual(shown.applicable, []);
  assert.deepEqual(shown.others, []);
  assert.ok(!('unassignedWorkLog' in shown));
  const usage = require('../src/main/sessionManager').getContextUsage(id, MODEL);
  assert.equal(usage.workLogTokens, 0);
});
