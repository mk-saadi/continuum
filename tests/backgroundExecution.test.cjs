const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { listExecutions } = require('../src/main/subagents/executionStore');
const { CHILD_AGENT_SYSTEM_PROMPT, CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };

const jsonResponse = (content, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }], usage,
});
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = (calls, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content: '', finish_reason: 'tool_calls', tool_calls: calls } }], usage,
});

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

// A scheduler bug must fail the test, not hang it.
function withTimeout(promise, message, ms = 2000) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function until(condition, message, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await tick();
  }
}

/** Resolves with the payload of one lifecycle event of one specific run. */
function nextLifecycle(type, executionId, ms = 2000) {
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

/**
 * A model endpoint whose requests park until released, so a test can hold
 * scheduler slots open and observe queueing, overlap, and aborts. Every parked
 * request honors its AbortSignal the same way the real transport does.
 */
function parkingModel() {
  const model = { requests: [], active: 0, maxActive: 0 };
  model.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const { signal } = options;
    const request = { url: String(url), body: JSON.parse(options.body), settled: false };
    model.requests.push(request);
    model.active += 1;
    model.maxActive = Math.max(model.maxActive, model.active);
    const settle = (finish, value) => {
      if (request.settled) return;
      request.settled = true;
      model.active -= 1;
      finish(value);
    };
    // release() takes either plain content or a ready-made Response.
    request.release = value => settle(resolve,
      typeof value === 'string' ? jsonResponse(value) : value);
    if (signal) {
      const onAbort = () => settle(reject, signal.reason ?? new Error('aborted'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return model;
}

test('1. a background execution returns its identity before the child completes', async () => {
  const model = parkingModel();
  const handle = runtime.startInvestigation({
    task: 'Investigate in the background.',
    rootPath: process.cwd(), engine,
    parentSessionId: 'bg-return', fetchImpl: model.fetch,
  });
  // No await above: the handle exists while the child's first turn is parked.
  assert.deepEqual(Object.keys(handle).sort(), ['childSessionId', 'executionId', 'status']);
  assert.ok(handle.childSessionId.startsWith('bg-return_child_'), 'the handle names the child session');
  assert.notEqual(handle.executionId, handle.childSessionId);
  assert.equal(handle.status, 'running', 'the returned status is active, not terminal');
  const session = sessionManager.getSession(handle.childSessionId);
  assert.equal(session.status, sessionManager.SESSION_STATUS.RUNNING);
  assert.equal(session.completedAt, null);
  assert.equal(session.result, null);
  const [execution] = listExecutions(handle.childSessionId);
  assert.equal(execution.id, handle.executionId);
  assert.equal(execution.background, true, 'background is a property of the execution');
  assert.equal(execution.status, 'running');

  const completed = nextLifecycle('completed', handle.executionId);
  await until(() => model.requests.length === 1, 'the child never reached the model');
  assert.equal(sessionManager.getSession(handle.childSessionId).status, 'running');
  model.requests[0].release('Background answer.');
  const event = await completed;
  assert.equal(event.childSessionId, handle.childSessionId);
  assert.equal(event.kind, 'investigation');
  assert.equal(event.status, 'completed');
  assert.equal(sessionManager.getSession(handle.childSessionId).result, 'Background answer.');
});

test('2. the caller finishes its own work while the background child keeps running', async () => {
  const model = parkingModel();
  const handle = runtime.startInvestigation({
    task: 'Long background task.',
    rootPath: process.cwd(), engine,
    parentSessionId: 'bg-independent', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never started');

  // The caller's own work runs to completion on its own lane while the child
  // holds its generation elsewhere — the caller does not wait for the child.
  const parentResult = await withTimeout(runtime.runFileAnalysis({
    task_description: 'Parent work', target_files: [], rootPath: process.cwd(),
    engine: { ...engine, modelId: 'parent-model' },
    parentSessionId: 'bg-independent-parent',
    fetchImpl: async () => jsonResponse('parent done'),
  }), 'the caller was blocked by its own background child');
  assert.equal(parentResult, 'parent done');

  // The caller has finished; the child is untouched and still on its first turn.
  assert.equal(sessionManager.getSession(handle.childSessionId).status, 'running');
  assert.equal(model.requests.length, 1);

  const completed = nextLifecycle('completed', handle.executionId);
  model.requests[0].release('child finished last');
  await completed;
  assert.equal(sessionManager.getSession(handle.childSessionId).status, 'completed');
  assert.equal(sessionManager.getSession(handle.childSessionId).result, 'child finished last');
});

test('3./4. a background child completes the Step 4 loop and retains its result and usage', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-loop-'));
  try {
    await fs.writeFile(path.join(rootPath, 'notes.txt'), 'BACKGROUND CHILD MARKER');
    const payloads = [];
    const responses = [
      toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'notes.txt' })],
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      jsonResponse('Looped findings.', { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }),
    ];
    const fetchImpl = async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      const next = responses.shift();
      assert.ok(next, 'unexpected extra inference request');
      return next;
    };
    const handle = runtime.startInvestigation({
      task: 'Investigate notes.', rootPath, engine,
      parentSessionId: 'bg-loop', fetchImpl,
    });
    const event = await nextLifecycle('completed', handle.executionId);
    assert.equal(event.status, 'completed');

    const session = sessionManager.getSession(handle.childSessionId);
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
    assert.equal(session.result, 'Looped findings.');
    assert.equal(session.error, null);
    assert.ok(session.startedAt);
    assert.ok(session.completedAt);
    // 4. the result and usage are retained by the child session itself.
    assert.deepEqual(session.usage, { prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 });
    const [execution] = listExecutions(session.id);
    assert.equal(execution.status, 'completed');
    assert.equal(execution.result, 'Looped findings.');
    assert.deepEqual(execution.usage, session.usage);
    assert.equal(execution.background, true);

    // Same multi-turn loop as foreground: system + task + its own tool round.
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[1].messages.map(message => message.role),
      ['system', 'user', 'assistant', 'tool']);
    assert.match(payloads[1].messages[3].content, /BACKGROUND CHILD MARKER/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('5. a failing background child becomes failed without touching its caller', async () => {
  const handle = runtime.startInvestigation({
    task: 'Doomed task.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-fail',
    fetchImpl: async () => new Response('server body', { status: 500 }),
  });
  // The start call already returned successfully — nothing was thrown at it.
  const failed = await nextLifecycle('failed', handle.executionId);
  assert.match(failed.error, /HTTP 500/);
  const session = sessionManager.getSession(handle.childSessionId);
  assert.equal(session.status, sessionManager.SESSION_STATUS.FAILED);
  assert.match(session.error, /HTTP 500/);
  assert.equal(session.result, null);
  assert.ok(session.completedAt);
  const [execution] = listExecutions(session.id);
  assert.equal(execution.status, 'failed');
  assert.match(execution.error, /HTTP 500/);

  // Nothing else was disturbed: the failed child released its scheduler slot,
  // so the next run gets the lane immediately, and a settled run cannot be
  // cancelled after the fact.
  const recovery = await withTimeout(runtime.runFileAnalysis({
    task_description: 'recover', target_files: [], rootPath: process.cwd(), engine,
    parentSessionId: 'bg-fail-recover',
    fetchImpl: async () => jsonResponse('recovered'),
  }), 'the failed background child leaked its scheduler slot');
  assert.equal(recovery, 'recovered');
  assert.equal(runtime.cancelBackground(handle.executionId), false);
});

test('6a. cancelling a running background child ends it as cancelled and frees its slot', async () => {
  const model = parkingModel();
  const handle = runtime.startInvestigation({
    task: 'Cancel me mid-run.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-cancel-run', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const cancelled = nextLifecycle('cancelled', handle.executionId);
  assert.equal(runtime.cancelBackground(handle.executionId), true);
  const event = await cancelled;
  assert.equal(event.status, 'cancelled');

  const session = sessionManager.getSession(handle.childSessionId);
  assert.equal(session.status, sessionManager.SESSION_STATUS.CANCELLED);
  assert.equal(listExecutions(session.id)[0].status, 'cancelled');
  assert.equal(model.requests[0].settled, true, 'the active inference was aborted');

  // Scheduler capacity must be released after cancellation: the lane serves
  // the next generation immediately.
  const output = await withTimeout(runtime.runInvestigation({
    task: 'next', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-cancel-next',
    fetchImpl: async () => jsonResponse('slot released'),
  }), 'the cancelled background child kept its scheduler slot');
  assert.equal(output, 'slot released');
  assert.equal(runtime.cancelBackground(handle.executionId), false, 'a settled run is no longer cancellable');
});

test('6b. cancelling a queued background child dequeues it without ever calling the model', async () => {
  const model = parkingModel();
  // Occupy the only capacity-1 slot with a foreground generation.
  const holder = runtime.runFileAnalysis({
    task_description: 'holder', target_files: [], rootPath: process.cwd(), engine,
    parentSessionId: 'bg-holder', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the lane was never occupied');

  const handle = runtime.startInvestigation({
    task: 'Queued child.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-cancel-queued', fetchImpl: model.fetch,
  });
  await tick();
  assert.equal(model.requests.length, 1, 'the background child waits in the scheduler queue');
  const cancelled = nextLifecycle('cancelled', handle.executionId);
  assert.equal(runtime.cancelBackground(handle.executionId), true);
  const event = await cancelled;
  assert.equal(event.status, 'cancelled');
  assert.equal(sessionManager.getSession(handle.childSessionId).status, 'cancelled');

  // The holder is untouched, the cancelled child never reached the model, and
  // the lane still works afterwards.
  model.requests[0].release('holder done');
  assert.equal(await withTimeout(holder, 'the holder never finished'), 'holder done');
  assert.equal(model.requests.length, 1, 'the dequeued child must never start an inference');
  const output = await withTimeout(runtime.runFileAnalysis({
    task_description: 'after cancel', target_files: [], rootPath: process.cwd(), engine,
    parentSessionId: 'bg-cancel-after',
    fetchImpl: async () => jsonResponse('lane healthy'),
  }), 'the lane was left in a broken state');
  assert.equal(output, 'lane healthy');
});

test('6c. an aborting caller signal still cancels a run the caller no longer awaits', async () => {
  const model = parkingModel();
  const controller = new AbortController();
  const handle = runtime.startInvestigation({
    task: 'Signal-cancelled child.', rootPath: process.cwd(), engine, signal: controller.signal,
    parentSessionId: 'bg-cancel-signal', fetchImpl: model.fetch,
  });
  const cancelled = nextLifecycle('cancelled', handle.executionId);
  await until(() => model.requests.length === 1, 'the child never reached the model');
  controller.abort();
  const event = await cancelled;
  assert.equal(event.status, 'cancelled');
  assert.equal(sessionManager.getSession(handle.childSessionId).status, 'cancelled');
});

test('7a. a queued background child respects a capacity-1 provider/model lane', async () => {
  const model = parkingModel();
  // The main generation holds the only slot.
  const main = runtime.runFileAnalysis({
    task_description: 'main generation', target_files: [], rootPath: process.cwd(), engine,
    parentSessionId: 'bg-sched-main', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the main generation never started');

  const handle = runtime.startInvestigation({
    task: 'Queued background child.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-sched-1', fetchImpl: model.fetch,
  });
  await tick();
  await tick();
  assert.equal(model.requests.length, 1,
    'a queued background execution consumes no active inference capacity');
  assert.equal(model.active, 1);

  const completed = nextLifecycle('completed', handle.executionId);
  model.requests[0].release('main answer');
  assert.equal(await withTimeout(main, 'the main generation never finished'), 'main answer');
  await until(() => model.requests.length === 2, 'the queued child never started after the slot freed');
  model.requests[1].release('child answer');
  await completed;
  assert.equal(model.maxActive, 1, 'capacity 1 must never run two generations at once');
  assert.equal(sessionManager.getSession(handle.childSessionId).result, 'child answer');
});

test('7b. capacity 2 lets two background children generate at the same time', async () => {
  const model = parkingModel();
  const wide = { ...engine, maxConcurrency: 2 };
  const first = runtime.startInvestigation({
    task: 'Child A.', rootPath: process.cwd(), engine: wide,
    parentSessionId: 'bg-sched-2a', fetchImpl: model.fetch,
  });
  const second = runtime.startInvestigation({
    task: 'Child B.', rootPath: process.cwd(), engine: wide,
    parentSessionId: 'bg-sched-2b', fetchImpl: model.fetch,
  });
  const firstDone = nextLifecycle('completed', first.executionId);
  const secondDone = nextLifecycle('completed', second.executionId);
  await until(() => model.requests.length === 2, 'the second child never reached the model');
  assert.equal(model.maxActive, 2, 'capacity 2 must allow two simultaneous background generations');
  model.requests[0].release('A done');
  model.requests[1].release('B done');
  await Promise.all([withTimeout(firstDone, 'child A never finished'),
    withTimeout(secondDone, 'child B never finished')]);
  assert.equal(sessionManager.getSession(first.childSessionId).result, 'A done');
  assert.equal(sessionManager.getSession(second.childSessionId).result, 'B done');
});

test('7c. background children on different provider/model lanes never block each other', async () => {
  const laneA = parkingModel();
  const laneB = parkingModel();
  const blocked = runtime.startInvestigation({
    task: 'Slow lane.', rootPath: process.cwd(), engine: { ...engine, modelId: 'model-a' },
    parentSessionId: 'bg-lane-a', fetchImpl: laneA.fetch,
  });
  const free = runtime.startInvestigation({
    task: 'Fast lane.', rootPath: process.cwd(), engine: { ...engine, modelId: 'model-b' },
    parentSessionId: 'bg-lane-b', fetchImpl: laneB.fetch,
  });
  const freeDone = nextLifecycle('completed', free.executionId);
  await until(() => laneB.requests.length === 1, 'the second lane never ran');
  laneB.requests[0].release('fast answer');
  await freeDone;
  assert.equal(sessionManager.getSession(free.childSessionId).result, 'fast answer');
  assert.equal(sessionManager.getSession(blocked.childSessionId).status, 'running',
    'a busy lane must not affect a child on another lane');

  const blockedDone = nextLifecycle('completed', blocked.executionId);
  await until(() => laneA.requests.length === 1, 'the blocked lane never started');
  laneA.requests[0].release('slow answer');
  await blockedDone;
  assert.equal(sessionManager.getSession(blocked.childSessionId).result, 'slow answer');
});

test('8. foreground execution still awaits its result and is not marked background', async () => {
  const output = await runtime.runInvestigation({
    task: 'Foreground task.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-foreground',
    fetchImpl: async () => jsonResponse('foreground answer'),
  });
  assert.equal(output, 'foreground answer', 'foreground resolves to the result itself, not a handle');
  const [session] = sessionManager.listChildren('bg-foreground');
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  const [execution] = listExecutions(session.id);
  assert.equal(execution.background, false);
  assert.equal(execution.status, 'completed');
  await assert.rejects(
    runtime.runInvestigation({
      task: 'x', rootPath: process.cwd(), engine, parentSessionId: 'bg-foreground-fail',
      fetchImpl: async () => new Response('server body', { status: 500 }),
    }),
    /HTTP 500/,
    'foreground failures still reject the caller as before',
  );
  // Guard: run* takes no background flag, so the two lifetimes stay two
  // explicit entry points instead of one function with two return shapes.
  await assert.rejects(
    runtime.runInvestigation({ task: 'x', rootPath: process.cwd(), engine, background: true }),
    /take no "background" option/,
  );
});

test('9. two background children coexist even when only one inference fits', async () => {
  const model = parkingModel();
  const first = runtime.startInvestigation({
    task: 'First child.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-multi', fetchImpl: model.fetch,
  });
  const second = runtime.startInvestigation({
    task: 'Second child.', rootPath: process.cwd(), engine,
    parentSessionId: 'bg-multi', fetchImpl: model.fetch,
  });
  const children = sessionManager.listChildren('bg-multi');
  assert.equal(children.length, 2, 'both children exist as separate logical sessions');
  assert.notEqual(first.childSessionId, second.childSessionId);
  assert.notEqual(first.executionId, second.executionId);

  const firstDone = nextLifecycle('completed', first.executionId);
  const secondDone = nextLifecycle('completed', second.executionId);
  await until(() => model.requests.length === 1, 'no generation started');
  await tick();
  assert.equal(model.requests.length, 1,
    'capacity 1 serializes the inferences, but both children stay alive as sessions');
  assert.equal(sessionManager.getSession(second.childSessionId).status, 'running');
  assert.equal(listExecutions(second.childSessionId)[0].status, 'running');

  model.requests[0].release('first answer');
  await firstDone;
  await until(() => model.requests.length === 2, 'the second child never got its turn');
  model.requests[1].release('second answer');
  await secondDone;
  assert.equal(sessionManager.getSession(first.childSessionId).result, 'first answer');
  assert.equal(sessionManager.getSession(second.childSessionId).result, 'second answer');
});

test('10. background children keep the Step 4 context isolation and tool allowlist', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-iso-'));
  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'CHILD A OWN MARKER');
    await fs.writeFile(path.join(rootPath, 'b.txt'), 'CHILD B OWN MARKER');

    const payloadsA = [];
    const responsesA = [
      toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'a.txt' })]),
      jsonResponse('A findings.'),
    ];
    const childA = runtime.startInvestigation({
      task: 'Investigate a.txt.', rootPath, engine,
      parentSessionId: 'bg-iso',
      // Parent history passed anyway: it must never reach the wire.
      parentMessages: [{ role: 'user', content: 'PARENT SECRET HISTORY' }],
      fetchImpl: async (_url, options) => {
        payloadsA.push(JSON.parse(options.body));
        return responsesA.shift();
      },
    });
    await nextLifecycle('completed', childA.executionId);

    const payloadsB = [];
    const childB = runtime.startInvestigation({
      task: 'Investigate b.txt.', rootPath, engine,
      parentSessionId: 'bg-iso',
      fetchImpl: async (_url, options) => {
        payloadsB.push(JSON.parse(options.body));
        return jsonResponse('B findings.');
      },
    });
    await nextLifecycle('completed', childB.executionId);

    const wire = JSON.stringify([...payloadsA, ...payloadsB]);
    assert.ok(!wire.includes('PARENT SECRET HISTORY'), 'parent history must never reach a request');
    assert.equal(payloadsA[0].messages[0].content, CHILD_AGENT_SYSTEM_PROMPT);
    assert.deepEqual(payloadsA[0].messages.map(message => message.role), ['system', 'user']);
    assert.deepEqual(payloadsA[1].messages.map(message => message.role),
      ['system', 'user', 'assistant', 'tool'], 'child A carries only its own tool round trip');
    assert.match(payloadsA[1].messages[3].content, /CHILD A OWN MARKER/);
    // Child B starts from scratch: no parent history, and no other child's
    // conversation or tool results.
    for (const payload of payloadsB) {
      assert.deepEqual(payload.messages.map(message => message.role), ['system', 'user']);
      assert.equal(payload.messages[1].content, 'Investigate b.txt.');
    }
    assert.ok(!JSON.stringify(payloadsB).includes('CHILD A OWN MARKER'),
      'children never inherit each other\'s context');
    // Backgrounding widens nothing: the same read-only allowlist is offered
    // and the same tool-free-by-default provider rules still apply.
    for (const payload of [...payloadsA, ...payloadsB]) {
      assert.deepEqual(payload.tools.map(tool => tool.function.name).sort(),
        [...CHILD_TOOL_NAMES].sort());
      assert.equal(payload.tool_choice, 'auto');
      assert.equal(payload.stream, false);
    }
    assert.equal(sessionManager.getSession(childB.childSessionId).result, 'B findings.');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('the runtime identifies started, completed, failed, and cancelled background runs', async () => {
  const seen = { started: [], completed: [], failed: [], cancelled: [] };
  const listeners = {};
  for (const type of Object.keys(seen)) {
    listeners[type] = payload => seen[type].push(payload);
    runtime.backgroundEvents.on(type, listeners[type]);
  }
  try {
    const done = runtime.startInvestigation({
      task: 'ok', rootPath: process.cwd(), engine, parentSessionId: 'bg-events',
      fetchImpl: async () => jsonResponse('done'),
    });
    const doneCompleted = nextLifecycle('completed', done.executionId);
    const failing = runtime.startInvestigation({
      task: 'bad', rootPath: process.cwd(), engine, parentSessionId: 'bg-events',
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    const failingFailed = nextLifecycle('failed', failing.executionId);
    const model = parkingModel();
    const toCancel = runtime.startInvestigation({
      task: 'cancel', rootPath: process.cwd(), engine, parentSessionId: 'bg-events',
      fetchImpl: model.fetch,
    });
    const toCancelCancelled = nextLifecycle('cancelled', toCancel.executionId);
    await until(() => model.requests.length === 1, 'the cancellable run never reached the model');
    assert.equal(runtime.cancelBackground(toCancel.executionId), true);
    await Promise.all([
      withTimeout(doneCompleted, 'the completing run never settled'),
      withTimeout(failingFailed, 'the failing run never settled'),
      withTimeout(toCancelCancelled, 'the cancelled run never settled'),
    ]);

    assert.deepEqual(seen.started.map(payload => payload.executionId).sort(),
      [done.executionId, failing.executionId, toCancel.executionId].sort(),
      'every background run reports "started"');
    assert.equal(seen.completed.length, 1);
    assert.equal(seen.failed.length, 1);
    assert.equal(seen.cancelled.length, 1);
    for (const payload of [...seen.started, ...seen.completed, ...seen.failed, ...seen.cancelled]) {
      assert.ok(payload.executionId, 'every event identifies the execution');
      assert.ok(payload.childSessionId, 'every event identifies the child session');
      assert.equal(payload.kind, 'investigation');
      assert.ok(payload.status);
    }
    assert.equal(seen.completed[0].childSessionId, done.childSessionId);
    assert.equal(seen.failed[0].childSessionId, failing.childSessionId);
    assert.equal(seen.cancelled[0].childSessionId, toCancel.childSessionId);
    assert.match(seen.failed[0].error, /HTTP 500/);
  } finally {
    for (const [type, listener] of Object.entries(listeners)) {
      runtime.backgroundEvents.removeListener(type, listener);
    }
  }
});

