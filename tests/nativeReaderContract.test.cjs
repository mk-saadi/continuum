'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-contract-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase();
const { agentTools, executeAgentTool } = require('../src/main/tools/agentTools');
const { validate } = require('../src/main/toolSchemaValidation');
const schema = agentTools.find(t => t.function.name === 'read_project_file').function.parameters;
const sessions = require('../src/main/sessionManager');
const root = path.join(directory, 'workspace'); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'sample.txt'), 'one\ntwo\nthree\n');
const project = require('../src/main/projectManager').createProject({ name: 'Reader contract', root_path: root });
sessions.getOrCreateSession('owner', 'fixture', project.id);
sessions.getOrCreateSession('other', 'fixture', project.id);
const dispatch = async (args, sessionId = 'owner') => {
  validate(schema, args);
  return executeAgentTool({ name: 'read_project_file', arguments: args, sessionId, permissionMode: 'read_only' });
};
test.after(() => { database.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
test('strict schema rejects missing/both/malformed sources and accepts corrected workspace page/hash', async () => {
  for (const args of [{}, { start_line: 2 }, { relative_path: 'sample.txt', attachment_id: 'x' },
    { relative_path: 1 }, { relative_path: 'sample.txt', start_line: 0 }, { relative_path: 'sample.txt', expected_content_hash: 'bad' },
    { relative_path: 'sample.txt', unknown: true }]) assert.throws(() => validate(schema, args));
  const page = await dispatch({ relative_path: 'sample.txt', start_line: 2, end_line: 2 });
  assert.equal(page.success, true); assert.equal(page.content, 'two\n');
  const revision = await dispatch({ relative_path: 'sample.txt', expected_content_hash: page.content_hash, start_line: 3, end_line: 3 });
  assert.equal(revision.success, true); assert.equal(revision.content, 'three\n');
  assert.equal((await dispatch({ relative_path: '../outside.txt' })).success, false);
});
test('valid owned attachment page, forbidden hashes, isolation, and corrected retry', async () => {
  const source = path.join(directory, 'upload.txt'); fs.writeFileSync(source, 'first\nsecond\n');
  const attachments = await require('../src/main/fileUploads').processUploads([source]);
  sessions.saveMessage('owner', 'user', 'Fixture attachment', attachments);
  // Resolve the authoritative persisted message row rather than guessing its ID.
  const row = database.db.prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get('owner');
  const ref = require('../src/main/attachmentReader').describe(attachments[0], row.id).attachment_id;
  assert.ok(ref);
  const values = { attachment_id: ref, start_line: 2, end_line: 2 };
  const page = await dispatch(values); assert.equal(page.success, true); assert.equal(page.content, 'second');
  assert.equal((await dispatch(values, 'other')).success, false);
  assert.equal((await dispatch({ ...values, expected_content_hash: 'a'.repeat(64) })).success, false);
  assert.equal((await dispatch(values)).success, true);
});
