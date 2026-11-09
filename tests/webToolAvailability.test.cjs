'use strict';
// Native web tools stay advertised in Casual and compact Workspace from the
// first request, across activation lifecycle and real compaction, while
// non-activated groups stay hidden. Permission policy is untouched here:
// advertisement only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webtools-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const builder = require('../src/main/promptBuilder');
const activation = require('../src/main/nativeToolActivation');
const oldProfile = process.env.CONTINUUM_NATIVE_TOOL_PROFILE;
const oldNodeEnv = process.env.NODE_ENV;
const WEB = ['extract_web_page_data', 'get_single_web_page_content', 'web_search'];

function fixture(mode = 'workspace_write', { begin = true } = {}) {
  const id = require('node:crypto').randomUUID(), root = path.join(directory, id); fs.mkdirSync(root);
  const project = mode && projects.createProject({ name: 'WebTools', root_path: root, permissionMode: mode });
  sessions.getOrCreateSession(id, 'fixture', project?.id);
  if (begin) activation.begin(id, 'owner');
  return { id, root, mode: mode || 'read_only' };
}
const names = f => builder.getToolContext([], true, f.id, f.mode, 'fixture').tools.map(t => t.function.name);
const available = f => builder.getToolContext([], true, f.id, f.mode, 'fixture', { fullCatalog: true }).tools;
const prompt = f => builder.buildSessionSystemPrompt({ sessionId: f.id, modelId: 'fixture', userText: 'Inspect the app and report.' }).content;

test.before(() => { process.env.CONTINUUM_NATIVE_TOOL_PROFILE = 'compact'; });
test.after(() => {
  if (oldProfile === undefined) delete process.env.CONTINUUM_NATIVE_TOOL_PROFILE; else process.env.CONTINUUM_NATIVE_TOOL_PROFILE = oldProfile;
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
  database.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true });
});

test('web tools are advertised from the first request in Casual and compact Workspace', () => {
  // No activation run yet: the first request already carries the web schemas.
  const first = fixture(null, { begin: false });
  for (const name of WEB) assert.ok(names(first).includes(name), `first request ${name}`);
  const casual = fixture(null);
  for (const name of WEB) assert.ok(names(casual).includes(name), `casual ${name}`);
  // Non-activated groups stay hidden behind manage_native_tools.
  for (const hidden of ['edit_project_files', 'lsp_hover', 'git_commit']) assert.ok(!names(casual).includes(hidden), hidden);
  const workspace = fixture('workspace_write');
  for (const name of WEB) assert.ok(names(workspace).includes(name), `workspace ${name}`);
  assert.ok(!names(workspace).includes('edit_project_files'));
  // Exactly the three web tools, no more, no fewer.
  assert.deepEqual(names(workspace).filter(name => WEB.includes(name)).sort(), [...WEB].sort());
});

test('web tools survive the activation lifecycle and real compaction', async () => {
  const f = fixture('workspace_write');
  activation.end(f.id, 'owner');
  activation.begin(f.id, 'owner');
  for (const name of WEB) assert.ok(names(f).includes(name), `after begin ${name}`);
  builder.prepareChatMessages({ sessionId: f.id, modelId: 'fixture', userText: 'Inspect and report.' });
  sessions.saveMessage(f.id, 'assistant', 'Evidence. '.repeat(3000));
  for (let i = 0; i < 6; i++) sessions.saveMessage(f.id, i % 2 ? 'assistant' : 'user', 'Recent observation ' + i);
  const result = await require('./fixtures/w3Compaction.cjs').compact({ sessionId: f.id, modelId: 'fixture' });
  assert.equal(result.compressed, true, JSON.stringify(result));
  builder.rebuildChatMessages({ sessionId: f.id, modelId: 'fixture' });
  for (const name of WEB) assert.ok(names(f).includes(name), `after compaction ${name}`);
  assert.ok(!names(f).includes('edit_project_files'));
});

test('manage catalog marks the web group always active', () => {
  const f = fixture('workspace_write');
  const catalog = activation.manage({ action: 'list' }, f.id, available(f), 'owner');
  const web = catalog.groups.find(group => group.group === 'web');
  assert.ok(web, 'web group listed');
  assert.equal(web.active, true);
  assert.deepEqual([...web.tools].sort(), [...WEB].sort());
  const editing = catalog.groups.find(group => group.group === 'editing');
  assert.equal(editing.active, false, 'unactivated groups stay inactive');
});

test('guidance routes web research and names the authenticated preview only in development', () => {
  const f = fixture('workspace_write');
  const text = prompt(f);
  assert.match(text, /use advertised web tools/);
  assert.match(text, /advertised browser tools for live browser inspection/);
  // Development serves the Vite preview: the code-owned origin is named.
  process.env.NODE_ENV = 'development';
  assert.match(prompt(f), /http:\/\/localhost:5173\//);
  assert.match(prompt(f), /authenticated Continuum preview at http:\/\/localhost:5173\//);
  // Any other build never leaks a browsable localhost URL into the prompt.
  delete process.env.NODE_ENV;
  assert.doesNotMatch(prompt(f), /http:\/\/localhost:5173\//);
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
});
