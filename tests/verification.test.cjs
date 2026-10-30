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

test('a successful probe completes with inconclusive verification and exit code 0', async () => {
  const result = await run({ command: 'printf all-good' });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /all-good/);
  assert.equal(result.command, 'printf all-good');
  assert.ok(Number.isSafeInteger(result.recoveryCheckpointId), 'shell recovery boundary still runs');
});

test('a failing command returns failed with its exit code and diagnostics', async () => {
  const result = await run({ command: "printf 'boom-detail\\n' >&2; exit 3" });
  assert.equal(result.status, 'failed');
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /boom-detail/);
  assert.match(result.reason, /exit(?:ed with status)? 3/);
  assert.match(result.failure_excerpt, /boom-detail/);
});

test('a command exceeding its timeout returns timed_out', async () => {
  const result = await run({ command: 'sleep 5', timeout_ms: 1000 });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.success, false);
  assert.match(result.reason, /timed out/i);
});

test('a cancelled command is reported as cancelled', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  try {
    const result = await run({ command: 'sleep 10' }, { signal: controller.signal });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.success, false);
    assert.match(result.reason, /cancelled/i);
  } finally {
    clearTimeout(timer);
  }
});

test('a missing command returns error, never passed', async () => {
  const result = await run({ command: 'definitely-not-a-real-command-xyz-123' });
  assert.equal(result.status, 'error');
  assert.equal(result.success, false);
  assert.notEqual(result.status, 'passed');
  assert.match(result.reason, /not found|could not run/i);
});

test('large output is bounded while the useful failure tail survives', async () => {
  const result = await run({
    command:
      "i=0; while [ $i -lt 400 ]; do printf 'PADDING-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; i=$((i+1)); done; echo TAIL_MARKER; exit 1",
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.stdout.length <= 4100, `stdout bounded: ${result.stdout.length}`);
  assert.ok(result.stdout.includes('TAIL_MARKER'), 'the failure tail is retained');
  assert.match(result.failure_excerpt, /TAIL_MARKER/);
});

test('invalid timeout is rejected instead of running', async () => {
  const result = await run({ command: 'echo unused', timeout_ms: 10 });
  assert.equal(result.success, false);
  assert.match(result.error, /timeout_ms/);
});

test('the classifier never infers success from an unknown result', () => {
  const args = { command: 'check' };
  assert.equal(structureVerification(args, {}, null, 45000, '.').status, 'error');
  assert.equal(structureVerification(args, { stdout: '', stderr: '' }, null, 45000, '.').status, 'error');
  assert.equal(structureVerification(args, { exitCode: 0 }, null, 45000, '.').status, 'inconclusive');
  assert.equal(structureVerification(args, { exitCode: 1 }, null, 45000, '.').status, 'failed');
  assert.equal(structureVerification(args, { exitCode: 1, timedOut: true }, null, 45000, '.').status, 'timed_out');
  assert.equal(structureVerification(args, { exitCode: 1, cancelled: true }, null, 45000, '.').status, 'cancelled');
  assert.equal(structureVerification(args, { exitCode: 1, spawnError: 'ENOENT' }, null, 45000, '.').status, 'error');
  // A read-only containment failure only becomes passed via a real zero exit.
  assert.notEqual(structureVerification(args, { cancelled: true, exitCode: 0 }, null, 45000, '.').status, 'passed');
});

test('permission restrictions and workspace boundaries stay enforced', async () => {
  assert.equal(capabilityOf('run_tests'), CAPABILITIES.LOCAL_EXECUTION);
  const projectShape = { root_path: workspace };
  assert.equal(isToolVisible('run_tests', { permissionMode: 'read_only', project: projectShape }), false);
  assert.equal(isToolVisible('run_tests', { permissionMode: 'workspace_write', project: projectShape }), true);
  assert.equal(isToolVisible('run_tests', { permissionMode: 'full_access', project: projectShape }), true);
  await assert.rejects(guardTool({ name: 'run_tests', permissionMode: 'read_only' }), /Read Only/);

  // A cwd escaping the workspace is denied in workspace_write, exactly like
  // execute_command.
  const escape = await executeAgentTool({
    name: 'run_tests', arguments: JSON.stringify({ command: 'true', cwd: '..' }),
    sessionId: 'chat', permissionMode: 'workspace_write',
  });
  assert.equal(escape.success, false);
  assert.match(escape.error, /escapes the project root/);

  // System-affecting commands are not silently allowed: the model cannot grant
  // its own approval.
  const systemAffecting = await executeAgentTool({
    name: 'run_tests', arguments: JSON.stringify({ command: 'sudo true' }),
    sessionId: 'chat', permissionMode: 'workspace_write',
  });
  assert.equal(systemAffecting.success, false);
  assert.match(systemAffecting.error, /approval denied/i);

  // Casual chats (no workspace) go through the same explicit approval prompt.
  let prompted = false;
  await assert.rejects(
    guardTool({
      name: 'run_tests', args: { command: 'echo hi' }, permissionMode: 'ask_approval',
      requestApproval: async () => { prompted = true; return false; },
    }),
    /approval denied/,
  );
  assert.equal(prompted, true);
});

test('existing tool registration and command execution keep working', async () => {
  const names = agentTools.map((tool) => tool.function.name);
  assert.ok(names.includes('run_tests'));
  assert.ok(names.includes('execute_command'));
  const schema = agentTools.find((tool) => tool.function.name === 'run_tests').function.parameters;
  assert.deepEqual(schema.required, ['command']);
  assert.equal(schema.additionalProperties, false);

  const { getToolContext } = require('../src/main/promptBuilder');
  const advertised = getToolContext([], false, 'chat').tools.map((tool) => tool.function.name);
  assert.ok(advertised.includes('run_tests'));
  assert.ok(advertised.includes('execute_command'));

  // execute_command preserves legacy streams and exitCode alongside its additive
  // execution status; run_tests retains its separate verification verdict.
  const legacy = await require('./helpers/approvedNativeCommand.cjs')({
    name: 'execute_command', arguments: JSON.stringify({ command: 'printf legacy; exit 4' }),
    sessionId: 'chat', permissionMode: 'full_access',
  });
  assert.equal(legacy.exitCode, 4);
  assert.match(legacy.stdout, /legacy/);
  assert.equal(legacy.status, 'nonzero_exit');
});

test('R4 masked TAP failure and excerpt cannot become verified success', () => {
 const tap = 'TAP version 13\nnot ok 1 - broken\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
 const args = { command: 'node --test broken.cjs | tail -30' };
 const failed = structureVerification(args, { exitCode: 0, stdout: tap }, null, 1000, '.');
 assert.equal(failed.status, 'failed'); assert.equal(failed.success, false); assert.equal(failed.exitCode, 0);
 assert.match(failed.reason, /masked/);
 assert.equal(structureVerification(args, { exitCode: 0, stdout: '# pass 1' }, null, 1000, '.').status, 'inconclusive');
 const startup = structureVerification({ command: '. "$NVM_DIR/nvm.sh" && node --test' }, { exitCode: 2, stderr: '/bin/sh: 1: .: cannot open /sandbox-home/.nvm/nvm.sh: No such file' }, null, 1000, '.');
 assert.equal(startup.verificationState, 'execution_error');
});

test('R4 runner startup errors remain execution errors rather than assertion failures', () => {
 for (const stderr of ['node: bad option: --not-real', 'npm error Missing script: "test"', 'bwrap: namespace setup failed', '/bin/sh: 1: Syntax error: "(" unexpected']) {
  const result = structureVerification({ command: 'node --test' }, { exitCode: 2, stderr }, null, 1000, '.');
  assert.equal(result.verificationState, 'execution_error'); assert.equal(result.success, false);
  assert.match(result.reason, /could not run/);
 }
});
