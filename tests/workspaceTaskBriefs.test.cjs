const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-briefs-'));
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
const { prepareChatMessages, rebuildChatMessages } = require('../src/main/promptBuilder');
const compression = require('../src/main/compressionEngine');
const { approximateTokens } = require('../src/main/contextBudget');

const project = projects.createProject({ name: 'Brief Project' });
const MODEL = 'model';

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

function briefSections(prompt) {
  return prompt.filter(message => message.taskBrief === true
    || (message.role === 'system' && typeof message.content === 'string'
      && message.content.includes(briefs.SECTION_MARKER)));
}

test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('verbatim capture of the original request and subsequent instructions', () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Build a flaky widget with  exact  spacing.');
  sessions.saveMessage(id, 'assistant', 'Working on it.');
  sessions.saveMessage(id, 'user', 'Also: it must handle endocrine DISRUPTORS.');
  const rows = briefs.getAllBriefs(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'original');
  assert.equal(rows[0].content_text, 'Build a flaky widget with  exact  spacing.');
  assert.equal(rows[1].kind, 'instruction');
  assert.equal(rows[1].content_text, 'Also: it must handle endocrine DISRUPTORS.');
  assert.deepEqual(briefs.getApplicableBriefs(id).map(row => row.id), rows.map(row => row.id));
});

test('edits keep immutable revision history and the revision applies', () => {
  const id = workspaceSession(crypto.randomUUID());
  const first = sessions.saveMessage(id, 'user', 'Original requirement text.');
  sessions.saveMessage(id, 'assistant', 'Ack.');
  const before = briefs.getAllBriefs(id);
  assert.equal(before.length, 1);
  sessions.editMessage(first.id, 'Corrected requirement text.');
  const rows = briefs.getAllBriefs(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content_text, 'Original requirement text.');
  assert.equal(rows[0].kind, 'original');
  assert.equal(rows[1].kind, 'revision');
  assert.equal(rows[1].content_text, 'Corrected requirement text.');
  assert.equal(rows[1].supersedes_id, rows[0].id);
  const applicable = briefs.getApplicableBriefs(id);
  assert.deepEqual(applicable.map(row => row.id), [rows[1].id]);
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const sections = briefSections(prompt);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].content.includes('Corrected requirement text.'));
  assert.ok(!sections[0].content.includes('Original requirement text.'));
});

test('deleted anchor messages retain brief rows but exclude them from prompts', () => {
  const id = workspaceSession(crypto.randomUUID());
  const first = sessions.saveMessage(id, 'user', 'Deletable requirement.');
  sessions.saveMessage(id, 'assistant', 'Ack.');
  assert.equal(briefs.getApplicableBriefs(id).length, 1);
  sessions.deleteMessage(id, first.id);
  // Rows survive the deletion (anchor nulled by foreign key); nothing applies.
  const rows = briefs.getAllBriefs(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_text, 'Deletable requirement.');
  assert.equal(rows[0].message_id, null);
  assert.deepEqual(briefs.getApplicableBriefs(id), []);
  assert.equal(briefs.buildTaskBriefSection(id), null);
});

test('branch applicability: branching before a later instruction excludes it', () => {
  const id = workspaceSession(crypto.randomUUID());
  const user1 = sessions.saveMessage(id, 'user', 'First task requirement.');
  const assistant1 = sessions.saveMessage(id, 'assistant', 'First reply.');
  sessions.saveMessage(id, 'user', 'Second task requirement, much later.');
  sessions.saveMessage(id, 'assistant', 'Second reply.');
  const { sessionId: branched } = sessions.branchChat(id, assistant1.id);
  const branchedBriefs = briefs.getAllBriefs(branched);
  assert.equal(branchedBriefs.length, 1);
  assert.equal(branchedBriefs[0].kind, 'original');
  assert.equal(branchedBriefs[0].content_text, 'First task requirement.');
  // Source session still applies both instructions.
  assert.equal(briefs.getApplicableBriefs(id).length, 2);
  // Branch prompt carries only the ancestor brief.
  const prompt = rebuildChatMessages({ sessionId: branched, modelId: MODEL });
  const sections = briefSections(prompt);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].content.includes('First task requirement.'));
  assert.ok(!sections[0].content.includes('Second task requirement'));
  // Remapped anchors point at the branch's own message copies.
  const branchMessages = sessions.getActiveMessages(branched).map(row => row.id);
  assert.ok(branchMessages.includes(branchedBriefs[0].message_id));
  assert.ok(!branchedBriefs.some(row => row.content_text.includes('Second task requirement')));
  assert.ok(user1.id > 0 && assistant1.id > 0);
});

test('attachment references are preserved and missing files degrade safely', () => {
  const id = workspaceSession(crypto.randomUUID());
  const config = require('../src/main/configStore').getConfig();
  const attachmentsDir = path.join(config.appDataDirectory, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const managedName = `${Date.now()}-${crypto.randomUUID()}-notes.md`;
  const managedPath = path.join(attachmentsDir, managedName);
  fs.writeFileSync(managedPath, '# Spec\nHandle `ticks` carefully.\n');
  const saved = sessions.saveMessage(id, 'user', 'Follow the attached spec.', [{ file_path: managedPath, mime_type: 'text/markdown' }]);
  const rows = briefs.getAllBriefs(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attachments.length, 1);
  assert.equal(rows[0].attachments[0].file_name, 'notes.md');
  assert.ok(rows[0].attachments[0].size > 0);
  const section = briefs.buildTaskBriefSection(id);
  assert.ok(section.content.includes('Follow the attached spec.'));
  assert.ok(section.content.includes('Handle `ticks` carefully.'));
  // Simulate a dangling reference: DB attachment row gone and file removed.
  db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(saved.id);
  fs.rmSync(managedPath, { force: true });
  const degraded = briefs.buildTaskBriefSection(id);
  assert.ok(degraded.content.includes('Follow the attached spec.'));
  assert.match(degraded.content, /Attachment unavailable.*notes\.md/);
  assert.ok(!degraded.content.includes('Handle `ticks` carefully.'));
});

test('normal preparation and forced-recovery reconstruction share applicable briefs and order', () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Alpha requirement.');
  sessions.saveMessage(id, 'assistant', 'Alpha reply.');
  sessions.saveMessage(id, 'user', 'Beta requirement.');
  const prepared = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'Gamma requirement.', regenerate: false });
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const preparedSections = briefSections(prepared);
  const rebuiltSections = briefSections(rebuilt);
  assert.equal(preparedSections.length, 1);
  assert.equal(rebuiltSections.length, 1);
  assert.deepEqual(preparedSections[0].briefIds, rebuiltSections[0].briefIds);
  assert.equal(preparedSections[0].content, rebuiltSections[0].content);
  for (const text of ['Alpha requirement.', 'Beta requirement.', 'Gamma requirement.']) {
    assert.ok(preparedSections[0].content.includes(text));
  }
  assert.ok(
    preparedSections[0].content.indexOf('Alpha requirement.') <
    preparedSections[0].content.indexOf('Beta requirement.') &&
    preparedSections[0].content.indexOf('Beta requirement.') <
    preparedSections[0].content.indexOf('Gamma requirement.'),
  );
  // Regeneration follows the same rules and injects exactly once.
  const regenerated = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: '', regenerate: true, regenerateLast: false });
  assert.equal(briefSections(regenerated).length, 1);
  assert.deepEqual(briefSections(regenerated)[0].briefIds, preparedSections[0].briefIds);
  const markers = rebuilt.filter(message => typeof message.content === 'string' && message.content.includes(briefs.SECTION_MARKER));
  assert.equal(markers.length, 1);
});

test('brief-identity change during compression aborts safely without archival', async () => {
  const id = workspaceSession(crypto.randomUUID());
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Turn${i} `.padEnd(400, 'x'));
  const before = sessions.loadSession(id).messages.map(row => ({ id: row.id, archived: row.archived }));
  await assert.rejects(compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: 2600,
    llmSummarizeCallback: async () => {
      sessions.saveMessage(id, 'user', 'Concurrent correction lands mid-summary.');
      return 'A summary that must be discarded.';
    },
    llmCheckpointCallback: async () => ({ objective: 'Stub objective.', outstandingRequirements: [] }),
  }), /Task brief changed during compression/);
  assert.equal(sessions.getSessionSummary(id), null);
  const after = sessions.loadSession(id).messages;
  // The concurrent instruction itself is preserved; nothing was archived.
  assert.ok(after.every(row => row.archived === 0 && row.is_summarized === 0));
  assert.deepEqual(after.filter(row => before.some(orig => orig.id === row.id)).map(row => ({ id: row.id, archived: row.archived })), before);
  assert.ok(after.some(row => row.content === 'Concurrent correction lands mid-summary.'));
  assert.ok(briefs.getApplicableBriefs(id).some(row => row.content_text === 'Concurrent correction lands mid-summary.'));
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});

test('oversized brief fails closed without truncation or archival', async () => {
  const id = workspaceSession(crypto.randomUUID());
  const huge = `Oversized requirement ${'y'.repeat(4000)}`;
  sessions.saveMessage(id, 'user', huge);
  for (let i = 0; i < 12; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Filler${i} `.padEnd(200, 'z'));
  const applicable = briefs.getApplicableBriefs(id);
  assert.ok(briefs.estimateBriefTokens(applicable) > 200);
  assert.throws(() => briefs.buildTaskBriefSection(id, { contextWindowLimit: 200 }), (error) => error.code === 'CONTEXT_BUDGET_EXCEEDED');
  const before = sessions.loadSession(id).messages.map(row => row.archived);
  const result = await compression.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: 200,
    llmSummarizeCallback: async () => 'Too-small summary.',
  });
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'task-brief-too-large');
  assert.deepEqual(sessions.loadSession(id).messages.map(row => row.archived), before);
  // Durable record survives even though it cannot fit the current window.
  assert.equal(briefs.getAllBriefs(id)[0].content_text, huge);
  assert.throws(() => rebuildChatMessages({ sessionId: id, modelId: MODEL, contextWindowLimit: 200 }),
    (error) => error.code === 'CONTEXT_BUDGET_EXCEEDED');
});

test('casual chat creates no brief records and receives no injection', () => {
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL);
  sessions.saveMessage(id, 'user', 'Casual question about the weather.');
  sessions.saveMessage(id, 'assistant', 'Sunny.');
  assert.deepEqual(briefs.getAllBriefs(id), []);
  assert.deepEqual(briefs.getApplicableBriefs(id), []);
  assert.equal(briefs.buildTaskBriefSection(id), null);
  const prepared = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'Another casual question.', regenerate: false });
  const rebuilt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.equal(briefSections(prepared).length, 0);
  assert.equal(briefSections(rebuilt).length, 0);
  assert.ok(!JSON.stringify(prepared).includes(briefs.SECTION_MARKER));
});

test('diagnostic: tokenizer-measured prompt exceeds the legacy context estimate', () => {
  const id = workspaceSession(crypto.randomUUID());
  const config = require('../src/main/configStore').getConfig();
  const attachmentsDir = path.join(config.appDataDirectory, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const managedPath = path.join(attachmentsDir, `${Date.now()}-${crypto.randomUUID()}-context.md`);
  fs.writeFileSync(managedPath, 'ATTACHED_CONTEXT_RULES\n' + 'x'.repeat(4000));
  sessions.saveMessage(id, 'user', 'Measured task with attachment.', [{ file_path: managedPath, mime_type: 'text/markdown' }]);
  sessions.saveMessage(id, 'assistant', 'Measured reply.');
  const usage = sessions.getContextUsage(id, MODEL);
  const prompt = rebuildChatMessages({ sessionId: id, modelId: MODEL });
  assert.ok(briefSections(prompt).length === 1);
  const { getToolContext } = require('../src/main/promptBuilder');
  const { tools } = getToolContext([], true, id, 'workspace_write');
  const payload = { messages: prompt, tools };
  const measured = approximateTokens(payload);
  // Output reserve mirrors contextBudget.reserveTokens for an uncapped
  // request (min(1024, limit/4) + min(128, limit/100)); computed inline
  // because only the fallback measurer is part of the diagnostic surface.
  const limit = 32768;
  const budget = limit - (Math.min(1024, Math.floor(limit / 4)) + Math.min(128, Math.ceil(limit / 100)));
  // The legacy estimate omits system prompts, tool schemas, project context,
  // attachment expansion, and the injected brief, so the serialized prompt is
  // strictly larger. This is diagnostic only: approximateTokens is a
  // byte-based fallback, not a claim of exact tokenizer parity.
  assert.ok(measured > usage.totalTokens,
    `measured=${measured} estimate=${usage.totalTokens} briefTokens=${briefs.estimateBriefTokens(briefs.getApplicableBriefs(id))}`);
  assert.ok(budget > 0 && budget < 32768);
  assert.ok(briefs.estimateBriefTokens(briefs.getApplicableBriefs(id)) > 0);
});
