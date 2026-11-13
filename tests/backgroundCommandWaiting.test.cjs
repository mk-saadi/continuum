'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'command-waiting-'));
const load = Module._load;
Module._load = function(name, ...args) {
  return name === 'electron' ? { app: { isReady: () => true, getPath: () => temporary } } : load.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase(temporary);
const manager = require('../src/main/backgroundCommands');
const project = require('../src/main/projectManager').createProject({ name: 'Waiting', root_path: temporary });
const contexts = require('../src/main/lspExecutionContext');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let serial = 0;
function fixture() {
  const sessionId = `waiting-${++serial}`;
  require('../src/main/sessionManager').getOrCreateSession(sessionId, 'fixture', project.id);
  const controller = new AbortController();
  const context = { sessionId, runId: sessionId, workspace: temporary };
  manager.openRun({ ...context, signal: controller.signal });
  return { context, controller };
}
function command(f, persistent = false) {
  let release;
  const done = new Promise(resolve => { release = resolve; });
  const r = manager.start(f.context, 'controlled finite task', 3600000, signal => new Promise(resolve => {
    const aborted = () => resolve({ status: 'cancelled', exitCode: null });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    done.then(result => { signal.removeEventListener('abort', aborted); resolve(result); });
  }), () => {}, persistent);
  return { id: r.command_id, release };
}
test.after(async () => {
  await manager.shutdown(); database.closeDatabase(); Module._load = load;
  fs.rmSync(temporary, { recursive: true, force: true });
});
for (const [status, exitCode] of [['completed', 0], ['nonzero_exit', 7], ['timed_out', null]]) {
  test(`sleep makes no inference requests; ${status} wakes original conversation exactly once`, { timeout: 3000 }, async () => {
    const f = fixture(); const c = command(f);
    const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
    let requests = 0, sleeps = 0, delivered = 0;
    const transcript = [];
    const run = runMemoryChat({
      modelId: 'fixture', baseUrl: 'http://fixture.invalid', messages: [{ role: 'system', content: 'Fixture' }, { role: 'user', content: 'Finish the task' }],
      chatTools: [], memoryTools: [], signal: f.controller.signal,
      waitForCommands: signal => manager.wait(f.context, signal),
      onCommandWaiting: waiting => { if (waiting) sleeps++; },
      takeCommandCompletions: () => manager.take(f.context),
      markCommandCompletions: (ids, accepted) => { if (accepted) delivered += ids.length; manager.acknowledge(f.context, ids, accepted); },
      fetchImpl: async (_url, request) => {
        const messages = JSON.parse(request.body).messages; transcript.push(messages); requests++;
        const content = requests === 1 ? 'Waiting for the existing command.' : 'Inspected command result and continued.';
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    for (let i = 0; i < 100 && sleeps === 0; i++) await delay(5);
    assert.equal(requests, 1); await delay(25); assert.equal(requests, 1);
    c.release({ status, exitCode, stdout: 'terminal result' });
    await run;
    assert.equal(requests, 2); assert.equal(delivered, 1);
    assert.ok(transcript[1].some(m => String(m.content).includes(`"status":"${status}"`)));
    assert.equal(manager.status(c.id, f.context).notification_state, 'delivered');
    await manager.closeRun(f.context, { normalCompletion: true });
  });
}
test('completion-before-sleep, independent commands, cancellation and steering wake do not lose events or listeners', async () => {
  const f = fixture(); const c = command(f);
  const base = manager.events.listenerCount('change');
  let woke = false;
  const sleeping = manager.wait(f.context, f.controller.signal).then(value => { woke = true; return value; });
  await delay(10); assert.equal(woke, false);
  manager.wake('other-run'); await delay(5); assert.equal(woke, false);
  manager.wake(f.context.runId); assert.equal(await sleeping, true);
  assert.equal(manager.events.listenerCount('change'), base);
  c.release({ status: 'completed', exitCode: 0 });
  for (let i = 0; i < 100 && manager.status(c.id, f.context).notification_state !== 'queued'; i++) await delay(5);
  assert.equal(await manager.wait(f.context, f.controller.signal), true);
  const events = manager.take(f.context); manager.acknowledge(f.context, events.map(e => e.id), true);
  assert.equal(await manager.wait(f.context, f.controller.signal), false);
  const second = command(f);
  const aborted = manager.wait(f.context, f.controller.signal);
  f.controller.abort(new Error('user stopped'));
  await assert.rejects(aborted, /user stopped/);
  assert.equal(manager.events.listenerCount('change'), base);
  second.release({ status: 'completed', exitCode: 0 });
  await manager.closeRun(f.context);
});
test('persistent servers do not keep the agent asleep; quick foreground results are consumed without a second notification', async () => {
  const f = fixture(); const server = command(f, true);
  assert.equal(await manager.wait(f.context, f.controller.signal), false);
  server.release({ status: 'completed', exitCode: 0 });
  await manager.foregroundResult(server.id, f.context, 100);
  const c = command(f);
  const yielded = await manager.foregroundResult(c.id, f.context, 5);
  assert.equal(yielded.command_id, c.id); assert.equal(yielded.background, true);
  c.release({ status: 'completed', exitCode: 0 });
  const complete = await manager.foregroundResult(c.id, f.context, 100);
  assert.equal(complete.background, false); assert.equal(complete.exitCode, 0);
  assert.deepEqual(manager.take(f.context), []);
  await manager.closeRun(f.context, { normalCompletion: true });
});
test('real main workspace dispatch yields the SAME process and retains a one-hour default', { timeout: 16000 }, async () => {
  const f = fixture();
  const executionContext = contexts.createContext(f.context.sessionId, 'full_access', f.context.runId);
  const invoke = require('./helpers/approvedNativeCommand.cjs');
  const started = await invoke({ name: 'execute_command', arguments: { command: `${JSON.stringify(process.execPath)} -e 'setTimeout(()=>{console.log("LONG_DONE")},10500)'` }, sessionId: f.context.sessionId, permissionMode: 'full_access', signal: f.controller.signal, executionContext, backgroundContext: f.context });
  assert.equal(started.background, true); assert.match(started.command_id, /^cmd_/);
  assert.equal(started.timeout_ms, 3600000);
  await manager.wait(f.context, f.controller.signal);
  const result = manager.status(started.command_id, f.context);
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /LONG_DONE/);
  await manager.closeRun(f.context, { normalCompletion: true });
});
