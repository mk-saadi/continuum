'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-phase2-'));
const load = Module._load;
const handlers = new Map();
let fetchMock;
let dispose;
Module._load = function (name, ...args) {
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
const permissions = require('../src/main/toolPermissions');
const { guardTool } = permissions;
const { decideToolApproval } = require('../src/main/toolApprovalPolicy');
const recovery = require('../src/main/recoveryStore');
const { executeAgentTool } = require('../src/main/tools/agentTools');
const sandboxProfile = require('../src/main/workspaceSandboxProfile');
const { McpManager } = require('../src/main/mcpManager');
let seq = 0;
function fixture(git = false) {
  const root = path.join(directory, `project-${++seq}`); fs.mkdirSync(root);
  const project = require('../src/main/projectManager').createProject({ name: `Phase 2 ${seq}`, root_path: root });
  const sessionId = `phase2-${seq}`;
  require('../src/main/sessionManager').getOrCreateSession(sessionId, 'model', project.id);
  const f = { root, project, sessionId, permissionMode: 'workspace_write' };
  if (git) {
    f.git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    f.git(['init', '-b', 'main']); f.git(['config', 'user.name', 'Fixture']); f.git(['config', 'user.email', 'fixture@example.test']);
    f.git(['commit', '--allow-empty', '-m', 'Initial']);
  }
  return f;
}
const authorize = (f, name, args, requestApproval = () => assert.fail('Unexpected prompt')) =>
  guardTool({ ...f, name, args, requestApproval });
const dispatch = (f, name, args, approval) => executeAgentTool({ ...f, name, arguments: args, permissionGranted: true, approval });
test.after(() => { dispose?.(); db.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
const sandbox = { bwrapAvailable: true, netUnshared: true, profile: 'bwrap_workspace' };
const commandInput = { tool: 'execute_command', args: { command: 'printf local' }, mode: 'workspace_write', workspaceRoot: '/workspace', sandbox,
  containment: { contained: true }, systemAffecting: false, packageOperation: false, commandReviewRequired: false };

test('shell table: containment, sandbox, system commands, packages and uncertainty', () => {
  assert.equal(decideToolApproval(commandInput).decision, 'allow');
  for (const facts of [
    { sandbox: { ...sandbox, bwrapAvailable: false } }, { sandbox: { ...sandbox, netUnshared: false } },
    { sandbox: { ...sandbox, profile: 'host' } }, { uncontained: true }, { systemAffecting: true },
    { sandbox: { ...sandbox, bwrapAvailable: 'true' } }, { sandbox: { ...sandbox, netUnshared: 'true' } },
    { packageOperation: true }, { commandReviewRequired: true }, { containment: undefined },
  ]) {
    const result = decideToolApproval({ ...commandInput, ...facts }); assert.equal(result.decision, 'ask'); assert.ok(result.reason);
  }
  assert.deepEqual(decideToolApproval({ ...commandInput, containment: { blocked: true, reason: 'Execution blocked: escape' } }),
    { decision: 'block', reason: 'Execution blocked: escape' });
  for (const tool of ['execute_command', 'run_tests']) {
    assert.equal(decideToolApproval({ ...commandInput, tool }).decision, 'allow');
    assert.equal(decideToolApproval({ ...commandInput, tool, mode: 'ask_approval' }).decision, 'ask');
    assert.equal(decideToolApproval({ ...commandInput, tool, mode: 'read_only' }).decision, 'block');
    assert.equal(decideToolApproval({ ...commandInput, tool, mode: 'full_access' }).decision, 'allow');
  }
});

test('package patterns keep explicit review; ordinary builds do not match', () => {
  const { isPackageOperation } = require('../src/main/workspaceCommandPolicy');
  for (const command of ['npm install lodash', 'npm ci', 'pnpm add x', 'yarn install', 'bun add x', 'python -m pip install x',
    'pip install x', 'npm publish', 'cargo install x', 'go get example.test/x', 'composer require x']) assert.equal(isPackageOperation(command), true, command);
  for (const command of ['npm test', 'pnpm run build', 'git status', 'printf local']) assert.equal(isPackageOperation(command), false, command);
});

test('literal cwd and path escapes, including bare symlinks, remain blocked', async () => {
  const f = fixture(); fs.symlinkSync(directory, path.join(f.root, 'escape'));
  for (const args of [{ command: 'cat ../outside' }, { command: 'cat escape/file' }, { command: 'cat escape' }, { command: "cat e''scape" }, { command: "cat 'e'scape" }, { command: 'printf local', cwd: '..' }])
    await assert.rejects(authorize(f, 'execute_command', args), /escapes/);
  for (const command of ['cat *', '(cat file)', 'node -e "console.log(1)"', 'echo $HOME', 'cd nested && cat file', 'npm install x', 'sudo true']) {
    let prompts = 0;
    await assert.rejects(authorize(f, 'execute_command', { command }, () => { prompts++; return false; }), /approval denied/);
    assert.equal(prompts, 1, command);
  }
});

test('autonomous shell grants are bound to bwrap; profile or scope tampering is refused', async () => {
  const f = fixture(), runner = require('../src/main/foregroundCommand'), original = runner.runForeground;
  const args = { command: 'printf local' }; const invocations = [];
  runner.runForeground = async (file, argv, settings) => { invocations.push({ file, argv, settings }); return { status: 'completed', exitCode: 0, stdout: 'local', stderr: '' }; };
  try {
    const grant = await authorize(f, 'execute_command', args);
    assert.equal(grant.approved, false); assert.equal(grant.executionProfile, 'bwrap_workspace');
    assert.equal((await dispatch(f, 'execute_command', args, grant)).success, true);
    assert.equal(invocations[0].file, 'bwrap'); assert.ok(invocations[0].argv.includes('--unshare-net'));
    assert.equal((await dispatch(f, 'execute_command', args, grant)).success, false, 'single use');
    for (const changes of [{ commandUncontained: true }, { executionProfile: 'host' }, { executionProfile: undefined }, { approved: true, commandUncontained: true }]) {
      const changed = await authorize(f, 'execute_command', args); Object.assign(changed, changes);
      assert.equal((await dispatch(f, 'execute_command', args, changed)).success, false);
    }
    assert.equal(invocations.length, 1, 'tampering never launches a host process');
  } finally { runner.runForeground = original; }
});

test('bwrap unavailable asks; denial launches nothing and approved failure never falls back to host', async () => {
  const f = fixture(), runner = require('../src/main/foregroundCommand');
  const originalProfile = sandboxProfile.getWorkspaceSandboxProfile, originalRun = runner.runForeground;
  const invocations = []; let prompts = 0;
  sandboxProfile.getWorkspaceSandboxProfile = async () => ({ bwrapAvailable: false, netUnshared: false, profile: null });
  runner.runForeground = async file => { invocations.push(file); return { status: 'spawn_failed', spawnError: 'ENOENT', exitCode: null, stdout: '', stderr: 'bwrap unavailable' }; };
  try {
    for (const name of ['execute_command', 'run_tests']) {
      const args = { command: 'printf local' };
      await assert.rejects(authorize(f, name, args, () => { prompts++; return false; }), /approval denied/);
      assert.equal(invocations.length, name === 'execute_command' ? 0 : 1);
      const grant = await authorize(f, name, args, () => { prompts++; return true; });
      assert.equal(grant.commandUncontained, false);
      const result = await dispatch(f, name, args, grant); assert.equal(result.success, false);
    }
    assert.equal(prompts, 4); assert.deepEqual(invocations, ['bwrap', 'bwrap']);
    await assert.rejects(guardTool({ name: 'execute_command', args: { command: 'printf host' }, permissionMode: 'ask_approval',
      requestApproval: () => false }), /approval denied/);
    assert.deepEqual(invocations, ['bwrap', 'bwrap']);
  } finally { sandboxProfile.getWorkspaceSandboxProfile = originalProfile; runner.runForeground = originalRun; }
});

test('Git table: clean switch and local operations allow; destructive variants ask', () => {
  const input = { mode: 'workspace_write', workspaceRoot: '/workspace' };
  for (const tool of ['git_stage', 'git_unstage', 'git_create_branch', 'git_switch', 'git_commit'])
    assert.equal(decideToolApproval({ ...input, tool }).decision, 'allow', tool);
  for (const action of ['list', 'show', 'push']) assert.equal(decideToolApproval({ ...input, tool: 'git_stash', args: { action } }).decision, 'allow');
  for (const action of ['drop', 'clear', 'pop']) assert.equal(decideToolApproval({ ...input, tool: 'git_stash', args: { action } }).decision, 'ask');
  for (const args of [{ force: true }, { discard: true }, { discard_changes: true }, { flags: '--discard-changes' }, { flags: '-f' }])
    assert.equal(decideToolApproval({ ...input, tool: 'git_switch', args }).decision, 'ask');
  assert.equal(decideToolApproval({ ...input, tool: 'git_switch', gitWorktreeDirty: true }).decision, 'ask');
  // The native commit schema has no amend/history-rewrite option.
  const schema = require('../src/main/tools/agentTools').agentTools.find(t => t.function.name === 'git_commit').function.parameters;
  assert.equal(Object.hasOwn(schema.properties, 'amend'), false);
});

test('Git real guard: fetch silent, pull once with cached incoming commits, push twice', async () => {
  const f = fixture(true); const remote = path.join(f.root, 'remote.git');
  f.git(['init', '--bare', remote]); f.git(['remote', 'add', 'origin', remote]);
  await authorize(f, 'git_sync', { action: 'fetch' });
  fs.writeFileSync(path.join(f.root, 'file'), 'initial'); f.git(['add', 'file']); f.git(['commit', '-m', 'Incoming fixture']);
  f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); f.git(['reset', '--hard', 'HEAD~1']);
  const pulls = []; await authorize(f, 'git_sync', { action: 'pull' }, p => { pulls.push(p); return true; });
  assert.equal(pulls.length, 1); assert.match(pulls[0].args.incoming, /Incoming fixture/);
  const pushes = []; const grant = await authorize(f, 'git_sync', { action: 'push' }, p => { pushes.push(p); return true; });
  assert.deepEqual(pushes.map(p => p.args.action), ['prepare_push', 'push']); assert.ok(grant.gitPushFingerprint);
});

test('clean switch runs without approval; dirty switch asks and still refuses to discard', async () => {
  const f = fixture(true); f.git(['branch', 'other']);
  const args = { ref: 'other' }; const grant = await authorize(f, 'git_switch', args);
  assert.equal((await dispatch(f, 'git_switch', args, grant)).branch, 'other');
  assert.equal(f.git(['branch', '--show-current']).trim(), 'other');
  fs.writeFileSync(path.join(f.root, 'file'), 'tracked'); f.git(['add', 'file']);
  let prompts = 0; const dirty = await authorize(f, 'git_switch', { ref: 'main' }, () => { prompts++; return true; });
  assert.equal(prompts, 1); const result = await dispatch(f, 'git_switch', { ref: 'main' }, dirty);
  assert.equal(result.success, false); assert.match(result.error, /staged or unstaged changes/);
});

test('checkpoint coverage must match this exact file; partial/skipped/excluded/failed asks', () => {
  const input = { tool: 'delete_project_file', args: { path: 'file' }, mode: 'workspace_write', workspaceRoot: '/workspace' };
  const coverage = { complete: true, path: 'file', captured: true, skipped: [], excluded: [] };
  assert.equal(decideToolApproval({ ...input, checkpointCoverage: coverage }).decision, 'allow');
  for (const facts of [{ complete: false }, { path: 'other' }, { captured: false }, { skipped: [{ path: 'file' }] }, { excluded: ['file'] }]) {
    const result = decideToolApproval({ ...input, checkpointCoverage: { ...coverage, ...facts } }); assert.equal(result.decision, 'ask'); assert.ok(result.reason);
  }
  assert.equal(decideToolApproval(input).decision, 'ask');
});

test('covered deletion captures once, runs without asking, and keeps an unpinned checkpoint', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'file'), 'before');
  const original = recovery.captureOperation; let captures = 0;
  recovery.captureOperation = async opts => { captures++; assert.deepEqual(opts.required, ['file']); return original(opts); };
  try {
    const args = { path: 'file' }, grant = await authorize(f, 'delete_project_file', args);
    assert.equal(grant.approved, false); const result = await dispatch(f, 'delete_project_file', args, grant);
    assert.equal(result.success, true, result.error); assert.equal(captures, 1);
    assert.equal(fs.existsSync(path.join(f.root, 'file')), false);
    assert.equal(db.db.prepare('SELECT pinned FROM recovery_checkpoints WHERE id=?').get(result.recoveryCheckpointId).pinned, 0);
  } finally { recovery.captureOperation = original; }
});

test('incomplete and failed capture require consent; denial leaves no pinned orphan', async () => {
  const f = fixture(), original = recovery.captureOperation;
  fs.writeFileSync(path.join(f.root, 'file'), 'before'); const args = { path: 'file' };
  try {
    for (const variant of ['partial', 'skipped', 'excluded', 'failed']) {
      recovery.captureOperation = async opts => {
        if (variant === 'failed') throw new Error('fixture capture failed');
        const result = await original(opts);
        result.coverage = { ...result.coverage, complete: variant !== 'partial',
          ...(variant === 'skipped' ? { skipped: [{ path: 'file' }] } : {}), ...(variant === 'excluded' ? { excluded: ['file'] } : {}) };
        return result;
      };
      let prompts = 0;
      await assert.rejects(authorize(f, 'delete_project_file', args, () => { prompts++; return false; }), /approval denied/);
      assert.equal(prompts, 1, variant); assert.equal(fs.readFileSync(path.join(f.root, 'file'), 'utf8'), 'before');
      assert.equal(db.db.prepare('SELECT count(*) AS n FROM recovery_checkpoints WHERE pinned=1').get().n, 0);
    }
    recovery.captureOperation = async () => { throw new Error('fixture capture failed'); };
    const approved = await authorize(f, 'delete_project_file', args, () => true);
    const result = await dispatch(f, 'delete_project_file', args, approved); assert.equal(result.success, true, result.error);
    assert.equal(result.recoveryCheckpointId, null);
  } finally { recovery.captureOperation = original; }
});

test('a file changed during capture is refused even after fallback consent', async () => {
  const f = fixture(), original = recovery.captureOperation; fs.writeFileSync(path.join(f.root, 'file'), 'before');
  recovery.captureOperation = async opts => { const result = await original(opts); fs.writeFileSync(path.join(f.root, 'file'), 'changed'); return result; };
  try {
    const args = { path: 'file' }; const grant = await authorize(f, 'delete_project_file', args, () => true);
    const result = await dispatch(f, 'delete_project_file', args, grant);
    assert.equal(result.success, false); assert.match(result.error, /changed since approval/);
    assert.equal(fs.readFileSync(path.join(f.root, 'file'), 'utf8'), 'changed');
  } finally { recovery.captureOperation = original; }
});

test('MCP trusted hints skip only benign argument heuristics; outer and dispatch agree', async () => {
  const f = fixture();
  for (const [tool, args, annotations, trusted, decision] of [
    ['read_records', { body: 'filter' }, { readOnlyHint: true }, true, 'allow'],
    ['write_file', { path: 'file', content: 'DROP TABLE notes' }, {}, false, 'allow'],
    ['read_records', { payload: { filter: 1 } }, { readOnlyHint: true }, false, 'ask'],
    ['read_records', {}, { destructiveHint: true }, true, 'ask'],
    ['read_records', { script: 'return 1' }, { readOnlyHint: true }, true, 'ask'],
    ['read_records', { command: 'git push' }, { readOnlyHint: true }, true, 'ask'],
    ['send_message', {}, { readOnlyHint: true }, true, 'ask'], ['delete_file', {}, { readOnlyHint: true }, true, 'ask'],
    ['push_files', {}, { readOnlyHint: true }, true, 'ask'], ['unknown', {}, { readOnlyHint: true }, true, 'ask'],
    ['read_records', { body: { script: 'return 1' } }, { readOnlyHint: true }, true, 'ask'],
    ['read_records', { payload: { action: 'send' } }, { readOnlyHint: true }, true, 'ask'],
    ['read_records', { request: { method: 'POST', endpoint: '/api/send' } }, { readOnlyHint: true }, true, 'ask'],
    ['read_records', { body: 'DELETE FROM records' }, { readOnlyHint: true }, true, 'ask'],
  ]) {
    const input = { tool, args, native: false, mode: 'workspace_write', workspaceRoot: f.root, serverName: 'fixture', annotations, serverTrusted: trusted };
    const outer = decideToolApproval(input), backstop = decideToolApproval({ ...input, stage: 'mcp_dispatch', workspaceMcp: f.root });
    assert.equal(outer.decision, decision); assert.equal(backstop.decision, decision);
    if (decision === 'ask') { assert.ok(outer.reason); assert.ok(backstop.reason); }
    const manager = new McpManager(); manager.servers.set('fixture', { enabled: true, status: 'connected', disabledTools: new Set(), definition: { trusted },
      tools: [{ name: tool, annotations }], client: { callTool: async () => ({ content: [] }) } });
    const options = { sessionId: f.sessionId, permissionMode: 'workspace_write', permissionGranted: true };
    if (decision === 'ask') await assert.rejects(manager.callTool('fixture', tool, args, options), /approval|destructive/);
    else await manager.callTool('fixture', tool, args, options);
    await manager.callTool('fixture', tool, args, { ...options, approval: { mode: 'workspace_write', approved: true } });
  }
});

test('trusted is a validated per-server boolean and defaults to false', async () => {
  const manager = new McpManager({ configPath: path.join(directory, 'trust-config.json'), lazyByDefault: true });
  try {
    await assert.rejects(manager.saveConfig({ mcpServers: { x: { command: 'fixture', trusted: 'true' } } }), /Invalid trusted/);
    const config = await manager.saveConfig({ mcpServers: { x: { command: 'fixture', trusted: true, disabled: true } } });
    assert.equal(config.mcpServers.x.trusted, true);
    manager.servers.set('fixture', { definition: {}, tools: [{ name: 'read' }] });
    assert.equal(manager.getApprovalFacts('fixture', 'read').serverTrusted, false);
  } finally { manager.servers.delete('fixture'); await manager.close(); }
});

test('commit message and staged diff are persisted in the actual IPC tool-call card', async () => {
  const f = fixture(true); fs.writeFileSync(path.join(f.root, 'review.txt'), 'card-visible content'); f.git(['add', 'review.txt']);
  const manager = require('../src/main/mcpManager');
  const originals = { init: manager.init, reload: manager.reload, getTools: manager.getTools };
  manager.init = manager.reload = async () => {}; manager.getTools = () => [];
  const owner = new (require('node:events').EventEmitter)(); owner.isDestroyed = () => false;
  const cards = []; let prompts = 0, rounds = 0;
  owner.send = (channel, value) => {
    if (channel === 'engine:request-tool-approval' && !value.resolved) prompts++;
    if (channel === 'stream:step-update') cards.push(structuredClone(value));
  };
  dispose = require('../src/main/ipcHandlers').registerIpcHandlers({ isTrustedSender: () => true,
    getEngineConfig: () => ({ port: 12345, modelPath: 'model', activeModelConfig: { contextLength: 32768 } }), beginEngineRequest: () => () => {} });
  fetchMock = async () => Response.json({ choices: [{ finish_reason: rounds++ === 0 ? 'tool_calls' : 'stop',
    message: rounds === 1 ? { tool_calls: [{ id: 'phase2-commit', type: 'function', function: { name: 'git_commit', arguments: '{"message":"Card review commit"}' } }] }
      : { content: 'Committed. [TASK COMPLETE]' } }] });
  try {
    await handlers.get('engine:chat')({ sender: owner }, { requestId: 'phase2-card', sessionId: f.sessionId, modelId: 'model',
      messages: [{ role: 'user', content: 'Commit the staged fixture.' }] });
    assert.equal(prompts, 0); assert.equal(rounds, 2);
    const step = cards.flatMap(card => card.executionSteps).find(step => step.id === 'phase2-commit' && step.args?.staged_diff);
    assert.ok(step); assert.equal(step.args.message, 'Card review commit'); assert.match(step.args.staged_diff, /card-visible content/);
    const saved = db.db.prepare('SELECT execution_steps FROM messages WHERE session_id=? AND execution_steps IS NOT NULL').all(f.sessionId);
    assert.ok(saved.some(message => JSON.parse(message.execution_steps).some(step => step.args?.staged_diff?.includes('card-visible content'))));
    assert.equal(f.git(['log', '-1', '--format=%s']).trim(), 'Card review commit');
  } finally { dispose(); dispose = null; Object.assign(manager, originals); }
});

test('authorized uncontained execution still requires an explicit ask', async () => {
  const f = { ...fixture(), permissionMode: 'ask_approval' }, runner = require('../src/main/foregroundCommand');
  const original = runner.runForeground; const invocations = [];
  runner.runForeground = async file => { invocations.push(file); return { status: 'completed', exitCode: 0, stdout: 'approved host', stderr: '' }; };
  const args = { command: 'printf approved', cwd: '..' };
  try {
    await assert.rejects(authorize(f, 'execute_command', args, () => false), /approval denied/);
    assert.deepEqual(invocations, []);
    const grant = await authorize(f, 'execute_command', args, () => true);
    assert.equal(grant.approved, true); assert.equal(grant.commandUncontained, true);
    assert.equal((await dispatch(f, 'execute_command', args, grant)).success, true);
    assert.deepEqual(invocations, ['/bin/sh']);
  } finally { runner.runForeground = original; }
});

test('bwrap disappearing after autonomous authorization fails without a host retry', async () => {
  const f = fixture(), runner = require('../src/main/foregroundCommand');
  const originalRun = runner.runForeground, originalProfile = sandboxProfile.getWorkspaceSandboxProfile;
  const calls = [], args = { command: 'printf forbidden > never-host' };
  sandboxProfile.getWorkspaceSandboxProfile = async () => sandbox;
  runner.runForeground = async file => { calls.push(file); return { status: 'spawn_failed', spawnError: 'ENOENT', exitCode: null, stdout: '', stderr: 'bwrap unavailable' }; };
  try {
    const grant = await authorize(f, 'execute_command', args);
    assert.equal(grant.approved, false); assert.equal(grant.executionProfile, 'bwrap_workspace');
    const result = await dispatch(f, 'execute_command', args, grant);
    assert.equal(result.success, false); assert.equal(result.status, 'spawn_failed');
    assert.deepEqual(calls, ['bwrap']); assert.equal(fs.existsSync(path.join(f.root, 'never-host')), false);
  } finally { runner.runForeground = originalRun; sandboxProfile.getWorkspaceSandboxProfile = originalProfile; }
});

test('autonomous command paths are rechecked after asynchronous recovery preparation', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'file'), 'inside');
  const args = { command: 'cat file' }, grant = await authorize(f, 'execute_command', args);
  const runner = require('../src/main/foregroundCommand'), boundary = require('../src/main/recoveryBoundary');
  const originalRun = runner.runForeground, originalRecovery = boundary.withShellRecovery; let launches = 0;
  runner.runForeground = async () => { launches++; return { status: 'completed', exitCode: 0, stdout: '', stderr: '' }; };
  boundary.withShellRecovery = async (_options, execute) => {
    fs.unlinkSync(path.join(f.root, 'file')); fs.symlinkSync(directory, path.join(f.root, 'file'));
    return execute();
  };
  try {
    const result = await dispatch(f, 'execute_command', args, grant);
    assert.equal(result.success, false); assert.match(result.error, /escapes/); assert.equal(launches, 0);
  } finally { runner.runForeground = originalRun; boundary.withShellRecovery = originalRecovery; }
});
