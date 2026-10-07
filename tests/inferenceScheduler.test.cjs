const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { scheduleInference, createInferenceScheduler } = require('../src/main/subagents/inferenceScheduler');

const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };
const localLane = { provider: 'local', model: 'qwen', maxConcurrency: 1 };
const jsonResponse = content => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }],
});

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

// A scheduler bug must fail the test, not hang it: this bounds any await whose
// progress depends on the queue moving.
function withTimeout(promise, message, ms = 1000) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('capacity 1 runs requests one at a time and never overlaps them', async () => {
  const scheduler = createInferenceScheduler();
  const events = [];
  let active = 0;
  let maxActive = 0;
  const gates = { A: deferred(), B: deferred() };
  const makeTask = name => () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${name}`);
    return gates[name].promise.then(value => {
      events.push(`end:${name}`);
      active -= 1;
      return value;
    });
  };
  const a = scheduler.submit({ ...localLane, task: makeTask('A') });
  const b = scheduler.submit({ ...localLane, task: makeTask('B') });
  await tick();
  assert.deepEqual(events, ['start:A'], 'B must wait while A holds the only slot');

  gates.A.resolve('a');
  assert.equal(await a, 'a');
  await tick();
  assert.deepEqual(events, ['start:A', 'end:A', 'start:B'], 'completing A must release the slot to B');

  gates.B.resolve('b');
  assert.equal(await b, 'b');
  assert.equal(maxActive, 1, 'two generations must never run at once on a capacity 1 lane');
  assert.deepEqual(events, ['start:A', 'end:A', 'start:B', 'end:B']);
});

test('a capacity 1 lane starts queued requests in FIFO order', async () => {
  const scheduler = createInferenceScheduler();
  const startOrder = [];
  const gates = [deferred(), deferred(), deferred()];
  const runs = ['A', 'B', 'C'].map((name, index) => scheduler.submit({
    ...localLane,
    task: () => {
      startOrder.push(name);
      return gates[index].promise.then(() => name);
    },
  }));
  await tick();
  assert.deepEqual(startOrder, ['A']);

  gates[0].resolve();
  assert.equal(await runs[0], 'A');
  await tick();
  assert.deepEqual(startOrder, ['A', 'B']);

  gates[1].resolve();
  assert.equal(await runs[1], 'B');
  await tick();
  assert.deepEqual(startOrder, ['A', 'B', 'C']);

  gates[2].resolve();
  assert.equal(await runs[2], 'C');
  assert.deepEqual(startOrder, ['A', 'B', 'C']);
});

test('capacity 2 runs two requests together and holds the third until a slot frees', async () => {
  const scheduler = createInferenceScheduler();
  const lane = { provider: 'cloud', model: 'modelX', maxConcurrency: 2 };
  const starts = [];
  const gates = { A: deferred(), B: deferred(), C: deferred() };
  const makeTask = name => () => {
    starts.push(name);
    return gates[name].promise.then(() => name);
  };
  const a = scheduler.submit({ ...lane, task: makeTask('A') });
  const b = scheduler.submit({ ...lane, task: makeTask('B') });
  const c = scheduler.submit({ ...lane, task: makeTask('C') });
  await tick();
  assert.deepEqual(starts, ['A', 'B'], 'the first two requests fit the capacity');

  gates.A.resolve();
  assert.equal(await a, 'A');
  await tick();
  assert.deepEqual(starts, ['A', 'B', 'C'], 'C starts as soon as A releases its slot');

  gates.B.resolve();
  gates.C.resolve();
  assert.deepEqual(await Promise.all([b, c]), ['B', 'C']);
  assert.deepEqual(starts, ['A', 'B', 'C'], 'no request may start twice');
});

test('lanes are isolated per provider/model, so a busy lane blocks nothing else', async () => {
  const scheduler = createInferenceScheduler();
  const localGate = deferred();
  const local = scheduler.submit({
    ...localLane,
    task: () => localGate.promise.then(() => 'local'),
  });
  await tick();

  // Both other lanes are themselves at capacity 1 — they still run now, while
  // the local lane is full: another provider, and another model on this one.
  const others = Promise.all([
    scheduler.submit({ provider: 'cloud', model: 'modelX', maxConcurrency: 1, task: () => Promise.resolve('cloud') }),
    scheduler.submit({ provider: 'local', model: 'other-model', maxConcurrency: 1, task: () => Promise.resolve('other-model') }),
  ]);
  assert.deepEqual(await withTimeout(others, 'another provider/model was blocked by a busy lane'),
    ['cloud', 'other-model']);

  localGate.resolve();
  assert.equal(await local, 'local');
});

test('simultaneous completions each release their slot exactly once', async () => {
  const scheduler = createInferenceScheduler();
  const lane = { provider: 'local', model: 'modelB', maxConcurrency: 2 };
  const starts = [];
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const runs = ['A', 'B', 'C', 'D'].map((name, index) => scheduler.submit({
    ...lane,
    task: () => {
      starts.push(name);
      return gates[index].promise.then(() => name);
    },
  }));
  await tick();
  assert.deepEqual(starts, ['A', 'B']);

  // Both running requests settle in the same synchronous block.
  gates[0].resolve();
  gates[1].resolve();
  assert.deepEqual(await Promise.all([runs[0], runs[1]]), ['A', 'B']);
  await tick();
  assert.deepEqual(starts, ['A', 'B', 'C', 'D'], 'each queued request starts exactly once');

  gates[2].resolve();
  gates[3].resolve();
  assert.deepEqual(await Promise.all(runs), ['A', 'B', 'C', 'D']);
  assert.deepEqual(starts, ['A', 'B', 'C', 'D']);
});

test('a failed request releases its slot and the error reaches the caller', async () => {
  const scheduler = createInferenceScheduler();
  const starts = [];
  const gate = deferred();

  const failing = scheduler.submit({
    ...localLane,
    task: () => { starts.push('A'); return Promise.reject(new Error('provider exploded')); },
  });
  const next = scheduler.submit({
    ...localLane,
    task: () => { starts.push('B'); return gate.promise.then(() => 'B ok'); },
  });
  await assert.rejects(failing, /provider exploded/);
  await tick();
  assert.deepEqual(starts, ['A', 'B'], 'the failure must free the slot for B');

  // A task that throws synchronously releases the slot the same way.
  const syncFailing = scheduler.submit({
    ...localLane,
    task: () => { starts.push('C'); throw new Error('sync boom'); },
  });
  const after = scheduler.submit({ ...localLane, task: () => { starts.push('D'); return Promise.resolve('D ok'); } });

  gate.resolve();
  assert.equal(await next, 'B ok');
  await assert.rejects(syncFailing, /sync boom/);
  assert.equal(await after, 'D ok');
  assert.deepEqual(starts, ['A', 'B', 'C', 'D']);
});

test('cancelling a queued request dequeues it and lets the following request run', async () => {
  const scheduler = createInferenceScheduler();
  const starts = [];
  const runGate = deferred();
  const cGate = deferred();
  const controller = new AbortController();

  const a = scheduler.submit({
    ...localLane,
    task: () => { starts.push('A'); return runGate.promise.then(() => 'A'); },
  });
  const b = scheduler.submit({
    ...localLane,
    signal: controller.signal,
    task: () => { starts.push('B'); return Promise.resolve('B'); },
  });
  const c = scheduler.submit({
    ...localLane,
    task: () => { starts.push('C'); return cGate.promise.then(() => 'C'); },
  });
  await tick();
  assert.deepEqual(starts, ['A']);

  controller.abort();
  await assert.rejects(b, { name: 'AbortError' });

  runGate.resolve();
  assert.equal(await a, 'A');
  await tick();
  assert.deepEqual(starts, ['A', 'C'], 'the cancelled entry must be gone from the queue');

  cGate.resolve();
  assert.equal(await c, 'C');
});

test('cancelling a running request releases its slot for the next one', async () => {
  const scheduler = createInferenceScheduler();
  const starts = [];
  const controller = new AbortController();

  const a = scheduler.submit({
    ...localLane,
    signal: controller.signal,
    task: () => {
      starts.push('A');
      // The running task keeps using the provider's own abort mechanism.
      return new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    },
  });
  const b = scheduler.submit({ ...localLane, task: () => { starts.push('B'); return Promise.resolve('B'); } });
  await tick();
  assert.deepEqual(starts, ['A']);

  controller.abort();
  await assert.rejects(a, { name: 'AbortError' });
  await tick();
  assert.deepEqual(starts, ['A', 'B']);
  assert.equal(await b, 'B');
});

test('an already-aborted signal rejects without ever entering the queue', async () => {
  const scheduler = createInferenceScheduler();
  const controller = new AbortController();
  controller.abort();
  let ran = false;

  await assert.rejects(
    scheduler.submit({ ...localLane, signal: controller.signal, task: () => { ran = true; return Promise.resolve('x'); } }),
    { name: 'AbortError' },
  );
  assert.equal(ran, false);

  // The lane is untouched: the next request still runs immediately.
  assert.equal(await scheduler.submit({ ...localLane, task: () => Promise.resolve('next') }), 'next');
});

test('concurrent scheduleInference calls on one local lane never overlap and keep order', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  let call = 0;
  const gate = deferred();
  const fetchImpl = async () => {
    call += 1;
    const label = call;
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${label}`);
    if (label === 1) await gate.promise;
    order.push(`end:${label}`);
    active -= 1;
    return jsonResponse(`answer-${label}`);
  };
  const payload = { model: engine.modelId, messages: [{ role: 'user', content: 'hi' }] };

  const first = scheduleInference({ engine, payload, fetchImpl });
  const second = scheduleInference({ engine, payload, fetchImpl });
  await tick();
  assert.deepEqual(order, ['start:1'], 'the second request must queue behind the running one');

  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.result.choices[0].message.content, 'answer-1');
  assert.equal(b.result.choices[0].message.content, 'answer-2');
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
  assert.equal(maxActive, 1);
});

test('engine.maxConcurrency lifts its lane to that many simultaneous generations', async () => {
  const wide = { ...engine, maxConcurrency: 2 };
  let active = 0;
  let maxActive = 0;
  const bothStarted = deferred();
  // Bounded so a scheduler that ignores the capacity fails instead of hanging.
  const fallback = setTimeout(() => bothStarted.resolve(), 2000);
  const fetchImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active >= 2) bothStarted.resolve();
    await bothStarted.promise;
    active -= 1;
    return jsonResponse('ok');
  };
  const payload = { model: wide.modelId, messages: [] };
  try {
    const [a, b] = await Promise.all([
      scheduleInference({ engine: wide, payload, fetchImpl }),
      scheduleInference({ engine: wide, payload, fetchImpl }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(maxActive, 2, 'capacity 2 must allow two simultaneous generations');
  } finally {
    clearTimeout(fallback);
  }
});

test('an unusable engine fails cleanly instead of queueing anything', async () => {
  await assert.rejects(
    scheduleInference({ engine: { ...engine, provider: 'acme-cloud' }, payload: { messages: [] } }),
    /Unsupported inference provider: acme-cloud/,
  );
  await assert.rejects(
    scheduleInference({ engine: { port: engine.port }, payload: { messages: [] } }),
    /requires a model id/,
  );
});

test('a queued subagent execution waits for the running one and still returns its result', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-queue-'));
  try {
    const order = [];
    const gate = deferred();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      order.push(`start:${call}`);
      if (call === 1) {
        await gate.promise;
        order.push('end:1');
        return jsonResponse('first');
      }
      return jsonResponse('second');
    };
    const request = { task_description: 'x', target_files: [], rootPath, engine,
      parentSessionId: 'parent-scheduler', fetchImpl };

    const first = runtime.runFileAnalysis(request);
    const second = runtime.runFileAnalysis(request);
    await tick();
    assert.deepEqual(order, ['start:1'], 'the second execution must wait in the scheduler queue');

    gate.resolve();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(order, ['start:1', 'end:1', 'start:2'],
      'the queued generation starts only after the running one finishes');

    const children = sessionManager.listChildren('parent-scheduler');
    assert.equal(children.length, 2);
    for (const child of children) assert.equal(child.status, sessionManager.SESSION_STATUS.COMPLETED);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
