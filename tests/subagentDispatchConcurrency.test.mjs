// Sub-agent execution concurrency regression tests.
//
// The reported bug: a parent that requested eight cloud sub-agents "in
// parallel" watched them execute one after another. These tests pin down every
// layer of that path with mocked providers, controlled delays, and start/end
// timestamps — so they prove *overlap*, not merely completion:
//
//   A. two independent cloud sub-agent jobs overlap;
//   B. four (and eight) independent cloud jobs dispatch without waiting for
//      the previous one to finish — at the runtime level (B) and through the
//      parent's tool-batch dispatch (B2, the actual serialization point);
//   C. a local provider with one physical inference slot stays sequential —
//      even when the dispatch in front of it is concurrent (C, C2);
//   D. a busy local lane never blocks a cloud lane (and vice versa);
//   E. cancellation and interruption still work (queued dequeue, background
//      cancel, interrupt + resume of a running cloud child);
//   F. concurrent children keep isolated sessions, results, and records;
//   G. a non-sub-agent tool inside a batch stays a barrier: it waits for
//      earlier sub-agents, later sub-agents wait for it, and every result
//      settles in the original call order.
//
// The scheduler's per-provider/model lanes, the child-session lifecycle, and
// the transports are all mocked/observed from the outside: no test reaches
// into scheduler internals to prove concurrency.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { listExecutions } = require('../src/main/subagents/executionStore');
const cloudProviders = require('../src/main/cloudProviders');
const { createInferenceScheduler } = require('../src/main/subagents/inferenceScheduler');
const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');

// --- Fixtures ---------------------------------------------------------------

const cloudEngine = {
  provider: 'cloud',
  modelId: 'cloud-model',
  chatTarget: { type: 'cloud', provider: 'acme', model: 'cloud-model' },
};
const localEngine = { provider: 'local', port: 4321, modelId: 'local-model', contextLength: 32768 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = content => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }],
});

async function until(condition, message, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await tick();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

/** Resolves with the payload of one lifecycle event of one specific run. */
function nextLifecycle(type, executionId, ms = 3000) {
  return new Promise((resolve, reject) => {
    const onEvent = payload => {
      if (payload.executionId !== executionId) return;
      clearTimeout(timer);
      runtime.backgroundEvents.removeListener(type, onEvent);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      runtime.backgroundEvents.removeListener(type, onEvent);
      reject(new Error(`timed out waiting for the "${type}" event of ${executionId}`));
    }, ms);
    runtime.backgroundEvents.on(type, onEvent);
  });
}

// --- Cloud transport seam ---------------------------------------------------
// The cloud provider builds its own transport from the saved provider and
// ignores a caller-supplied fetchImpl, so tests patch createCloudFetch on the
// module object (the provider calls it through the module on every request).
const originalCreateCloudFetch = cloudProviders.createCloudFetch;
function installCloudFetch(handler) {
  cloudProviders.createCloudFetch = () => (url, options) => handler(url, options);
}
function restoreCloudFetch() {
  cloudProviders.createCloudFetch = originalCreateCloudFetch;
}

/**
 * A timestamped request recorder: every request records its start and end and
 * the peak number of requests in flight, then waits `delayMs` before
 * answering. Overlap is asserted from timestamps, not from wall-clock totals
 * alone.
 */
function recorder(delayMs) {
  const rec = { starts: [], ends: [], active: 0, maxActive: 0, seq: 0 };
  rec.run = async () => {
    const id = ++rec.seq;
    rec.starts.push({ id, at: Date.now() });
    rec.active += 1;
    rec.maxActive = Math.max(rec.maxActive, rec.active);
    if (delayMs) await sleep(delayMs);
    rec.active -= 1;
    rec.ends.push({ id, at: Date.now() });
    return jsonResponse(`answer-${id}`);
  };
  return rec;
}

/** One child run through the real runtime (foreground file analysis). */
function childRun({ task, engine, fetchImpl, parentSessionId, rootPath }) {
  return runtime.runFileAnalysis({
    task_description: task, target_files: [], rootPath, engine, fetchImpl, parentSessionId,
  });
}

// --- Parent tool-batch harness ---------------------------------------------
// One assistant message carrying a batch of tool calls, executed by the real
// chat loop with executeTool wired to the real sub-agent runtime — the exact
// path the reported bug traveled.
const TOOL_DEFS = {
  spawn_sub_agent: {
    type: 'function',
    function: {
      name: 'spawn_sub_agent',
      description: 'Delegate one task to a sub-agent.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
    },
  },
  search_memory: {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search memory.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
};

const spawnCalls = count => Array.from({ length: count }, (_, index) => ({
  id: `call-${index}`,
  name: 'spawn_sub_agent',
  arguments: JSON.stringify({ task: `subtask ${index}` }),
}));

const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function stream(chunks) {
  const bytes = new TextEncoder().encode(
    chunks.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }));
}

async function runParentBatch({ calls, runChild }) {
  const ids = calls.map(call => call.id);
  const requests = [];
  const dispatchStarts = [];
  let parentRequests = 0;
  const fetchImpl = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    parentRequests += 1;
    if (parentRequests === 1) {
      return stream([
        chunk({ tool_calls: calls.map((call, index) => ({
          index, id: call.id, type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })) }),
        chunk({}, 'tool_calls'),
      ]);
    }
    return stream([chunk({ content: 'Batch complete. [TASK COMPLETE]' }), chunk({}, 'stop')]);
  };
  const text = await runMemoryChat({
    baseUrl: 'http://localhost',
    modelId: 'parent-model',
    messages: [{ role: 'system', content: 'Rules' }],
    chatTools: [...new Set(calls.map(call => call.name))].map(name => TOOL_DEFS[name]),
    fetchImpl,
    executeTool: async call => {
      dispatchStarts.push({ id: call.id, name: call.name, at: Date.now() });
      return runChild(call);
    },
  });
  return { text, requests, dispatchStarts, ids };
}

// --- Tests ------------------------------------------------------------------

test('A. two independent cloud subagent jobs overlap in execution', async () => {
  const rec = recorder(200);
  installCloudFetch(() => rec.run());
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-a-'));
  try {
    const started = Date.now();
    const results = await Promise.all([1, 2].map(index => childRun({
      task: `task-${index}`, engine: cloudEngine, parentSessionId: 'conc-a', rootPath,
    })));
    const elapsed = Date.now() - started;
    assert.equal(rec.starts.length, 2, 'both cloud jobs must reach the provider');
    assert.ok(rec.starts[1].at < rec.ends[0].at,
      `cloud jobs serialized: job 2 started at +${rec.starts[1].at - started}ms, `
      + `job 1 ended at +${rec.ends[0].at - started}ms`);
    assert.ok(elapsed < 390,
      `two 200ms cloud jobs took ${elapsed}ms; overlapping execution finishes well under 400ms`);
    assert.equal(results.length, 2);
    assert.equal(rec.maxActive, 2, 'both requests were in flight together');
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('B. four cloud subagent jobs all start before the first one finishes', async () => {
  const rec = recorder(200);
  installCloudFetch(() => rec.run());
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-b-'));
  try {
    await Promise.all([1, 2, 3, 4].map(index => childRun({
      task: `task-${index}`, engine: cloudEngine, parentSessionId: 'conc-b', rootPath,
    })));
    assert.equal(rec.starts.length, 4, 'all four jobs were dispatched');
    const firstEnd = rec.ends[0].at;
    const startedFirst = rec.starts.filter(start => start.at < firstEnd).length;
    assert.equal(startedFirst, 4,
      `only ${startedFirst} of 4 cloud jobs started before the first one finished — `
      + 'the scheduler must dispatch independent cloud jobs without waiting');
    assert.ok(rec.maxActive >= 4, `expected four concurrent cloud requests, saw ${rec.maxActive}`);
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('B2. a parent batch of eight spawn_sub_agent calls dispatches every child before any finishes', async () => {
  // The reported scenario, end to end: one assistant message with eight
  // sub-agent calls, the real chat loop, the real runtime, the real scheduler,
  // and a cloud provider whose requests take 200ms each.
  const rec = recorder(200);
  installCloudFetch(() => rec.run());
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-b2-'));
  try {
    const started = Date.now();
    const { text, requests, dispatchStarts, ids } = await runParentBatch({
      calls: spawnCalls(8),
      runChild: call => childRun({
        task: JSON.parse(call.arguments).task,
        engine: cloudEngine,
        parentSessionId: 'conc-b2',
        rootPath,
      }),
    });
    const elapsed = Date.now() - started;

    assert.equal(text, 'Batch complete. [TASK COMPLETE]');
    assert.equal(dispatchStarts.length, 8, 'every spawn call must reach executeTool');
    const firstEnd = rec.ends[0].at;
    const dispatchedInTime = dispatchStarts.filter(start => start.at < firstEnd).length;
    assert.equal(dispatchedInTime, 8,
      `only ${dispatchedInTime} of 8 sub-agents were dispatched before the first one finished — `
      + 'the parent batch is serializing child execution before the scheduler sees it');
    // The cloud lane's declared capacity lets four requests fly at once; the
    // rest queue there (per-provider/model slots), never behind unrelated work.
    assert.ok(rec.maxActive >= 4, `expected at least four concurrent cloud requests, saw ${rec.maxActive}`);
    assert.ok(elapsed < 1400,
      `eight 200ms cloud jobs took ${elapsed}ms; serialized execution needs at least 1600ms`);

    // Result order still matches call order, whatever the completion order.
    const toolMessages = requests[1].messages.filter(message => message.role === 'tool');
    assert.deepEqual(toolMessages.map(message => message.tool_call_id), ids,
      'tool results must settle in the original call order');
    assert.equal(sessionManager.listChildren('conc-b2').length, 8, 'each call opened its own child session');
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('C. a local provider with one physical slot stays sequential', async () => {
  const rec = recorder(150);
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-c-'));
  try {
    await Promise.all([1, 2].map(index => childRun({
      task: `task-${index}`, engine: localEngine, fetchImpl: () => rec.run(),
      parentSessionId: 'conc-c', rootPath,
    })));
    assert.equal(rec.starts.length, 2);
    assert.equal(rec.maxActive, 1, 'a capacity-1 local lane must never run two generations at once');
    assert.ok(rec.starts[1].at >= rec.ends[0].at,
      'the second local job must wait for the first to release the slot');
    const children = sessionManager.listChildren('conc-c');
    assert.equal(children.length, 2);
    for (const child of children) assert.equal(child.status, sessionManager.SESSION_STATUS.COMPLETED);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('C2. a concurrent parent batch of local children still runs one generation at a time', async () => {
  // Same batch dispatch as B2, but on the local engine: dispatching three
  // children at once must not put more than one request on the local server.
  const rec = recorder(120);
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-c2-'));
  try {
    const { text, requests, dispatchStarts, ids } = await runParentBatch({
      calls: spawnCalls(3),
      runChild: call => childRun({
        task: JSON.parse(call.arguments).task,
        engine: localEngine,
        fetchImpl: () => rec.run(),
        parentSessionId: 'conc-c2',
        rootPath,
      }),
    });
    assert.equal(text, 'Batch complete. [TASK COMPLETE]');
    assert.equal(rec.starts.length, 3, 'all three children reached the local lane');
    assert.equal(rec.maxActive, 1, 'concurrent dispatch must not overlap generations on a capacity-1 local lane');
    assert.ok(rec.starts[1].at >= rec.ends[0].at && rec.starts[2].at >= rec.ends[1].at,
      'local generations must remain strictly sequential');
    assert.ok(dispatchStarts.every(start => start.at < rec.ends[0].at),
      'all three children should have been dispatched up front');
    const toolMessages = requests[1].messages.filter(message => message.role === 'tool');
    assert.deepEqual(toolMessages.map(message => message.tool_call_id), ids,
      'the sequential local lane must still settle results in call order');
    for (const child of sessionManager.listChildren('conc-c2')) {
      assert.equal(child.status, sessionManager.SESSION_STATUS.COMPLETED);
    }
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('G. a mixed batch keeps non-sub-agent ordering while sub-agents dispatch ahead', async () => {
  // [spawn A, search_memory, spawn B]: sub-agent calls dispatch ahead, but an
  // ordinary tool is a barrier — it waits for the earlier sub-agent, runs
  // before the later one — and every result still lands in call order.
  const rec = recorder(150);
  installCloudFetch(() => rec.run());
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-g-'));
  try {
    const calls = [
      { id: 'call-0', name: 'spawn_sub_agent', arguments: JSON.stringify({ task: 'subtask 0' }) },
      { id: 'call-1', name: 'search_memory', arguments: JSON.stringify({ query: 'needle' }) },
      { id: 'call-2', name: 'spawn_sub_agent', arguments: JSON.stringify({ task: 'subtask 2' }) },
    ];
    const { text, requests, dispatchStarts, ids } = await runParentBatch({
      calls,
      runChild: call => (call.name === 'search_memory'
        ? 'memory hits'
        : childRun({
          task: JSON.parse(call.arguments).task,
          engine: cloudEngine,
          parentSessionId: 'conc-g',
          rootPath,
        })),
    });
    assert.equal(text, 'Batch complete. [TASK COMPLETE]');

    // (a) Start order: the barrier tool sits between the two sub-agents.
    assert.deepEqual(dispatchStarts.map(start => start.name),
      ['spawn_sub_agent', 'search_memory', 'spawn_sub_agent'],
      'a non-sub-agent call must wait for earlier sub-agents, and later sub-agents must wait for it');

    // (b) The barrier really drained the first sub-agent before starting.
    assert.ok(dispatchStarts[1].at >= rec.ends[0].at,
      `search_memory started at +${dispatchStarts[1].at}ms, `
      + `before the first cloud sub-agent ended at +${rec.ends[0].at}ms`);

    // (c) Results still settle in the original call order.
    const toolMessages = requests[1].messages.filter(message => message.role === 'tool');
    assert.deepEqual(toolMessages.map(message => message.tool_call_id), ids,
      'tool results must settle in the original call order');
    assert.equal(sessionManager.listChildren('conc-g').length, 2,
      'only the two spawns opened child sessions');
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('D. a busy local lane and a cloud lane do not block one another', async () => {
  const localRec = recorder(300);
  const cloudRec = recorder(100);
  installCloudFetch(() => cloudRec.run());
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-d-'));
  try {
    const localRun = childRun({
      task: 'slow local task', engine: localEngine, fetchImpl: () => localRec.run(),
      parentSessionId: 'conc-d', rootPath,
    });
    const cloudRun = childRun({
      task: 'fast cloud task', engine: cloudEngine, parentSessionId: 'conc-d', rootPath,
    });
    await Promise.all([localRun, cloudRun]);
    assert.equal(localRec.maxActive, 1, 'the local lane keeps its single slot');
    assert.equal(cloudRec.maxActive, 1, 'the cloud request went out on its own lane');
    assert.ok(cloudRec.ends[0].at < localRec.ends[0].at,
      `the cloud job must finish while the local job still holds its slot `
      + `(cloud ended at +${cloudRec.ends[0].at}ms, local at +${localRec.ends[0].at}ms)`);
    const children = sessionManager.listChildren('conc-d');
    assert.equal(children.length, 2);
    for (const child of children) assert.equal(child.status, sessionManager.SESSION_STATUS.COMPLETED);
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('E1. cancelling a queued cloud job dequeues it without disturbing the lane', async () => {
  const scheduler = createInferenceScheduler();
  const lane = { provider: 'cloud', model: 'acme/cloud-model', maxConcurrency: 1 };
  const starts = [];
  const gate = deferred();
  const controller = new AbortController();

  const a = scheduler.submit({ ...lane, task: () => { starts.push('A'); return gate.promise.then(() => 'A'); } });
  const b = scheduler.submit({
    ...lane, signal: controller.signal,
    task: () => { starts.push('B'); return Promise.resolve('B'); },
  });
  const c = scheduler.submit({ ...lane, task: () => { starts.push('C'); return Promise.resolve('C'); } });
  await tick();
  assert.deepEqual(starts, ['A'], 'the lane is at capacity');

  controller.abort();
  await assert.rejects(b, { name: 'AbortError' });

  gate.resolve();
  assert.equal(await a, 'A');
  await tick();
  assert.deepEqual(starts, ['A', 'C'], 'the cancelled entry must be gone from the queue');
  assert.equal(await c, 'C');
  assert.deepEqual(starts, ['A', 'C'], 'the dequeued job must never run');
});

test('E2. interrupt still stops a running cloud child, and resume completes it', async () => {
  const parked = [];
  installCloudFetch((url, options) => new Promise((resolve, reject) => {
    parked.push({ release: content => resolve(jsonResponse(content)) });
    const { signal } = options;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  try {
    const turn = runtime.runInvestigation({
      task: 'Investigate this.', rootPath: process.cwd(), engine: cloudEngine, parentSessionId: 'conc-e2',
    });
    await until(() => parked.length === 1, 'the child never reached the cloud model');
    const session = sessionManager.listChildren('conc-e2')[0];

    const stopped = runtime.interrupt(session.id, { parentSessionId: 'conc-e2' });
    assert.equal(stopped.interrupted, true);
    await assert.rejects(turn, { name: 'AbortError' }, 'an interrupted foreground turn releases its caller');
    assert.equal(sessionManager.getSession(session.id).status, sessionManager.SESSION_STATUS.INTERRUPTED);
    assert.deepEqual(listExecutions(session.id).map(execution => execution.status), ['interrupted'],
      'the attempt is interrupted, not failed or cancelled');

    // The same child resumes with its own context through the same scheduler.
    runtime.resume(session.id, { parentSessionId: 'conc-e2' });
    await until(() => parked.length === 2, 'the resumed child never reached the model again');
    parked[1].release('Resumed answer.');
    await until(() => sessionManager.getSession(session.id).status === sessionManager.SESSION_STATUS.COMPLETED,
      'the resumed child never completed');
    assert.equal(sessionManager.getSession(session.id).result, 'Resumed answer.');
  } finally {
    restoreCloudFetch();
  }
});

test('E3. cancelling a background cloud run still settles it as cancelled', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-e3-'));
  const parked = [];
  installCloudFetch((url, options) => new Promise((resolve, reject) => {
    parked.push({ release: content => resolve(jsonResponse(content)) });
    const { signal } = options;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  try {
    const handle = runtime.startFileAnalysis({
      task_description: 'background task', target_files: [], rootPath,
      engine: cloudEngine, parentSessionId: 'conc-e3',
    });
    assert.equal(handle.status, 'running');
    const cancelled = nextLifecycle('cancelled', handle.executionId);
    await until(() => parked.length === 1, 'the background child never reached the cloud model');

    assert.equal(runtime.cancelBackground(handle.executionId), true);
    const event = await cancelled;
    assert.equal(event.childSessionId, handle.childSessionId);
    assert.equal(sessionManager.getSession(handle.childSessionId).status,
      sessionManager.SESSION_STATUS.CANCELLED);
    assert.deepEqual(listExecutions(handle.childSessionId).map(execution => execution.status), ['cancelled']);
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('F. concurrent cloud children keep isolated sessions, results, and records', async () => {
  installCloudFetch(async (url, options) => {
    await sleep(30);
    const body = JSON.parse(options.body);
    const user = body.messages.find(message => message.role === 'user');
    return jsonResponse(`answer for ${user.content}`);
  });
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conc-f-'));
  try {
    const tasks = ['task-1', 'task-2', 'task-3', 'task-4'];
    const results = await Promise.all(tasks.map(task => childRun({
      task, engine: cloudEngine, parentSessionId: 'conc-f', rootPath,
    })));
    // Every child got its own answer: nothing crossed between sessions.
    assert.deepEqual(results, tasks.map(task => `answer for ${task}`));

    const children = sessionManager.listChildren('conc-f');
    assert.equal(children.length, tasks.length);
    assert.equal(new Set(children.map(child => child.id)).size, tasks.length,
      'every run opens its own child session');
    for (const child of children) {
      assert.equal(child.status, sessionManager.SESSION_STATUS.COMPLETED);
      assert.equal(child.provider, 'cloud');
      assert.equal(child.providerId, 'acme');
      assert.equal(child.model, 'cloud-model');
      const executions = listExecutions(child.id);
      assert.equal(executions.length, 1, 'exactly one attempt per first run');
      assert.equal(executions[0].status, 'completed');
      assert.equal(executions[0].background, false);
      const snapshot = runtime.describeChild(child.id);
      assert.equal(snapshot.status, sessionManager.SESSION_STATUS.COMPLETED);
      assert.equal(snapshot.model, 'cloud-model');
      assert.ok(child.result.startsWith('answer for task-'), 'each child keeps its own result');
    }
  } finally {
    restoreCloudFetch();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
