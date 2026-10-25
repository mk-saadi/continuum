'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remembered-rules-'));
const load = Module._load;
const handlers = new Map();
let fetchMock;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => {
    const endpoint = new URL(params[0]).pathname;
    if (endpoint === '/props') return Promise.resolve(Response.json({ default_generation_settings: { n_ctx: 262144 } }));
    if (endpoint === '/apply-template') return Promise.resolve(Response.json({ prompt: params[1].body }));
    if (endpoint === '/tokenize') return Promise.resolve(Response.json({ tokens: Array(100).fill(0) }));
    return fetchMock(...params);
  } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db'); db.initDatabase(directory);
const p = require('../src/main/toolPermissions');
const { decideToolApproval: decide } = require('../src/main/toolApprovalPolicy');
const rules = require('../src/main/rememberedToolRules');
const contexts = require('../src/main/lspExecutionContext');
const sandboxModule = require('../src/main/workspaceSandboxProfile');
const originalSandbox = sandboxModule.getWorkspaceSandboxProfile;
const sandbox = { bwrapAvailable: true, netUnshared: true, profile: 'bwrap_workspace', filesystemProfile: 'sandboxFilesystem' };
sandboxModule.getWorkspaceSandboxProfile = async () => sandbox;
let seq = 0;
function fixture(project) {
  const root = path.join(directory, `root-${++seq}`); fs.mkdirSync(root);
  project ??= require('../src/main/projectManager').createProject({ name: `Rules ${seq}`, root_path: root });
  const sessionId = `rules-${seq}`;
  require('../src/main/sessionManager').getOrCreateSession(sessionId, 'model', project.id);
  contexts.forTool(sessionId, 'workspace_write');
  return { project, sessionId, permissionMode: 'workspace_write' };
}
const shell = { tool: 'execute_command', args: { command: 'npm ci' }, mode: 'workspace_write', workspaceRoot: '/workspace',
  resolvedCwd: '/workspace', containment: { contained: true }, sandbox, systemAffecting: false, packageOperation: true, commandReviewRequired: true };
function saved(input) {
  const policy = decide(input); assert.equal(policy.rememberable, true);
  return [{ id: 'rule', rule_key: policy.rememberKey, label: policy.rememberLabel, scope: 'project' }];
}
function approval(f, choice = 'project', mutate) {
  return payload => {
    const controller = new AbortController();
    const sender = { isDestroyed: () => false, send: (channel, event) => {
      if (event.resolved) return;
      mutate?.(event);
      controller.toolApprovals.get(event.approvalId)(choice);
    } };
    return p.requestToolApproval({ ...payload, ...f, requestId: 'request', controller, sender });
  };
}
const authorize = (f, name = 'execute_command', args = { command: 'npm ci' }, requestApproval) => p.guardTool({ ...f, name, args, requestApproval });
test.after(() => { sandboxModule.getWorkspaceSandboxProfile = originalSandbox; db.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });

test('rememberability matrix: only local installs, provider images and heuristic MCP in Workspace Write', () => {
  assert.equal(decide(shell).rememberable, true);
  for (const mode of ['ask_approval', 'read_only', 'full_access']) {
    const result = decide({ ...shell, mode, remembered: saved(shell) });
    assert.equal(result.savedRule, undefined);
    if (result.decision === 'ask') assert.equal(result.rememberable, false);
  }
  for (const override of [
    { uncontained: true }, { systemAffecting: true }, { containment: { blocked: true, reason: 'outside' } },
    { sandbox: { ...sandbox, bwrapAvailable: false } }, { sandbox: { ...sandbox, filesystemProfile: null } }, { sandbox: { ...sandbox, netUnshared: false } },
    ...['sudo npm ci', 'npm install -g x', 'npm publish', 'npm ci; true', 'npm ci && true', 'npm ci | cat', 'npm ci\n', 'npm ci $(id)', 'npm ci > out', 'npm ci < in', 'npm ci `id`', 'npm ci (x)', 'npm install ../x', 'npm install ..', 'npm install *'].map(command => ({ args: { command } })),
  ]) {
    const result = decide({ ...shell, ...override, remembered: saved(shell) });
    assert.equal(result.savedRule, undefined, JSON.stringify(override));
    if (result.decision === 'ask') assert.equal(result.rememberable, false, JSON.stringify(override));
  }
  for (const input of [
    { tool: 'git_sync', args: { action: 'push' } }, { tool: 'git_switch', gitWorktreeDirty: true },
    { tool: 'delete_project_file', args: { path: 'x' }, checkpointCoverage: { complete: false } },
    { tool: 'approve_mcp_mutation' },
    ...['send_message', 'publish', 'push_files', 'unknown', 'delete_file'].map(tool => ({ tool, native: false, serverName: 'server' })),
    { tool: 'read_records', native: false, args: { code: '1' } },
    { tool: 'read_records', native: false, args: { body: { command: 'id' } } },
    { tool: 'read_records', native: false, args: { body: { query: 'UPDATE t SET x=1' } } },
    { tool: 'read_records', native: false, args: { body: 'data' }, annotations: { destructiveHint: true } },
    { tool: 'query', native: false, args: { query: 'UPDATE t SET x=1' } },
  ]) {
    const result = decide({ mode: 'workspace_write', workspaceRoot: '/workspace', serverName: 'server', ...input });
    assert.equal(result.decision, 'ask', input.tool); assert.equal(result.rememberable, false, input.tool);
  }
  const image = { tool: 'generate_image', mode: 'workspace_write', workspaceRoot: '/workspace', imageProviderKey: 'provider-a' };
  for (const eligible of [shell, image, { tool: 'read_records', native: false, serverName: 'server', args: { body: {} }, mode: 'workspace_write', workspaceRoot: '/workspace' }]) {
    for (const mode of ['ask_approval', 'read_only', 'full_access']) {
      const result = decide({ ...eligible, mode, remembered: saved(eligible) });
      assert.equal(result.savedRule, undefined);
      if (result.decision === 'ask') assert.equal(result.rememberable, false);
    }
  }
  assert.equal(decide(image).rememberable, true);
  assert.equal(decide({ ...image, remembered: saved(image) }).decision, 'allow');
  assert.equal(decide({ ...image, imageProviderKey: 'provider-b', remembered: saved(image) }).decision, 'ask');
  const mcp = { tool: 'read_records', native: false, serverName: 'server', args: { body: { filter: 'a' } }, mode: 'workspace_write', workspaceRoot: '/workspace' };
  assert.equal(decide(mcp).rememberable, true);
  assert.equal(decide({ ...mcp, remembered: saved(mcp) }).decision, 'allow');
  assert.equal(decide({ ...mcp, serverName: 'other', remembered: saved(mcp) }).decision, 'ask');
  assert.equal(decide({ ...mcp, args: { body: { code: 'id' } }, remembered: saved(mcp) }).rememberable, false);
  assert.equal(decide({ ...mcp, args: { body: {}, options: { code: 'id' } }, remembered: saved(mcp) }).rememberable, false);
});

test('shell match is exact after whitespace normalization and includes tool and cwd', () => {
  const remembered = saved(shell);
  assert.equal(decide({ ...shell, args: { command: '  npm\t ci  ' }, remembered }).decision, 'allow');
  for (const override of [{ args: { command: 'npm install' } }, { resolvedCwd: '/workspace/sub' }, { tool: 'run_tests' }, { args: { command: 'npm ci;' } }])
    assert.equal(decide({ ...shell, ...override, remembered }).decision, 'ask');
});

test('chat rules stay in their chat; project rules stay in their project and survive DB reopen', async () => {
  const a = fixture(), b = fixture(a.project), c = fixture();
  await authorize(a, undefined, undefined, approval(a, 'chat', event => { assert.equal(event.rememberable, true); assert.equal(event.rememberLabel, 'npm ci'); assert.equal(event.rememberKey, undefined); }));
  assert.equal((await authorize(a)).savedRule.scope, 'chat');
  await assert.rejects(authorize(b), { code: 'APPROVAL_DENIED' });
  await assert.rejects(authorize(c), { code: 'APPROVAL_DENIED' });
  await authorize(b, undefined, undefined, approval(b));
  assert.equal((await authorize(b)).savedRule.scope, 'project');
  assert.equal((await authorize({ ...a, sessionId: b.sessionId })).savedRule.scope, 'project');
  const row = rules.list(a.project.id).find(r => r.tool === 'execute_command');
  assert.ok(row.use_count >= 2); assert.ok(row.last_used_at);
  db.closeDatabase(); db.initDatabase(directory);
  assert.equal(rules.list(a.project.id)[0].id, row.id);
  await assert.rejects(authorize(c), { code: 'APPROVAL_DENIED' });
});

test('rule save/remove invalidates pending approvals and old single-use argument-bound grants', async () => {
  const f = fixture();
  const grant = await authorize(f, 'execute_command', { command: 'printf ok' });
  const old = contexts.revision(f.sessionId);
  const controller = new AbortController();
  const pending = p.requestToolApproval({ ...f, controller, requestId: 'pending', name: 'generate_image', args: {}, sender: { isDestroyed: () => false, send() {} } });
  await authorize(f, undefined, undefined, approval(f));
  assert.equal(await pending, false);
  assert.notEqual(contexts.revision(f.sessionId), old);
  const execution = require('../src/main/nativeExecutionPolicy');
  assert.throws(() => execution.consume(grant, { name: 'execute_command', args: { command: 'printf ok' }, ...f, ...grant, policyRevision: contexts.revision(f.sessionId) }), /current, specific/);
  const decision = await authorize(f);
  const options = { name: 'execute_command', args: { command: 'npm ci' }, ...f, ...decision };
  execution.consume(decision, options);
  assert.throws(() => execution.consume(decision, options), /current, specific/);
  const row = rules.list(f.project.id)[0];
  const revision = contexts.revision(f.sessionId);
  rules.remove(f.project.id, row.id);
  assert.notEqual(contexts.revision(f.sessionId), revision);
  await assert.rejects(authorize(f), { code: 'APPROVAL_DENIED' });
});

test('approval choices cannot remember hard rules or use a renderer-supplied pattern', async () => {
  const f = fixture();
  const controller = new AbortController();
  let event;
  const promise = p.requestToolApproval({ ...f, controller, requestId: 'r', name: 'approve_mcp_mutation', args: {}, policy: { rememberable: false }, sender: { isDestroyed: () => false, send: (_, e) => { if (!e.resolved) event = e; } } });
  const finish = controller.toolApprovals.get(event.approvalId);
  assert.throws(() => finish('project'), /cannot be remembered/);
  finish('deny'); assert.equal(await promise, false);
  await authorize(f, undefined, undefined, approval(f, 'project', event => { event.rememberKey = '*'; event.args.command = 'sudo anything'; }));
  assert.equal(rules.list(f.project.id)[0].rule_key, JSON.stringify(['shell', 'execute_command', 'npm ci', f.project.root_path]));
  await assert.rejects(authorize(f, 'execute_command', { command: 'npm install' }), { code: 'APPROVAL_DENIED' });
});

test('migration is idempotent, DB enforces cap 200, and delete-all bumps revision', () => {
  const f = fixture();
  const statement = db.db.prepare('INSERT INTO project_tool_rules (id, project_id, tool, rule_key, label) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 200; i++) statement.run(`cap-${i}`, f.project.id, 'generate_image', `key-${i}`, `Label ${i}`);
  assert.throws(() => statement.run('overflow', f.project.id, 'generate_image', 'extra', 'Extra'), /limit.*200/);
  const revision = contexts.revision(f.sessionId);
  rules.removeAll(f.project.id);
  assert.equal(rules.list(f.project.id).length, 0); assert.notEqual(contexts.revision(f.sessionId), revision);
});

test('saved approval still fails containment and missing sandbox checks', async () => {
  const f = fixture();
  await authorize(f, undefined, undefined, approval(f));
  await assert.rejects(authorize(f, 'execute_command', { command: 'npm ci', cwd: '..' }), /Execution blocked/);
  sandboxModule.getWorkspaceSandboxProfile = async () => ({ ...sandbox, bwrapAvailable: false });
  try { await assert.rejects(authorize(f), { code: 'APPROVAL_DENIED' }); }
  finally { sandboxModule.getWorkspaceSandboxProfile = async () => sandbox; }
});

test('remembered MCP dispatch consumes a specific grant and still enforces hard rules', async () => {
  const f = fixture();
  const { McpManager } = require('../src/main/mcpManager');
  const manager = new McpManager();
  let calls = 0;
  manager.servers.set('fixture', { enabled: true, status: 'connected', disabledTools: new Set(), tools: [{ name: 'read_records' }],
    client: { callTool: async () => { calls++; return { content: [] }; } } });
  const args = { body: { filter: 'local' } };
  const options = { ...f, name: 'read_records', args, native: false, serverName: 'fixture' };
  await p.guardTool({ ...options, requestApproval: approval(f) });
  const grant = await p.guardTool(options);
  assert.ok(grant.savedRule);
  await manager.callTool('fixture', 'read_records', args, { ...f, permissionGranted: true, approval: grant });
  await assert.rejects(manager.callTool('fixture', 'read_records', args, { ...f, permissionGranted: true, approval: grant }), /current, specific/);
  const another = await p.guardTool(options);
  await assert.rejects(manager.callTool('fixture', 'read_records', { body: { code: 'id' } }, { ...f, permissionGranted: true, approval: another }), /Execution blocked/);
  assert.equal(calls, 1);
  manager.servers.delete('fixture'); await manager.close();
});

test('remembered shell grant still runs bwrap and never retries on host after spawn failure', async () => {
  const f = fixture();
  await authorize(f, undefined, undefined, approval(f));
  const grant = await authorize(f);
  const runner = require('../src/main/foregroundCommand');
  const original = runner.runForeground;
  const launches = [];
  runner.runForeground = async file => { launches.push(file); return { status: 'spawn_failed', spawnError: 'ENOENT', exitCode: null, stdout: '', stderr: 'missing sandbox' }; };
  try {
    const result = await require('../src/main/tools/agentTools').executeAgentTool({ ...f, name: 'execute_command', arguments: { command: 'npm ci' }, permissionGranted: true, approval: grant });
    assert.equal(result.success, false); assert.equal(result.status, 'spawn_failed');
    assert.deepEqual(launches, ['bwrap']);
  } finally { runner.runForeground = original; }
});

test('real IPC binds save choice to sender and pending policy; tool event persists rule id and removal IPC revokes it', async () => {
  const f = fixture();
  const manager = require('../src/main/mcpManager');
  const originals = { init: manager.init, reload: manager.reload, getTools: manager.getTools };
  manager.init = manager.reload = async () => {}; manager.getTools = () => [];
  const runner = require('../src/main/foregroundCommand');
  const originalRun = runner.runForeground;
  runner.runForeground = async () => ({ status: 'completed', exitCode: 0, stdout: 'installed', stderr: '' });
  const owner = new (require('node:events').EventEmitter)(); owner.isDestroyed = () => false;
  const stranger = new (require('node:events').EventEmitter)(); stranger.isDestroyed = () => false; stranger.send = () => {};
  const cards = [], checks = []; let prompts = 0, round = 0;
  owner.send = (channel, value) => {
    if (channel === 'stream:step-update') cards.push(structuredClone(value));
    if (channel === 'engine:request-tool-approval' && !value.resolved) {
      prompts++;
      checks.push((async () => {
        const input = { requestId: value.requestId, approvalId: value.approvalId, choice: 'project', rememberKey: '*', tool: 'sudo' };
        await assert.rejects(handlers.get('engine:tool-approval-response')({ sender: stranger }, input), /no longer pending/);
        if (value.rememberable) await handlers.get('engine:tool-approval-response')({ sender: owner }, input);
        else {
          await assert.rejects(handlers.get('engine:tool-approval-response')({ sender: owner }, input), /cannot be remembered/);
          await handlers.get('engine:tool-approval-response')({ sender: owner }, { ...input, choice: 'deny' });
        }
      })());
    }
  };
  const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true,
    getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  fetchMock = async () => {
    const calls = [call('activate', 'manage_native_tools', { action: 'activate', groups: ['commands'] }),
      call('first-install', 'execute_command', { command: 'npm ci' }), call('saved-install', 'execute_command', { command: 'npm ci' }), call('hard-rule', 'execute_command', { command: 'npm publish' })];
    const next = calls[round++];
    return Response.json({ choices: [{ finish_reason: next ? 'tool_calls' : 'stop', message: next ? { tool_calls: [next] } : { content: 'Done. [TASK COMPLETE]' } }] });
  };
  try {
    await handlers.get('engine:chat')({ sender: owner }, { requestId: 'rules-card', sessionId: f.sessionId, modelId: 'model', permissionMode: 'workspace_write',
      messages: [{ role: 'user', content: 'Install local packages twice.' }] });
    await Promise.all(checks);
    assert.equal(prompts, 2);
    const listed = await handlers.get('tool-rules:list')({ sender: owner }, { projectId: f.project.id });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].rule_key, JSON.stringify(['shell', 'execute_command', 'npm ci', f.project.root_path]));
    const step = cards.flatMap(card => card.executionSteps).find(step => step.id === 'saved-install' && step.savedRule);
    assert.equal(step?.savedRule.id, listed[0].id);
    const messages = db.db.prepare('SELECT execution_steps FROM messages WHERE session_id = ? AND execution_steps IS NOT NULL').all(f.sessionId);
    assert.ok(messages.some(message => JSON.parse(message.execution_steps).some(step => step.id === 'saved-install' && step.savedRule?.id === listed[0].id)));
    const revision = contexts.revision(f.sessionId);
    await handlers.get('tool-rules:delete')({ sender: owner }, { projectId: f.project.id, id: listed[0].id });
    assert.notEqual(contexts.revision(f.sessionId), revision);
    assert.equal(rules.list(f.project.id).length, 0);
    assert.equal(handlers.has('tool-rules:create'), false);
  } finally { dispose(); Object.assign(manager, originals); runner.runForeground = originalRun; }
});

test('image rules are per authoritative provider; grants are single-use and provider changes fail before network', async () => {
  const f = fixture();
  const providers = require('../src/main/cloudProviders');
  const original = providers.getActiveMediaModel;
  let provider = { id: 'image-a', name: 'Image A', apiType: 'stable-diffusion', baseUrl: 'https://image-a.invalid', modelId: 'model' };
  providers.getActiveMediaModel = () => provider;
  try {
    await authorize(f, 'generate_image', { prompt: 'First image' }, approval(f));
    const grant = await authorize(f, 'generate_image', { prompt: 'Different image' });
    assert.ok(grant.savedRule);
    provider = { ...provider, id: 'image-b', baseUrl: 'https://image-b.invalid' };
    await assert.rejects(authorize(f, 'generate_image', { prompt: 'Different image' }), { code: 'APPROVAL_DENIED' });
    const result = await require('../src/main/tools/agentTools').executeAgentTool({ ...f, name: 'generate_image', arguments: { prompt: 'Different image' }, permissionGranted: true, approval: grant });
    assert.equal(result.success, false); assert.match(result.error, /provider changed/);
    const again = await require('../src/main/tools/agentTools').executeAgentTool({ ...f, name: 'generate_image', arguments: { prompt: 'Different image' }, permissionGranted: true, approval: grant });
    assert.equal(again.success, false); assert.match(again.error, /current, specific/);
  } finally { providers.getActiveMediaModel = original; }
});

test('project edits revoke sibling-chat grants; chat removal revokes only that chat', async () => {
  const a = fixture(), b = fixture(a.project), c = fixture();
  const beforeB = contexts.revision(b.sessionId), beforeC = contexts.revision(c.sessionId);
  await authorize(a, undefined, undefined, approval(a));
  assert.notEqual(contexts.revision(b.sessionId), beforeB);
  assert.equal(contexts.revision(c.sessionId), beforeC);
  rules.removeAll(a.project.id);
  await authorize(a, undefined, undefined, approval(a, 'chat'));
  const currentB = contexts.revision(b.sessionId), currentA = contexts.revision(a.sessionId);
  const chat = rules.list(a.project.id, a.sessionId)[0];
  rules.remove(a.project.id, chat.id, a.sessionId);
  assert.equal(contexts.revision(b.sessionId), currentB);
  assert.notEqual(contexts.revision(a.sessionId), currentA);
  await assert.rejects(authorize(a), { code: 'APPROVAL_DENIED' });
});

test('existing database upgrades create tool-rule schema without changing project/session rows', () => {
  const f = fixture();
  db.db.prepare('DROP TABLE project_tool_rules').run();
  db.closeDatabase(); db.initDatabase(directory);
  assert.equal(db.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(f.sessionId).project_id, f.project.id);
  const columns = db.db.prepare('PRAGMA table_info(project_tool_rules)').all().map(row => row.name);
  assert.deepEqual(columns, ['id', 'project_id', 'tool', 'rule_key', 'label', 'created_at', 'last_used_at', 'use_count', 'created_by_session']);
  assert.equal(db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='project_tool_rules_cap'").get().name, 'project_tool_rules_cap');
});
