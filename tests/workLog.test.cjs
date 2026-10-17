'use strict';
// Phase 2: workspace turn-digest persistence, lifecycle, bounded assembly,
// and prompt injection. No UI.
// Run with: node --test tests/workLog.test.cjs
// Temp dirs under os.tmpdir() only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-'));
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
const turnDigest = require('../src/main/turnDigest');
const { prepareChatMessages, rebuildChatMessages } = require('../src/main/promptBuilder');

const MODEL = 'model';
const project = projects.createProject({ name: 'Work Log Project' });

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

function casualSession(id) {
  sessions.getOrCreateSession(id, MODEL, null);
  return id;
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

function setSteps(messageId, steps) {
  // Mirrors engineManager persistence.update: the engine rewrites the row's
  // execution_steps JSON in place as a turn progresses and settles.
  db.prepare('UPDATE messages SET execution_steps = ? WHERE id = ?').run(JSON.stringify(steps), messageId);
}

function digestRows(sessionId) {
  return db.prepare('SELECT * FROM workspace_turn_digests WHERE session_id = ? ORDER BY id ASC').all(sessionId);
}

test.after(() => {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('records a completed turn digest with session, message, and brief associations', () => {
  const id = workspaceSession(crypto.randomUUID());
  const user = userTurn(id, 'Fix the login redirect.');
  const assistant = assistantTurn(id, 'Done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'src/auth.js' }, result: { content: 'x'.repeat(40) } }),
    toolStep({ toolName: 'str_replace_editor', args: { relative_path: 'src/auth.js', old_str: 'a\n', new_str: 'b\n' }, result: { success: true } }),
    toolStep({ toolName: 'execute_command', args: { command: 'npm test' }, result: { stdout: 'ok', stderr: '', exitCode: 0 } }),
  ]);
  const recorded = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  assert.ok(recorded && typeof recorded.id === 'number');
  const rows = digestRows(id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.session_id, id);
  assert.equal(row.assistant_message_id, assistant.id);
  assert.equal(row.user_message_id, user.id);
  const briefRows = briefs.getAllBriefs(id);
  assert.equal(briefRows.length, 1);
  assert.equal(row.brief_id, briefRows[0].id);
  assert.equal(row.partial, 0);
  const digest = JSON.parse(row.digest_json);
  assert.equal(digest.version, 1);
  assert.ok(digest.text.length <= turnDigest.DIGEST_CHAR_CAP);
  assert.match(digest.text, /edited src\/auth\.js/);
  assert.match(digest.text, /tests passed/);
  // Structured source of truth survives alongside the text.
  assert.ok(Array.isArray(digest.entries) && digest.entries.length === 3);
  assert.deepEqual(workLog.getDigestsForBrief(id, user.id).map((entry) => entry.id), [row.id]);
});

test('partial turns keep verified operations and mark partial', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Migrate the store.');
  const assistant = assistantTurn(id, 'Working…', [
    toolStep({ toolName: 'write_project_file', args: { relative_path: 'a.txt' }, status: 'complete', result: { success: true } }),
    toolStep({ toolName: 'apply_patch', status: 'running', args: { patch: '--- a\n+++ b\n@@\n-x\n+y\n' } }),
  ]);
  const recorded = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: true });
  assert.ok(recorded);
  const row = digestRows(id)[0];
  assert.equal(row.partial, 1);
  const digest = JSON.parse(row.digest_json);
  assert.equal(digest.partial, true);
  assert.match(digest.text, /partial/);
  assert.match(digest.text, /wrote a\.txt/);
  assert.match(digest.text, /Unfinished:/);
  assert.equal(digest.openIssues.length, 0);
});

test('regeneration is idempotent: rebuild replaces, never duplicates', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Polish the copy.');
  const assistant = assistantTurn(id, 'Done v1.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'hi' } }),
  ]);
  const first = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  const second = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  assert.equal(first.id, second.id);
  assert.equal(digestRows(id).length, 1);
  assert.equal(second.updated, true);
});

test('a stored complete digest is never overwritten by a stale partial', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Refactor widgets.');
  const assistant = assistantTurn(id, 'Done.', [
    toolStep({ toolName: 'git_commit', args: { message: 'refactor' }, result: { output: 'ok', hash: 'a'.repeat(40) } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  const before = digestRows(id)[0].digest_json;
  // A racing partial terminal path for the same turn must lose.
  setSteps(assistant.id, [
    { id: 's', type: 'tool_call', toolName: 'git_commit', status: 'running', args: { message: 'refactor' } },
  ]);
  const raced = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: true });
  assert.equal(raced.updated, false);
  assert.equal(digestRows(id)[0].digest_json, before);
  assert.equal(digestRows(id)[0].partial, 0);
  // A fresh complete rebuild replaces.
  setSteps(assistant.id, [
    { id: 's', type: 'tool_call', toolName: 'git_commit', status: 'complete', args: { message: 'refactor v2' }, result: { output: 'ok', hash: 'b'.repeat(40) } },
  ]);
  const replaced = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  assert.equal(replaced.updated, true);
  assert.match(digestRows(id)[0].digest_json, /refactor v2/);
});

test('turns without briefs retain digests with a null brief association', () => {
  const id = workspaceSession(crypto.randomUUID());
  // Assistant row with no preceding user message: no brief anchor exists.
  const assistant = assistantTurn(id, 'Background note.', [
    toolStep({ toolName: 'git_status', args: {}, result: { output: ' M a.txt' } }),
  ]);
  const recorded = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  assert.ok(recorded);
  assert.equal(digestRows(id)[0].brief_id, null);
  assert.equal(digestRows(id)[0].user_message_id, null);
});

test('casual sessions record nothing and inject nothing', () => {
  const id = casualSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Hello casual.');
  const assistant = assistantTurn(id, 'Hi.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'hi' } }),
  ]);
  assert.equal(workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false }), null);
  assert.equal(digestRows(id).length, 0);
  assert.equal(workLog.buildWorkLogSection(id), null);
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.ok(!prompt.some((message) => message.workLog === true));
  assert.ok(!prompt.some((message) => typeof message.content === 'string' && message.content.includes('[WORKSPACE WORK LOG]')));
});

test('bad input throws, missing rows skip, and the safe wrapper never throws', () => {
  const id = workspaceSession(crypto.randomUUID());
  assert.throws(() => workLog.recordTurnDigest({ sessionId: id }), /assistantMessageId/);
  assert.throws(() => workLog.recordTurnDigest({ sessionId: id, assistantMessageId: 'x' }), /assistantMessageId/);
  assert.throws(() => workLog.recordTurnDigest({ sessionId: '', assistantMessageId: 1 }), /sessionId/);
  assert.equal(workLog.recordTurnDigest({ sessionId: id, assistantMessageId: 424242 }), null);
  const failed = workLog.recordTurnDigestSafe({ sessionId: id, assistantMessageId: 'x' });
  assert.equal(failed.ok, false);
  assert.ok(typeof failed.error === 'string');
  const skipped = workLog.recordTurnDigestSafe({ sessionId: id, assistantMessageId: 424242 });
  assert.deepEqual(skipped, { ok: true, skipped: true, digestId: null });
});

test('digest anchors to the triggering user turn across multiple turns', () => {
  const id = workspaceSession(crypto.randomUUID());
  const user1 = userTurn(id, 'First requirement.');
  const assistant1 = assistantTurn(id, 'First done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a' } }),
  ]);
  const user2 = userTurn(id, 'Second requirement.');
  const assistant2 = assistantTurn(id, 'Second done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'b.txt' }, result: { content: 'b' } }),
  ]);
  const first = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant1.id, partial: false });
  const second = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant2.id, partial: false });
  const rows = digestRows(id);
  assert.equal(rows[0].user_message_id, user1.id);
  assert.equal(rows[1].user_message_id, user2.id);
  const briefRows = briefs.getAllBriefs(id);
  assert.equal(rows[0].brief_id, briefRows[0].id);
  assert.equal(rows[1].brief_id, briefRows[1].id);
  assert.equal(first.turnSeq + 1, second.turnSeq);
  assert.deepEqual(workLog.getDigestsForBrief(id, user2.id).map((entry) => entry.assistant_message_id), [assistant2.id]);
});

test('rebuilding an old turn reuses its own ledger instead of duplicating issues', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Fix the build.');
  const first = assistantTurn(id, 'Tried.', [
    toolStep({ toolName: 'execute_command', args: { command: 'npm test' }, status: 'error', error: 'fail', result: { exitCode: 1 } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: first.id, partial: false });
  const second = assistantTurn(id, 'Fixed.', [
    toolStep({ toolName: 'execute_command', args: { command: 'npm test' }, result: { stdout: '', stderr: '', exitCode: 0 } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: second.id, partial: false });
  // Rebuild turn 1 with identical steps: no duplicate issue opens, and the
  // resolution recorded by turn 2 is untouched.
  const rebuilt = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: first.id, partial: false });
  assert.equal(rebuilt.updated, true);
  const rows = digestRows(id);
  assert.equal(rows.length, 2);
  const firstLedger = JSON.parse(rows[0].digest_json).ledger;
  assert.equal(firstLedger.issues.length, 1);
  assert.equal(firstLedger.issues[0].id, 'iss-1');
  assert.equal(firstLedger.issues[0].status, 'open');
  assert.equal(JSON.parse(rows[1].digest_json).ledger.issues[0].status, 'resolved');
  // Continuity holds: the next genuinely new failure takes iss-2, not iss-3.
  const third = assistantTurn(id, 'Broke again.', [
    toolStep({ toolName: 'write_project_file', args: { relative_path: 'n.txt' }, status: 'error', error: 'denied' }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: third.id, partial: false });
  const ledgers = digestRows(id).map((row) => JSON.parse(row.digest_json).ledger);
  const ids = ledgers.flatMap((ledger) => ledger.issues.map((issue) => issue.id));
  assert.ok(ids.includes('iss-2'));
  assert.ok(!ids.includes('iss-3'));
});

test('rekey moves a regenerate digest onto its surviving target', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Do the thing.');
  const target = assistantTurn(id, 'Old answer.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'old.txt' }, result: { content: 'old' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: target.id, partial: false });
  const temp = assistantTurn(id, 'New answer.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'new.txt' }, result: { content: 'new' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: temp.id, partial: false });
  const moved = workLog.rekeyTurnDigest({ sessionId: id, fromMessageId: temp.id, toMessageId: target.id });
  assert.equal(moved.kept, 'incoming');
  const rows = digestRows(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assistant_message_id, target.id);
  assert.match(rows[0].digest_json, /new\.txt/);
  // Complete beats stale partial on rekey.
  const temp2 = assistantTurn(id, 'Aborted retry.', [
    toolStep({ toolName: 'read_project_file', status: 'running', args: { relative_path: 'x.txt' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: temp2.id, partial: true });
  const kept = workLog.rekeyTurnDigest({ sessionId: id, fromMessageId: temp2.id, toMessageId: target.id });
  assert.equal(kept.kept, 'target');
  assert.equal(digestRows(id).length, 1);
  assert.match(digestRows(id)[0].digest_json, /new\.txt/);
  assert.throws(() => workLog.rekeyTurnDigest({ sessionId: id, fromMessageId: 0, toMessageId: 1 }), /positive integer/);
  void kept;
});

test('deleteMessage removes digests for deleted turns', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Keep this.');
  const assistant = assistantTurn(id, 'Done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  assert.equal(digestRows(id).length, 1);
  sessions.deleteMessage(id, assistant.id);
  assert.equal(digestRows(id).length, 0);
});

test('child results resolve through the transcript store, honestly on miss', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Research auth patterns.');
  db.prepare(
    `INSERT INTO subagent_runs (child_session_id, status, output_text, task_text, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run('child-1', 'complete', 'Auth lives in lib/auth.js; prefer sessions.', 'survey auth', );
  const assistant = assistantTurn(id, 'Surveyed.', [
    { id: 's1', type: 'tool_call', toolName: 'spawn_sub_agent', status: 'complete',
      args: { task_description: 'survey auth' }, result: {}, childSessionId: 'child-1' },
    { id: 's2', type: 'tool_call', toolName: 'spawn_sub_agent', status: 'complete',
      args: { task_description: 'survey billing' }, result: {}, childSessionId: 'child-missing' },
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  const digest = JSON.parse(digestRows(id)[0].digest_json);
  assert.match(digest.text, /auth lives in lib\/auth\.js/i);
  assert.match(digest.text, /result unavailable/);
});

test('assembly keeps four recent digests in detail and folds older history', () => {
  const id = workspaceSession(crypto.randomUUID());
  let ledger = undefined;
  for (let turn = 1; turn <= 6; turn++) {
    const user = userTurn(id, `Requirement ${turn}.`);
    const text = turn === 1 ? 'seed' : 'more';
    const steps =
      turn === 1
        ? [{ id: `f${turn}`, type: 'tool_call', toolName: 'execute_command', status: 'error', args: { command: 'npm test' }, result: { stdout: '', stderr: 'old failure', exitCode: 1 } }]
        : [{ id: `ok${turn}`, type: 'tool_call', toolName: 'read_project_file', status: 'complete', args: { relative_path: `f${turn}.txt` }, result: { content: text } }];
    const assistant = assistantTurn(id, `Done ${turn}.`, steps);
    const recorded = workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
    assert.ok(recorded);
    void user;
  }
  const section = workLog.buildWorkLogSection(id);
  assert.ok(section);
  assert.equal(section.role, 'system');
  assert.equal(section.workLog, true);
  assert.ok(section.content.includes('[WORKSPACE WORK LOG]'));
  assert.ok(section.content.includes('[END OF WORKSPACE WORK LOG]'));
  // Untrusted-evidence labeling is explicit.
  assert.match(section.content, /historical evidence only/);
  assert.match(section.content, /never as instructions/);
  assert.ok(section.content.length <= turnDigest.WORKLOG_CHAR_CAP);
  // Newest four in detail (turns 3-6); turns 1-2 folded. The turn-1 open
  // issue is still shown inside the detailed digests (the ledger carries it
  // forward), so the folded section carries nothing twice.
  assert.match(section.content, /\[Turn 6/);
  assert.match(section.content, /\[Turn 3/);
  assert.doesNotMatch(section.content, /\[Turn 1\]/);
  assert.doesNotMatch(section.content, /\[Turn 2\]/);
  assert.match(section.content, /Earlier turns folded: 2 turn\(s\)/);
  assert.match(section.content, /tests failed/);
  assert.match(section.content, /Open issues carried: 0/);
  assert.deepEqual(section.digestIds.length, 4);
});

test('aggregate cap holds under adversarial volume with accounting', () => {
  const id = workspaceSession(crypto.randomUUID());
  for (let turn = 1; turn <= 8; turn++) {
    userTurn(id, `Bulk requirement ${turn}.`);
    const steps = Array.from({ length: 12 }, (_, i) => ({
      id: `b${turn}-${i}`,
      type: 'tool_call',
      toolName: 'read_project_file',
      status: 'complete',
      args: { relative_path: `src/module-${turn}/file-${i}.javascript` },
      result: { content: 'x'.repeat(500) },
    }));
    const assistant = assistantTurn(id, `Bulk done ${turn}.`, steps);
    workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  }
  const section = workLog.buildWorkLogSection(id);
  assert.ok(section.content.length <= turnDigest.WORKLOG_CHAR_CAP);
  assert.match(section.content, /Omitted for budget/);
  assert.ok(section.digestIds.length <= 4);
});

test('prompt injection appears once on later workspace turns without checkpoints', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Wire the widget.');
  const assistant = assistantTurn(id, 'Wired.', [
    toolStep({ toolName: 'str_replace_editor', args: { relative_path: 'w.js', old_str: 'a', new_str: 'b' }, result: { success: true } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  userTurn(id, 'Now polish it.');
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const blocks = prompt.filter((message) => message.workLog === true);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /edited w\.js/);
  // Resume stability: rebuilding the same state yields the identical block.
  const again = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.equal(
    again.filter((message) => message.workLog === true).map((message) => message.content).join('\n'),
    blocks[0].content,
  );
});

test('work-log placement: end-of-prompt preserves more reusable prefix', () => {
  const id = workspaceSession(crypto.randomUUID());
  const serializePrompt = (prompt) =>
    prompt
      .map((message) => `${message.role}:${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
      .join('\n');
  const commonPrefix = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const stripWorkLog = (prompt) => prompt.filter((message) => message.workLog !== true);
  const insertAfterBriefs = (prompt, block) => {
    const stripped = stripWorkLog(prompt);
    const at = stripped.findIndex((message) => message.taskBrief === true);
    stripped.splice(at < 0 ? 1 : at + 1, 0, block);
    return stripped;
  };
  const appendEnd = (prompt, block) => [...stripWorkLog(prompt), block];

  userTurn(id, 'Alpha requirement.');
  const assistant1 = assistantTurn(id, 'Alpha done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant1.id, partial: false });
  userTurn(id, 'Beta requirement.');
  const assistant2 = assistantTurn(id, 'Beta done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'b.txt' }, result: { content: 'b' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant2.id, partial: false });

  // Case A: a new turn adds a user message (and therefore a brief). Both
  // placements diverge where the brief section grows, so the digest position
  // cannot matter; assert the tie explicitly rather than assuming it.
  const before = serializePrompt(rebuildChatMessages({ sessionId: id, modelId: MODEL }));
  userTurn(id, 'Gamma requirement.');
  const afterTurn = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const reuseBriefs = commonPrefix(before, serializePrompt(insertAfterBriefs(afterTurn, workLog.buildWorkLogSection(id))));
  const reuseEnd = commonPrefix(before, serializePrompt(appendEnd(afterTurn, workLog.buildWorkLogSection(id))));
  assert.equal(reuseBriefs, reuseEnd);
  assert.ok(reuseBriefs > 0, 'some stable prefix (base system) must survive a new turn');

  // Case B: only digest content is new (record, then rebuild with no new
  // messages — the resume/regenerate-prep shape). End placement keeps the
  // entire previous prompt reusable; brief-section insertion does not.
  const id2 = workspaceSession(crypto.randomUUID());
  userTurn(id2, 'Solo requirement.');
  const solo = assistantTurn(id2, 'Solo done.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 's.txt' }, result: { content: 's' } }),
  ]);
  const baseOnly = serializePrompt(rebuildChatMessages({ sessionId: id2, modelId: MODEL }));
  workLog.recordTurnDigest({ sessionId: id2, assistantMessageId: solo.id, partial: false });
  const withDigest = rebuildChatMessages({ sessionId: id2, modelId: MODEL });
  const digestReuseBriefs = commonPrefix(baseOnly, serializePrompt(insertAfterBriefs(withDigest, workLog.buildWorkLogSection(id2))));
  const digestReuseEnd = commonPrefix(baseOnly, serializePrompt(appendEnd(withDigest, workLog.buildWorkLogSection(id2))));
  assert.equal(digestReuseEnd, baseOnly.length);
  assert.ok(digestReuseEnd > digestReuseBriefs, `end placement must preserve more prefix (${digestReuseEnd} vs ${digestReuseBriefs})`);
});

test('multiple briefs never duplicate the work log', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'First.');
  const assistant = assistantTurn(id, 'Done first.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  userTurn(id, 'Second.');
  userTurn(id, 'Third.');
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.equal(prompt.filter((message) => message.workLog === true).length, 1);
  const occurrences = prompt
    .filter((message) => message.workLog === true)
    .map((message) => message.content.match(/\[Turn 1[ ·\]]/g) || []).flat().length;
  assert.equal(occurrences, 1);
});

test('corrupt digest rows fail open for prompts, never break them', () => {
  const id = workspaceSession(crypto.randomUUID());
  userTurn(id, 'Break things.');
  const assistant = assistantTurn(id, 'Tried.', [
    toolStep({ toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'a' } }),
  ]);
  workLog.recordTurnDigest({ sessionId: id, assistantMessageId: assistant.id, partial: false });
  db.prepare('UPDATE workspace_turn_digests SET digest_json = ? WHERE session_id = ?').run('not-json{{{', id);
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.ok(Array.isArray(prompt));
  assert.equal(prompt.filter((message) => message.workLog === true).length, 0);
});
