'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-autonomy-'));
const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
const load = Module._load;
Module._load = function(name, ...args) {
  return name === 'electron' ? { app: { isPackaged: false, isReady: () => true, getPath: () => temp } } : load.call(this, name, ...args);
};
const db = require('../src/main/db'); db.initDatabase(temp);
const project = require('../src/main/projectManager').createProject({ name: 'Autonomy acceptance', root_path: workspace });
require('../src/main/sessionManager').getOrCreateSession('autonomy', 'fixture', project.id);
const tools = require('../src/main/tools/agentTools');
const contexts = require('../src/main/lspExecutionContext');
const permissions = require('../src/main/toolPermissions');
const run = command => tools.executeAgentTool({ name: 'execute_command', arguments: { command }, sessionId: 'autonomy', permissionMode: 'workspace_write' });
test.after(async () => {
  await require('../src/main/backgroundCommands').shutdown();
  db.closeDatabase(); Module._load = load; fs.rmSync(temp, { recursive: true, force: true });
});
test('real native dispatcher executes a multi-command local coding workflow without any approval grant', async () => {
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'autonomy-fixture', version: '1.0.0', scripts: { build: 'node source.cjs' } }));
  fs.mkdirSync(path.join(workspace, 'local-dependency'));
  fs.writeFileSync(path.join(workspace, 'local-dependency/package.json'), JSON.stringify({ name: 'local-dependency', version: '1.0.0' }));
  for (const command of ['cat package.json', "printf 'console.log(42)\\n' > source.cjs", 'npm install --offline --no-audit --no-fund ./local-dependency', 'npm run build', "printf 'console.log(43)\\n' > source.cjs", 'npm run build']) {
    const result = await run(command);
    assert.equal(result.exitCode, 0, JSON.stringify({ command, result }));
    assert.equal(result.commandEnvironment.sandboxed, true);
  }
  assert.match(fs.readFileSync(path.join(workspace, 'source.cjs'), 'utf8'), /43/);
});
test('isolated effective capabilities prohibit downloads and preserve containment', async () => {
  const cap = require('../src/main/executionCapabilities').manifest('workspace_write', workspace);
  assert.equal(cap.networkState.operational, false);
  // Network may be unavailable due to missing dependencies in test environment.
  assert.ok(cap.network.includes('unavailable') || cap.network.includes('Do not retry'));
  assert.match(cap.packages, /local dependencies only/);
  for (const command of [`cat ${path.join(temp, 'secret')}`, `touch ${path.join(temp, 'escape')}`, 'cat /proc/1/environ']) {
    fs.writeFileSync(path.join(temp, 'secret'), 'sensitive');
    const result = await run(command);
    if (command.startsWith('cat /proc')) assert.ok(!result.stdout?.includes('sensitive'));
    else if (command.startsWith('cat ')) assert.notEqual(result.exitCode, 0, JSON.stringify(result));
  }
  assert.equal(fs.existsSync(path.join(temp, 'escape')), false);
  for (const name of ['list_directory', 'search_project_content', 'read_project_file']) {
    const denied = await tools.executeAgentTool({ name, arguments: { relative_path: '..', query: 'sensitive' }, sessionId: 'autonomy', permissionMode: 'workspace_write' });
    assert.equal(denied.success, false, name);
  }
});
test('Ask for Approval still prompts, Read Only blocks, network changes revoke issued grants', async () => {
  let prompts = 0;
  await permissions.guardTool({ name: 'execute_command', args: { command: 'true' }, project, permissionMode: 'ask_approval', requestApproval: async () => { prompts++; return true; } });
  assert.equal(prompts, 1);
  await assert.rejects(permissions.guardTool({ name: 'execute_command', args: { command: 'true' }, project, permissionMode: 'read_only' }), /Read Only/);
  const approval = await permissions.guardTool({ name: 'execute_command', args: { command: 'true' }, sessionId: 'autonomy', project, permissionMode: 'workspace_write' });
  await require('../src/main/configStore').setWorkspaceNetwork({ version: 3, policy: 'isolated' });
  const result = await tools.executeAgentTool({ name: 'execute_command', arguments: { command: 'true' }, sessionId: 'autonomy', permissionMode: 'workspace_write', permissionGranted: true, approval });
  assert.equal(result.success, false);
  assert.equal(result.code, 'PERMISSION_REVOKED');
});
test('running autonomous command honors cancellation', async () => {
  const controller = new AbortController();
  const operation = tools.executeAgentTool({ name: 'execute_command', arguments: { command: 'sleep 30' }, sessionId: 'autonomy', permissionMode: 'workspace_write', signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const result = await operation;
    assert.ok(result.cancelled || result.status === 'cancelled' || /abort|cancel/i.test(result.error || ''), JSON.stringify(result));
  } finally { clearTimeout(timer); }
});
test('effective network descriptions follow current trusted policy and readiness', () => {
  const config = require('../src/main/configStore'), policy = require('../src/main/workspaceNetworkPolicy');
  const originalConfig = config.getConfig, originalReady = policy.readiness;
  try {
    config.getConfig = () => ({ workspaceNetwork: { version: 2, policy: 'trusted_development' } });
    policy.readiness = () => ({ available: true, code: 'LOCAL_DEVELOPMENT' });
    const enabled = require('../src/main/executionCapabilities').manifest('workspace_write', workspace);
    assert.equal(enabled.networkState.operational, true);
    assert.match(enabled.network, /host\/private IPv4/);
    assert.match(enabled.network, /external IPv6 unavailable/);
    assert.match(enabled.packages, /downloads supported/);
    policy.readiness = () => ({ available: false, code: 'NETWORK_PREREQUISITE_UNAVAILABLE', message: 'Missing dependency' });
    const unavailable = require('../src/main/executionCapabilities').manifest('workspace_write', workspace);
    assert.equal(unavailable.networkState.operational, false);
    assert.match(unavailable.network, /NETWORK_PREREQUISITE_UNAVAILABLE/);
  } finally { config.getConfig = originalConfig; policy.readiness = originalReady; }
});
test('Ask for Approval remains supervised and offline while global Workspace Write networking is trusted', async () => {
  const config = require('../src/main/configStore'), network = require('../src/main/networkExecution');
  const originalConfig = config.getConfig, originalExecute = network.service.execute;
  let prompts = 0, networkCalls = 0;
  try {
    config.getConfig = () => ({ ...originalConfig(), workspaceNetwork: { version: 2, policy: 'trusted_development' } });
    network.service.execute = async () => { networkCalls++; throw Error('Ask must not acquire Workspace Write network authority'); };
    await contexts.setMode('autonomy', 'ask_approval');
    const args = { command: 'printf supervised' };
    const approval = await permissions.guardTool({ name: 'execute_command', args, sessionId: 'autonomy', project, permissionMode: 'ask_approval', requestApproval: async () => { prompts++; return true; } });
    const result = await tools.executeAgentTool({ name: 'execute_command', arguments: args, sessionId: 'autonomy', permissionMode: 'ask_approval', permissionGranted: true, approval });
    assert.equal(result.stdout, 'supervised');
    assert.equal(result.exitCode, 0);
    assert.equal(prompts, 1);
    assert.equal(networkCalls, 0);
    assert.equal(result.commandEnvironment.networkState.code, 'NETWORK_MODE_NOT_AUTHORIZED');
  } finally {
    config.getConfig = originalConfig; network.service.execute = originalExecute;
    await contexts.setMode('autonomy', 'workspace_write');
  }
});
