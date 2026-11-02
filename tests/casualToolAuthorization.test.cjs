'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'casual-auth-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db'); db.initDatabase(directory);
const p = require('../src/main/toolPermissions');
const contexts = require('../src/main/lspExecutionContext');
const rules = require('../src/main/rememberedToolRules');
const decide = require('../src/main/toolApprovalPolicy').decideToolApproval;
for (const id of ['a', 'b']) require('../src/main/sessionManager').getOrCreateSession(id, 'model');
let prompts = 0;
const authorize = (id, name = 'execute_command', choice = 'chat', mode = 'ask_approval') => p.guardTool({
  sessionId: id, permissionMode: mode, name, args: { command: 'echo test' },
  requestApproval: payload => {
    prompts++;
    const controller = new AbortController();
    return p.requestToolApproval({ ...payload, sessionId: id, controller, requestId: 'request',
      sender: { isDestroyed: () => false, send: (_, event) => {
        if (!event.resolved) controller.toolApprovals.get(event.approvalId)(choice);
      } } });
  },
});
test.after(() => { db.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
test('native reads run without prompts while mutations and terminal Read Only remain blocked', async () => {
  for (const permissionMode of ['ask_approval', 'read_only']) {
    for (const name of ['web_search', 'get_single_web_page_content', 'extract_web_page_data', 'get_recent_chat_history', 'search_memory', 'read_file'])
      await p.guardTool({ name, permissionMode, requestApproval: () => assert.fail('unexpected prompt') });
    for (const name of ['write_file', 'delete_project_file']) await assert.rejects(p.guardTool({ name, permissionMode }));
  }
  await assert.rejects(authorize('a', 'execute_command', 'chat', 'read_only'), /Read Only/);
});
test('chat authorization persists through iterations, isolates tools and chats, denial prevents authorization', async () => {
  prompts = 0;
  await authorize('a'); await authorize('a'); assert.equal(prompts, 1);
  await assert.rejects(authorize('a', 'run_tests', 'deny'), /approval denied/);
  await assert.rejects(authorize('b', 'execute_command', 'deny'), /approval denied/);
  assert.equal(prompts, 3);
  contexts.forget('a');
  await assert.rejects(authorize('a', 'execute_command', 'deny'), /approval denied/);
});
test('persistent approvals reload from settings, respect hard limits and can be revoked', async () => {
  await authorize('a', 'execute_command', 'project');
  contexts.forget('a');
  const before = prompts;
  db.closeDatabase(); db.initDatabase(directory);
  await authorize('b'); assert.equal(prompts, before);
  await assert.rejects(authorize('b', 'execute_command', 'chat', 'read_only'), /Read Only/);
  const rule = rules.list(null).find(row => row.tool === 'execute_command');
  rules.remove(null, rule.id);
  await assert.rejects(authorize('b', 'execute_command', 'deny'), /approval denied/);
});
test('casual MCP policy trusts enabled integrations including arbitrary writes, without changing Workspace policy', () => {
  for (const mode of ['read_only', 'ask_approval', 'full_access']) for (const tool of ['browser_navigate', 'extract_page', 'delete_record', 'run_script']) {
    for (const stage of ['evaluate', 'mcp_dispatch']) assert.equal(decide({ native: false, tool, mode, stage, mutationRequiresConfirmation: true }).decision, 'allow');
    assert.equal(p.isToolVisible(tool, { native: false, permissionMode: mode }), true);
  }
  assert.equal(decide({ native: false, tool: 'delete_record', mode: 'read_only', workspaceRoot: '/workspace' }).decision, 'block');
  assert.equal(decide({ native: true, tool: 'run_tests', mode: 'full_access' }).decision, 'allow');
});
test('MCP dispatch repeats enabled reads and writes, reports tool errors and rejects disabled tools', async () => {
  const { McpManager } = require('../src/main/mcpManager');
  let executions = 0;
  const manager = new McpManager({ configPath: path.join(directory, 'mcp.json'), createConnection: async () => ({
    setNotificationHandler() {}, listTools: async () => ({ tools: ['browser_navigate', 'write_record', 'fail'].map(name => ({ name, inputSchema: { type: 'object' } })) }),
    callTool: async ({ name }) => { executions++; if (name === 'fail') throw new Error('service unavailable'); return { content: [] }; },
    close: async () => {},
  }) });
  try {
    await manager.saveConfig({ mcpServers: { fixture: { command: 'mock-only' } } });
    for (const permissionMode of ['read_only', 'ask_approval']) for (const name of ['browser_navigate', 'write_record', 'write_record'])
      await manager.callTool('fixture', name, {}, { permissionMode });
    assert.equal(executions, 6);
    await assert.rejects(manager.callTool('fixture', 'fail', {}, { permissionMode: 'ask_approval' }), /service unavailable/);
    await manager.setToolEnabled('write_record', false, 'fixture');
    await assert.rejects(manager.callTool('fixture', 'write_record', {}), /disabled/);
    await manager.setServerEnabled('fixture', false);
    await assert.rejects(manager.callTool('fixture', 'browser_navigate', {}), /disabled/);
    assert.equal(executions, 7);
  } finally { await manager.close(); }
});
