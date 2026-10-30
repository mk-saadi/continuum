// Focused coverage for the structured verification primitive (run_tests).
//
// The tool is a thin classifier over the existing command-execution path, so
// these tests exercise it through the real executeAgentTool dispatch (guard,
// workspace scoping, recovery boundary and all) plus the pure classifier for
// the outcomes that are impractical to trigger through a live shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-'));
const workspace = path.join(root, 'workspace');
const userData = path.join(root, 'userData');
fs.mkdirSync(workspace);
fs.mkdirSync(userData);

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron')
    return { app: { isReady: () => true, getPath: (name) => (name === 'userData' ? userData : root) } };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const { executeAgentTool, agentTools, structureVerification } = require('../src/main/tools/agentTools');
const { capabilityOf, guardTool, isToolVisible, CAPABILITIES } = require('../src/main/toolPermissions');

initDatabase(root);
const project = require('../src/main/projectManager').createProject({ name: 'Verify', root_path: workspace });
require('../src/main/sessionManager').getOrCreateSession('chat', 'model', project.id);

// Full access runs commands directly (no sandbox dependence), which keeps the
// execution-path assertions about outcomes — not bwrap availability — the
// focus. Permission and containment behavior is asserted separately below.
function run(args, { sessionId = 'chat', permissionMode = 'full_access', signal } = {}) {
  return require('./helpers/approvedNativeCommand.cjs')({ name: 'run_tests', arguments: JSON.stringify(args), sessionId, permissionMode, signal });
}

test.after(() => {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(root, { recursive: true, force: true });
});
const cp = require('node:child_process');
const capabilities = require('../src/main/executionCapabilities');
const plans = require('../src/main/workspacePlan');
const sessions = require('../src/main/sessionManager');
const contexts = require('../src/main/lspExecutionContext');
const call = (name, args, mode = 'full_access') => require('./helpers/approvedNativeCommand.cjs')({ name, arguments: JSON.stringify(args), sessionId: 'chat', permissionMode: mode });
cp.execFileSync('git', ['init', '-q', workspace]);

test('Full Access shell and test production dispatch bypass all sandbox setup and inherit host environment', async () => {
 const sandbox = require('../src/main/sandboxFilesystem');
 const original = sandbox.resolveFilesystem;
 sandbox.resolveFilesystem = () => { throw Error('sandbox socket poison sentinel'); };
 try {
  for (const name of ['execute_command', 'run_tests']) {
   const out = await call(name, { command: 'printf SYNTAX_OK' });
   assert.equal(out.exitCode, 0, JSON.stringify(out));
   assert.equal(out.success, true);
   assert.equal(out.commandEnvironment.profile, 'Host');
   assert.equal(out.commandEnvironment.isolatedHome, false);
   assert.equal(out.commandEnvironment.temporaryFiles, 'inherited host environment');
  }
  const env = await call('execute_command', { command: 'printf "%s\\n%s\\n%s" "$HOME" "$PATH" "$TMPDIR"' });
  assert.equal(env.stdout, [process.env.HOME || '', process.env.PATH || '', process.env.TMPDIR || ''].join('\n'));
  for (const name of ['git_status', 'git_branch', 'git_diff', 'git_log']) {
   const out = await call(name, {});
   assert.doesNotMatch(JSON.stringify(out), /sandbox socket poison/);
   if (name !== 'git_log') assert.equal(out.success === false, false, JSON.stringify(out));
  }
 } finally { sandbox.resolveFilesystem = original; }
});

test('Workspace Write never falls back to host and subsequent Full Access survives mode change', async () => {
 const sandbox = require('../src/main/sandboxFilesystem'); const original = sandbox.resolveFilesystem;
 sandbox.resolveFilesystem = () => { throw Error('sandbox socket poison sentinel'); };
 try {
  const isolated = await call('git_status', {}, 'workspace_write');
  assert.equal(isolated.success, false); assert.match(isolated.error, /sandbox socket poison/);
  const host = await call('git_status', {}); assert.ok(host.output);
 } finally { sandbox.resolveFilesystem = original; }
});

test('capability contract and exact display preflight do not classify arbitrary stdout or shell mentions', () => {
 const ww = capabilities.manifest('workspace_write', workspace);
 assert.equal(ww.network, 'unavailable'); assert.equal(ww.hostNvmInitialization, 'unavailable'); assert.equal(ww.graphicalTests, 'unavailable');
 assert.equal(capabilities.manifest('read_only', workspace).profile, 'No executable shell');
 assert.equal(capabilities.preflight({ command: "printf 'Xvfb'" }, true), null);
 assert.equal(capabilities.preflight({ command: 'node ordinary.cjs' }, true), null);
 for (const command of ['Xvfb :77', '/usr/bin/xvfb-run node ui.cjs']) {
  const out = capabilities.preflight({ command }, true); assert.equal(out.operation_executed, false); assert.equal(out.code, 'EXECUTION_CAPABILITY_UNAVAILABLE');
  assert.equal(capabilities.preflight({ command }, false), null);
 }
 const out = capabilities.preflight({ command: 'custom-runner', required_capability: 'x11_display' }, true);
 assert.equal(out.requiredCapability, 'x11_display');
});

test('narrow repeated display failure retains evidence and is scoped to run, command, cwd and permission revision', () => {
 const args = { command: 'node ui.cjs', cwd: '.' };
 const evidence = { exitCode: 1, stderr: 'Missing X server or $DISPLAY', stdout: 'original' };
 capabilities.remember(args, evidence, true, 'r5-run', 3);
 const repeated = capabilities.preflight(args, true, 'r5-run', 3);
 assert.deepEqual(repeated.previousEvidence, { command: args.command, ...evidence });
 assert.equal(repeated.operation_executed, false);
 for (const [run, revision] of [['other', 3], ['r5-run', 4]]) assert.equal(capabilities.preflight(args, true, run, revision), null);
 assert.equal(capabilities.preflight({ ...args, cwd: 'elsewhere' }, true, 'r5-run', 3), null);
 assert.equal(capabilities.preflight(args, false, 'r5-run', 3), null);
});

test('SYNTAX_OK and XVFB_OK production results survive provider formatting, persistence settlement and activity classification', async () => {
 const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
 const { classifyStep } = await import('../src/lib/executionEvents.mjs');
 const { failedToolReason } = require('../src/main/engineManager');
 for (const marker of ['SYNTAX_OK', 'XVFB_OK']) {
  const steps = []; let round = 0;
  const reply = calls => Response.json({ choices: [{ message: { content: calls ? '' : 'Done', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] });
  await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'fixture', messages: [{ role: 'system', content: 'Fixture' }, { role: 'user', content: 'Check' }],
   chatTools: agentTools.filter(t => t.function.name === 'run_tests'), resolveTool: name => ({ serverName: 'native', toolName: name }),
   failedToolReason, onExecutionSteps: current => { steps.splice(0, steps.length, ...current); },
   executeTool: input => call('run_tests', JSON.parse(input.arguments)),
   fetchImpl: async (_url, options) => {
    if (round++ === 0) return reply([{ id: marker, type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ command: `printf ${marker}` }) } }]);
    const body = JSON.parse(options.body); const result = JSON.parse(body.messages.at(-1).content);
    assert.equal(result.success, true); assert.equal(result.executionStatus, 'completed'); assert.equal(result.verificationState, 'inconclusive'); assert.equal(result.verificationStatus, 'inconclusive');
    assert.equal(failedToolReason(result, 'run_tests'), null);
    return reply(null);
   },
  });
  const step = steps.findLast(s => s.type === 'tool_call');
  assert.ok(step, 'settled activity step observed'); assert.equal(step.status, 'complete');
  assert.equal(classifyStep(step).label, 'Verification inconclusive');
  const saved = sessions.saveMessage('chat', 'assistant', 'Fixture verification', [], null, null, null, null, null, steps);
  const row = require('../src/main/db').db.prepare('SELECT execution_steps FROM messages WHERE id=?').get(saved.id ?? saved);
  const persisted = require('../src/main/executionSteps').readExecutionSteps(row).findLast(s => s.type === 'tool_call');
  assert.equal(persisted.status, 'complete'); assert.equal(classifyStep(persisted).label, 'Verification inconclusive');
 }
});

test('authoritative TAP failure, filtered results, missing display and startup outcomes remain distinct', () => {
 const tap = failed => `TAP version 13\n${failed ? 'not ok' : 'ok'} 1 - check\n1..1\n# tests 1\n# pass ${failed ? 0 : 1}\n# fail ${failed ? 1 : 0}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
 const classify = (stdout, exitCode = 0, stderr = '') => structureVerification({ command: 'node --test x.cjs | tail -100' }, { stdout, stderr, exitCode }, null, 1000, '.');
 assert.equal(classify(tap(false)).verificationState, 'passed');
 const failed = classify(tap(true)); assert.equal(failed.verificationState, 'failed'); assert.equal(failed.executionStatus, 'completed'); assert.equal(failed.exitCode, 0);
 assert.equal(classify('# pass 1').verificationState, 'inconclusive');
 const display = classify('', 1, 'Missing X server or $DISPLAY'); assert.equal(display.verificationState, 'inconclusive'); assert.equal(display.success, true);
 assert.equal(require('../src/main/engineManager').failedToolReason(display, 'run_tests'), null);
 assert.equal(structureVerification({}, { spawnError: 'ENOENT' }, null, 1000, '.').executionStatus, 'launch_failure');
});

test('three separate completed tasks use current database IDs and preserve historical revisions', async () => {
 const id = 'r5-three-tasks'; sessions.getOrCreateSession(id, 'model', project.id);
 for (const objective of ['A', 'B', 'C']) {
  const previous = plans.getPlan(id);
  const change = previous ? { action: 'update', transition: 'new_task', expected_revision: previous.revision } : { action: 'create' };
  const created = await executeAgentTool({ name: 'update_plan', arguments: JSON.stringify({ ...change, objective, steps: [{ description: objective }] }), sessionId: id, permissionMode: 'workspace_write' });
  assert.equal(created.success, true, JSON.stringify(created));
  const current = plans.getPlan(id); const state = plans.buildPlanStateSection(id);
  assert.match(state.content, new RegExp(`"id":${current.steps[0].id}`));
  assert.match(state.content, /never ordinal positions/);
  if (objective !== 'A') {
   const guessed = await executeAgentTool({ name: 'update_plan', arguments: JSON.stringify({ action: 'update', steps: [{ id: previous.steps[0].id, status: 'completed' }] }), sessionId: id, permissionMode: 'workspace_write' });
   assert.equal(guessed.code, 'UNKNOWN_STEP'); assert.equal(guessed.current_plan.steps[0].id, current.steps[0].id);
  }
  plans.updatePlan(id, { action: "update", steps: [{ id: current.steps[0].id, status: 'completed' }], expected_revision: current.revision });
 }
 const history = require('../src/main/db').db.prepare('SELECT snapshot FROM workspace_plan_history WHERE session_id=? ORDER BY revision').all(id);
 assert.equal(history.length, 5); assert.equal(JSON.parse(history[0].snapshot).objective, 'A');
});

test('execution environment refresh follows live permission revision without leaking secrets', async () => {
 const id = 'r5-mode'; sessions.getOrCreateSession(id, 'model', project.id);
 contexts.createContext(id, 'workspace_write'); const old = contexts.revision(id);
 assert.match(require('../src/main/promptBuilder').buildExecutionEnvironmentSection(id).content, /Workspace sandbox/);
 await contexts.setMode(id, 'full_access'); assert.notEqual(contexts.revision(id), old);
 const section = require('../src/main/promptBuilder').buildExecutionEnvironmentSection(id);
 assert.match(section.content, /COMMAND ENVIRONMENT] Host/); assert.doesNotMatch(section.content, /sandbox\/tmp/);
 await contexts.setMode(id, 'read_only'); assert.match(require('../src/main/promptBuilder').buildExecutionEnvironmentSection(id).content, /No executable shell/);
});


test('real stale workspace X11 socket is masked for Git, still blocks shell sandbox and never blocks Full Access', async () => {
 const net = require('node:net');
 const dir = path.join(workspace, '.llm_workspace/sandbox/tmp/.X11-unix'); fs.mkdirSync(dir, { recursive: true });
 const socket = path.join(dir, 'X77'); const server = net.createServer();
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
 try {
  const isolated = await call('git_status', {}, 'workspace_write');
  assert.ok(isolated.output, JSON.stringify(isolated));
  assert.throws(() => require('../src/main/sandboxFilesystem').resolveFilesystem({ workspace, protectGitMetadata: true }), /Sandbox socket path is not permitted/);
  const host = await call('git_status', {}); assert.ok(host.output, JSON.stringify(host));
  const shell = await call('execute_command', { command: 'printf HOST_OK' }); assert.equal(shell.stdout, 'HOST_OK');
 } finally { await new Promise(resolve => server.close(resolve)); }
});

test('explicit sandbox X11 requests are rejected through production shell and test dispatch without launch', async () => {
 for (const name of ['execute_command', 'run_tests']) {
  const out = await call(name, { command: 'printf MUST_NOT_RUN', required_capability: 'x11_display' }, 'workspace_write');
  assert.equal(out.code, 'EXECUTION_CAPABILITY_UNAVAILABLE', JSON.stringify(out));
  assert.equal(out.operation_executed, false); assert.equal(out.stdout, '');
 }
});

test('production run_tests suppresses a repeated proven display failure within the same run', async () => {
 const foreground = require('../src/main/foregroundCommand'); const original = foreground.runForeground;
 let launches = 0;
 foreground.runForeground = async () => { launches++; return { status: 'nonzero_exit', exitCode: 1, stdout: 'original evidence', stderr: 'Missing X server or $DISPLAY' }; };
 const invoke = () => require('./helpers/approvedNativeCommand.cjs')({ name: 'run_tests', arguments: JSON.stringify({ command: 'node ui-fixture.cjs' }), sessionId: 'chat', permissionMode: 'workspace_write', backgroundContext: { runId: 'r5-repeat-production' } });
 try {
  const first = await invoke(); assert.equal(first.executionStatus, 'completed', JSON.stringify(first)); assert.equal(first.verificationStatus, 'inconclusive');
  const second = await invoke(); assert.equal(second.operation_executed, false); assert.equal(second.previousEvidence.stderr, first.stderr); assert.equal(launches, 1);
 } finally { foreground.runForeground = original; }
});

test('Full Access remains subject to the signed-in user filesystem permissions', async () => {
 const file = path.join(workspace, 'os-denied.txt'); fs.writeFileSync(file, 'private fixture'); fs.chmodSync(file, 0);
 try {
  const out = await call('execute_command', { command: 'cat os-denied.txt' });
  assert.notEqual(out.exitCode, 0); assert.match(out.stderr, /Permission denied/i); assert.doesNotMatch(out.stdout, /private fixture/);
 } finally { fs.chmodSync(file, 0o600); }
});

test('provider requests refresh execution metadata after a live mode change without stale duplicate sections', async () => {
 const id = 'r5-provider-mode'; sessions.getOrCreateSession(id, 'model', project.id); contexts.createContext(id, 'workspace_write');
 const builder = require('../src/main/promptBuilder'); const { runMemoryChat } = await import('../src/lib/memoryChat.mjs'); let round = 0;
 const reply = calls => Response.json({ choices: [{ message: { content: calls ? '' : 'Done', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] });
 await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'model', messages: [{ role: 'system', content: 'Fixture' }, { role: 'user', content: 'Inspect' }],
  chatTools: agentTools.filter(t => t.function.name === 'list_directory'),
  getExecutionEnvironment: () => builder.buildExecutionEnvironmentSection(id),
  executeTool: async () => { await contexts.setMode(id, 'full_access'); return { entries: [] }; },
  fetchImpl: async (_url, options) => {
   const body = JSON.parse(options.body); const text = JSON.stringify(body.messages);
   assert.equal((text.match(/\[COMMAND ENVIRONMENT\]/g) || []).length, 1); assert.match(text, round === 0 ? /Workspace sandbox/ : /COMMAND ENVIRONMENT] Host/);
   if (round++ === 0) return reply([{ id: 'mode-inspect', type: 'function', function: { name: 'list_directory', arguments: '{}' } }]);
   return reply(null);
  },
 });
});

test('real Node runners and a masked failing pipeline retain authoritative verification through production dispatch', async () => {
 fs.writeFileSync(path.join(workspace, 'r5-pass.cjs'), "require('node:test')('passing', () => {});");
 fs.writeFileSync(path.join(workspace, 'r5-fail.cjs'), "require('node:test')('failing', () => { throw Error('expected assertion'); });");
 const saved = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
 try {
  const pass = await call('run_tests', { command: 'node --test --test-reporter=tap r5-pass.cjs' });
  assert.equal(pass.verificationStatus, 'passed', JSON.stringify(pass)); assert.equal(pass.executionStatus, 'completed');
  const fail = await call('run_tests', { command: 'node --test --test-reporter=tap r5-fail.cjs' });
  assert.equal(fail.verificationStatus, 'failed'); assert.equal(fail.executionStatus, 'completed'); assert.notEqual(fail.exitCode, 0);
  const masked = await call('run_tests', { command: 'node --test --test-reporter=tap r5-fail.cjs | tail -100' });
  assert.equal(masked.exitCode, 0); assert.equal(masked.verificationStatus, 'failed'); assert.match(masked.stdout, /expected assertion/);
 } finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; }
});
