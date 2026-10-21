'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-background-'));
const workspace = path.join(temporary, 'workspace'); fs.mkdirSync(workspace);
const originalLoad = Module._load;
Module._load = function(name, ...rest) { return name === 'electron' ? { app: { isReady: () => true, getPath: () => temporary } } : originalLoad.call(this, name, ...rest); };
const database = require('../src/main/db'); database.initDatabase(temporary);
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const manager = require('../src/main/backgroundCommands');
const contexts = require('../src/main/lspExecutionContext');
const project = require('../src/main/projectManager').createProject({ name: 'Background', root_path: workspace });
const session = id => require('../src/main/sessionManager').getOrCreateSession(id, 'fixture', project.id);
let counter = 0;
const fixtureContexts = [];
const node = source => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
const sandboxAvailable = process.platform === 'linux' && require('node:child_process').spawnSync('bwrap', ['--ro-bind','/','/','--unshare-user','--unshare-pid','--proc','/proc','/bin/sh','-c','true']).status === 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(mode = 'full_access', workspaceRoot = workspace, workspaceProject = project) {
  const sessionId = `background-${++counter}`; require('../src/main/sessionManager').getOrCreateSession(sessionId, 'fixture', workspaceProject.id);
  const controller = new AbortController(); const runId = `run-${counter}`;
  const executionContext = contexts.createContext(sessionId, mode, runId);
  const context = { runId, sessionId, workspace: workspaceRoot };
  manager.openRun({ ...context, signal: controller.signal });
  fixtureContexts.push(context);
  const dispatch = (name, args) => executeAgentTool({ name, arguments: JSON.stringify(args), sessionId, permissionMode: mode, signal: controller.signal, executionContext, backgroundContext: context });
  return { context, controller, dispatch };
}
async function terminal(id, context) {
  for (let i = 0; i < 300; i++) { const r = manager.status(id, context); if (!['running', 'starting'].includes(r.status)) return r; await delay(10); }
  throw new Error('Command failed to settle');
}
test.afterEach(async () => { for (const context of fixtureContexts.splice(0)) await manager.closeRun(context); });
test.after(async () => { await manager.shutdown(); database.closeDatabase(); Module._load = originalLoad; fs.rmSync(temporary, { recursive: true, force: true }); });

test('schemas and strict argument validation preserve foreground bounds', async () => {
  for (const name of ['get_command_status', 'stop_background_command']) assert.deepEqual(agentTools.find(t => t.function.name === name).function.parameters.required, ['command_id']);
  const fixture = setup();
  for (const args of [{ background: 'yes' }, { background_lifetime_ms: 1000 }, { background: true, background_lifetime_ms: 1800001 }, { background: true, background_lifetime_ms: 1000, timeout_ms: 1000 }]) {
    assert.equal((await fixture.dispatch('execute_command', { command: 'echo forbidden', ...args })).success, false);
  }
  assert.equal((await fixture.dispatch('execute_command', { command: 'printf foreground', background: false })).status, 'completed');
  await manager.closeRun(fixture.context);
});
test('real dispatcher returns promptly, captures running output, finite success/nonzero and exactly-once events', async () => {
  const f = setup(); const started = performance.now();
  const a = await f.dispatch('execute_command', { command: node("require('fs').writeSync(1,'START');setTimeout(()=>require('fs').writeSync(1,'DONE'),250)"), background: true });
  assert.match(a.command_id, /^cmd_/); assert.equal(a.exitCode, null); assert.ok(performance.now() - started < 200);
  assert.ok(['starting', 'running'].includes(a.status));
  await delay(150);
  const running = await f.dispatch('get_command_status', { command_id: a.command_id });
  assert.equal(running.status, 'running'); assert.match(running.stdout, /START/); assert.equal(running.process_id, undefined);
  const b = await f.dispatch('execute_command', { command: 'printf failure >&2; exit 7', background: true });
  const [ra, rb] = await Promise.all([terminal(a.command_id, f.context), terminal(b.command_id, f.context)]);
  assert.equal(ra.status, 'completed'); assert.equal(ra.exitCode, 0); assert.match(ra.stdout, /DONE/);
  assert.equal(rb.status, 'nonzero_exit'); assert.equal(rb.exitCode, 7);
  const events = manager.take(f.context); assert.equal(events.length, 2); assert.deepEqual(manager.take(f.context), []);
  manager.acknowledge(f.context, events.map(e => e.id), true);
  assert.equal(manager.status(a.command_id, f.context).notification_state, 'delivered');
  assert.equal((await f.dispatch('stop_background_command', { command_id: a.command_id })).status, 'completed');
  await manager.closeRun(f.context);
});
test('bounded concurrency, cross-chat/workspace rejection, idempotent stop and sibling isolation', async () => {
  const a = setup(), b = setup(), c = setup();
  const start = f => f.dispatch('execute_command', { command: node('setInterval(()=>{},100)'), background: true, background_lifetime_ms: 1800000 });
  const r1 = await start(a), r2 = await start(a), r3 = await start(b), r4 = await start(b);
  assert.equal((await start(a)).success, false);
  assert.equal((await start(c)).success, false);
  assert.equal((await b.dispatch('get_command_status', { command_id: r1.command_id })).success, false);
  assert.throws(() => manager.status(r1.command_id, { ...a.context, workspace: temporary }), /ownership/);
  assert.throws(() => manager.status('bad', a.context), /not found/);
  const stops = await Promise.all([a.dispatch('stop_background_command', { command_id: r1.command_id }), a.dispatch('stop_background_command', { command_id: r1.command_id })]);
  assert.ok(stops.every(r => r.status === 'cancelled'));
  assert.ok(['starting', 'running'].includes(manager.status(r3.command_id, b.context).status));
  a.controller.abort(); await terminal(r2.command_id, a.context);
  assert.ok(['starting', 'running'].includes(manager.status(r4.command_id, b.context).status));
  await manager.closeRun(a.context); await manager.closeRun(b.context); await manager.closeRun(c.context);
});
test('timeout, large output tails, revocation and run-end undelivered history', async () => {
  const f = setup();
  const timeout = await f.dispatch('execute_command', { command: node('setInterval(()=>{},100)'), background: true, timeout_ms: 1000 });
  assert.equal((await terminal(timeout.command_id, f.context)).status, 'timed_out');
  const large = await f.dispatch('execute_command', { command: node("require('fs').writeSync(1,'a'.repeat(100000)+'TAIL');require('fs').writeSync(2,'b'.repeat(100000)+'ERROR_TAIL')"), background: true });
  const output = await terminal(large.command_id, f.context);
  assert.ok(output.output_truncated); assert.ok(output.stdout.length < 16500); assert.match(output.stderr, /ERROR_TAIL$/);
  const revoke = await f.dispatch('execute_command', { command: node('setInterval(()=>{},100)'), background: true });
  await delay(50); await contexts.setMode(f.context.sessionId, 'read_only');
  assert.equal((await terminal(revoke.command_id, f.context)).status, 'cancelled');
  assert.equal((await f.dispatch('execute_command', { command: 'echo deny', background: true })).success, false);
  await manager.closeRun(f.context);
  const history = manager.list(f.context.sessionId, workspace);
  assert.ok(history.every(r => r.notification_state === 'undelivered'));
  const later = setup();
  assert.deepEqual(manager.take(later.context), []); await manager.closeRun(later.context);
});
test('read-only denial and required ask approval preserved; child allowlist has no command handles', async () => {
  for (const mode of ['read_only', 'ask_approval']) {
    const f = setup(mode);
    assert.equal((await f.dispatch('execute_command', { command: mode === 'ask_approval' ? 'sudo echo denied' : 'echo denied', background: true })).success, false);
    await manager.closeRun(f.context);
  }
  const child = fs.readFileSync(path.join(__dirname, '../src/main/subagents/agentLoop.js'), 'utf8');
  const begin = child.indexOf('const CHILD_TOOL_NAMES');
  assert.ok(begin > 0);
  const allowlist = child.slice(begin, child.indexOf(']);', begin));
  assert.ok(!allowlist.includes('get_command_status')); assert.ok(!allowlist.includes('stop_background_command'));
});

for (const cloud of [false, true]) for (const fail of [false, true]) test(`real model loop automatic completion, same run, steering, plan; cloud=${cloud} fail=${fail}`, { skip: !cloud && !sandboxAvailable ? 'Host denies bwrap namespaces; Workspace Write needs Linux user namespaces' : false }, async () => {
  const f = setup(cloud ? 'full_access' : 'workspace_write');
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const plans = require('../src/main/workspacePlan');
  const created = await f.dispatch('update_plan', { action: 'create', objective: 'Build and inspect', steps: [{ description: 'Run build', status: 'in_progress' }] });
  assert.equal(created.success, true);
  const originalPlan = plans.getPlan(f.context.sessionId);
  let observedSteps = [];
  let round = 0, commandId, usefulBeforeCompletion = false, delivered = 0, steeringDelivered = 0;
  const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  const call = (id, name, args) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  let steering = true;
  await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'fixture', cloud,
    messages: [{ role: 'system', content: 'Fixture' }, { role: 'user', content: 'Build while inspecting source.' }], chatTools: agentTools, memoryTools: [],
    onExecutionSteps: steps => { observedSteps = steps; },
    takeCommandCompletions: () => manager.take(f.context),
    markCommandCompletions: (ids, ok) => { if (ok) delivered += ids.length; manager.acknowledge(f.context, ids, ok); },
    takeSteeringInstructions: () => { if (round >= 2 && steering) { steering = false; return [{ id: 'steer', content: 'KEEP_PLAN' }]; } return []; },
    markSteeringDelivered: ids => { steeringDelivered += ids.length; },
    fetchImpl: async (_url, request) => {
      const messages = JSON.parse(request.body).messages;
      const index = round++;
      if (index === 0) return sse({ tool_calls: [call('start', 'execute_command', { command: node(`setTimeout(()=>{require('fs').writeSync(1,'BUILD_RESULT');process.exit(${fail ? 8 : 0})},350)`), background: true })] });
      if (index === 1) {
        assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === 'start' && m.content.includes(commandId)));
        return sse({ tool_calls: [call('independent', 'list_directory', { path: '.' })] });
      }
      assert.ok(messages.some(m => m.role === 'user' && String(m.content).includes('Runtime background command events')));
      assert.ok(messages.some(m => m.role === 'user' && String(m.content).includes('KEEP_PLAN')));
      assert.ok(messages.some(m => String(m.content).includes(`"exitCode":${fail ? 8 : 0}`)));
      return sse({ content: 'Result inspected in the original run.' });
    },
    executeTool: async call => {
      const r = await f.dispatch(call.name, JSON.parse(call.arguments));
      if (call.name === 'execute_command') commandId = r.command_id;
      else {
        usefulBeforeCompletion = ['starting', 'running'].includes(manager.status(commandId, f.context).status);
        assert.ok(r); await terminal(commandId, f.context); // independent operation's completion checkpoint, no model polling
      }
      return r;
    },
  });
  assert.deepEqual(plans.getPlan(f.context.sessionId), originalPlan);
  assert.ok(usefulBeforeCompletion); assert.equal(round, 3); assert.equal(delivered, 1); assert.equal(steeringDelivered, 1);
  assert.equal(manager.status(commandId, f.context).run_id, f.context.runId);
  assert.equal(manager.status(commandId, f.context).notification_state, 'delivered');
  assert.match(manager.status(commandId, f.context).stdout, /BUILD_RESULT/);
  const completedStep = observedSteps.find(step => step.result?.command_id === commandId);
  assert.equal(completedStep.result.exitCode, fail ? 8 : 0);
  assert.equal(completedStep.status, fail ? 'error' : 'complete');
  const digest = require('../src/main/turnDigest').buildTurnDigest(observedSteps, { turnSeq: 1 });
  assert.ok(JSON.stringify(digest).includes('BUILD_RESULT') || JSON.stringify(digest).includes('exit'));

  await manager.closeRun(f.context);
});
test('completion during final response causes a bounded safe continuation', async () => {
  const f = setup(); const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const started = await f.dispatch('execute_command', { command: node('setTimeout(()=>{},100)'), background: true });
  let requests = 0, queuedSteering = true;
  await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'fixture', messages: [{ role: 'system', content: 'Fixture' }],
    takeCommandCompletions: () => manager.take(f.context), markCommandCompletions: (ids, ok) => manager.acknowledge(f.context, ids, ok),
    takeSteeringInstructions: () => requests && queuedSteering ? (queuedSteering = false, [{ id: 'final-steer', content: 'FINAL_STEERING' }]) : [],
    fetchImpl: async (_url, request) => {
      requests++;
      if (requests === 1) await terminal(started.command_id, f.context);
      else {
        assert.match(request.body, /Runtime background command events/);
        const rows = JSON.parse(request.body).messages;
        const steerIndex = rows.findIndex(m => String(m.content).includes('FINAL_STEERING'));
        assert.ok(steerIndex >= 0 && steerIndex < rows.findIndex(m => String(m.content).includes('Runtime background command events')));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    }, executeTool: async () => { throw new Error('No polling'); },
  });
  assert.equal(requests, 2); await manager.closeRun(f.context);
});
test('queued authorization revalidation prevents spawn after downgrade; persistence failures are fail closed', async () => {
  const f = setup(); let invoked = false;
  const revision = contexts.revision(f.context.sessionId);
  const validate = () => { if (contexts.revision(f.context.sessionId) !== revision) throw new Error('revoked'); };
  const r = manager.start(f.context, 'controlled preparation', 1000, async signal => {
    await delay(80); validate(); invoked = true;
    return { status: 'completed', exitCode: 0 };
  }, validate);
  await contexts.setMode(f.context.sessionId, 'read_only');
  const ended = await terminal(r.command_id, f.context);
  assert.equal(invoked, false); assert.equal(ended.status, 'cancelled');
  const db = database.db;
  database.initDatabase(temporary).exec('ALTER TABLE background_commands RENAME TO background_commands_unavailable');
  try {
    assert.throws(() => manager.start(f.context, 'must not start', 1000, () => { invoked = true; }, () => {}), /persistence failed/);
    assert.equal(invoked, false);
  } finally { database.initDatabase(temporary).exec('ALTER TABLE background_commands_unavailable RENAME TO background_commands'); }
  await manager.closeRun(f.context);
});
test('completion persistence failure retains truthful in-memory outcome; queue capacity is bounded', async () => {
  const f = setup(); const db = database.db;
  let release;
  const r = manager.start(f.context, 'persistence fixture', 1000, () => new Promise(resolve => { release = resolve; }), () => {});
  await delay(0);
  database.initDatabase(temporary).exec('ALTER TABLE background_commands RENAME TO background_commands_unavailable');
  try {
    release({ status: 'nonzero_exit', exitCode: 6, stderr: 'expected failure' });
    const ended = await terminal(r.command_id, f.context);
    assert.equal(ended.status, 'nonzero_exit'); assert.match(ended.persistence_error, /persistence failed/);
    const batch = manager.take(f.context); assert.equal(batch.length, 0);
    assert.equal(manager.status(r.command_id, f.context).notification_state, 'queued');
    assert.match(manager.status(r.command_id, f.context).persistence_error, /persistence failed/);
  } finally { database.initDatabase(temporary).exec('ALTER TABLE background_commands_unavailable RENAME TO background_commands'); }
  await manager.closeRun(f.context);
  const cap = setup();
  for (let i = 0; i < 32; i++) {
    const r = manager.start(cap.context, 'bounded queue', 1000, async () => ({ status: 'completed', exitCode: 0 }), () => {});
    await terminal(r.command_id, cap.context);
  }
  assert.throws(() => manager.start(cap.context, 'overflow', 1000, async () => ({}), () => {}), /capacity/);
  const batch = manager.take(cap.context); assert.equal(batch.length, 4);
  manager.acknowledge(cap.context, batch.map(e => e.id), false);
  await manager.closeRun(cap.context);
});
test('real dev-server-like descendant is stopped and no late writer survives', async () => {
  const f = setup(); const pidFile = path.join(workspace, 'owned-pid');
  const r = await f.dispatch('execute_command', { command: node(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('fs').writeSync(1,'Local: http://localhost:5173');process.on('SIGTERM',()=>{});setInterval(()=>{},100)`), background: true, background_lifetime_ms: 1800000 });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await delay(10);
  assert.ok(fs.existsSync(pidFile));
  assert.equal(manager.status(r.command_id, f.context).status, 'running');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const started = performance.now(); await f.dispatch('stop_background_command', { command_id: r.command_id });
  const cleanup_ms = performance.now() - started;
  if (process.platform === 'linux') {
    let executing = false;
    try { executing = !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch {}
    assert.equal(executing, false);
  }
  console.log('BACKGROUND_CLEANUP_MEASUREMENT', JSON.stringify({ cleanup_ms }));
  await manager.closeRun(f.context);
});
test('notification context survives recovery and rejected transport is not delivered', async () => {
  const f = setup(); const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const r = await f.dispatch('execute_command', { command: 'printf compact', background: true });
  await terminal(r.command_id, f.context);
  let recovered = false;
  await assert.rejects(runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'fixture', messages: [{ role: 'system', content: 'Original' }],
    takeCommandCompletions: () => manager.take(f.context), markCommandCompletions: (ids, ok) => manager.acknowledge(f.context, ids, ok),
    recoverContext: async () => ({ messages: [{ role: 'system', content: 'Recovered compact prefix' }] }),
    fetchImpl: async (_url, request) => {
      const rebuilt = await request.contextRecovery({ contextWindowLimit: 4096 });
      assert.ok(rebuilt.messages.some(m => String(m.content).includes(r.command_id)));
      recovered = true;
      return new Response('rejected', { status: 503 });
    }, executeTool: async () => {},
  }), /503/);
  assert.ok(recovered); assert.equal(manager.status(r.command_id, f.context).notification_state, 'undelivered');
  await manager.closeRun(f.context);
});
test('measure startup, retrieval, buffers, notification size and concurrent memory', async () => {
  const f = setup(); const before = process.memoryUsage().rss;
  const started = performance.now(); let startup_ms = null, completedAt = null;
  const listener = record => {
    if (record.run_id !== f.context.runId) return;
    if (record.status === 'running' && startup_ms === null) startup_ms = performance.now() - started;
    if (record.notification_state === 'queued' && completedAt === null) completedAt = performance.now();
  };
  manager.events.on('change', listener);
  const r = await f.dispatch('execute_command', { command: node("require('fs').writeSync(1,'RSS:'+process.memoryUsage().rss);setTimeout(()=>require('fs').writeSync(1,'MEASURED'),100)"), background: true });
  const response_ms = performance.now() - started;
  const second = await f.dispatch('execute_command', { command: node("require('fs').writeSync(1,'RSS:'+process.memoryUsage().rss);setTimeout(()=>{},100)"), background: true });
  const startedStatus = performance.now(); manager.status(r.command_id, f.context); const status_ms = performance.now() - startedStatus;
  const outcomes = await Promise.all([terminal(r.command_id, f.context), terminal(second.command_id, f.context)]);
  const child_rss_samples_bytes = outcomes.map(r => Number(/RSS:(\d+)/.exec(r.stdout)[1]));
  const ended = performance.now(); const batch = manager.take(f.context); manager.acknowledge(f.context, batch.map(e => e.id), true);
  console.log('BACKGROUND_MEASUREMENTS', JSON.stringify({ response_ms, startup_ms, status_ms, child_rss_samples_bytes, completion_to_ack_ms: performance.now() - completedAt, checkpoint_delivery_ms: performance.now() - ended, concurrent_parent_rss_delta_bytes: process.memoryUsage().rss - before,
    stream_limit_characters: require('../src/main/foregroundCommand').STREAM_LIMIT,
    notification_bytes: Buffer.byteLength(batch[0].content), schema_bytes: Buffer.byteLength(JSON.stringify(agentTools.filter(t => ['execute_command','get_command_status','stop_background_command'].includes(t.function.name)))) }));
  manager.events.removeListener('change', listener);
  await manager.closeRun(f.context);
});
test('different real workspaces cannot retrieve output or receive each other’s notifications', async () => {
  const otherRoot = path.join(temporary, 'other-workspace'); fs.mkdirSync(otherRoot);
  const otherProject = require('../src/main/projectManager').createProject({ name: 'Other workspace', root_path: otherRoot });
  const a = setup(), b = setup('full_access', otherRoot, otherProject);
  const ra = await a.dispatch('execute_command', { command: 'printf PRIVATE_A', background: true });
  const rb = await b.dispatch('execute_command', { command: 'printf PRIVATE_B', background: true });
  await Promise.all([terminal(ra.command_id, a.context), terminal(rb.command_id, b.context)]);
  assert.equal((await b.dispatch('get_command_status', { command_id: ra.command_id })).success, false);
  assert.equal((await a.dispatch('stop_background_command', { command_id: rb.command_id })).success, false);
  assert.deepEqual(manager.take(a.context).map(event => event.id), [ra.command_id]);
  assert.deepEqual(manager.take(b.context).map(event => event.id), [rb.command_id]);
  await manager.closeRun(a.context); await manager.closeRun(b.context);
});
test('shared executor settles a pipe capture failure without crashing or fabricating success', async () => {
  const vm = require('node:vm'); const { EventEmitter } = require('node:events');
  const child = new EventEmitter(); child.pid = 123;
  for (const stream of ['stdout', 'stderr']) { child[stream] = new EventEmitter(); child[stream].setEncoding = () => {}; child[stream].destroy = () => {}; }
  const fixtureModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/foregroundCommand.js'), 'utf8'), {
    module: fixtureModule, require: name => { assert.equal(name, 'node:child_process'); return { spawn: () => { setImmediate(() => child.stdout.emit('error', new Error('controlled broken pipe'))); return child; } }; },
    performance, setTimeout, clearTimeout,
    process: { platform: 'linux', kill: () => { setImmediate(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close'); }); } },
  });
  const result = await fixtureModule.exports.runForeground('fixture', [], { timeoutMs: 1000 });
  assert.equal(result.status, 'output_capture_failed'); assert.equal(result.exitCode, null); assert.match(result.stderr, /controlled broken pipe/);
});
test('shutdown awaits all owned background process cleanup', async () => {
  const a = setup(), b = setup();
  await a.dispatch('execute_command', { command: node('setInterval(()=>{},100)'), background: true });
  await b.dispatch('execute_command', { command: node('setInterval(()=>{},100)'), background: true });
  await delay(60);
  await Promise.all([manager.shutdown(), manager.closeRun(a.context), manager.closeRun(a.context)]);
  for (const f of [a, b]) assert.ok(manager.list(f.context.sessionId, workspace).every(r => r.status === 'cancelled' && r.notification_state === 'undelivered'));
});
test('restart reconciles stale running and ambiguous transport claims without restarting', () => {
  const db = database.db;
  const record = { command_id: 'stale', session_id: 'old', workspace, run_id: 'old-run', status: 'running', notification_state: 'included' };
  db.prepare('INSERT INTO background_commands VALUES (?, ?, ?, ?)').run('stale', 'old', workspace, JSON.stringify(record));
  manager.restore(db);
  const [r] = manager.list('old', workspace);
  assert.equal(r.status, 'cancelled'); assert.equal(r.exitCode, null); assert.equal(r.notification_state, 'ambiguous');
});
