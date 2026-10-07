const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { listExecutions } = require('../src/main/subagents/executionStore');
const inferenceScheduler = require('../src/main/subagents/inferenceScheduler');
const continuationManager = require('../src/main/subagents/continuationManager');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

// Step 6: parent <-> child messaging, interrupt, and resume. A child is now a
// continuable agent session — one inbox (FIFO), one context that survives every
// turn, one turn at a time, and interrupt that stops without destroying.
// Everything runs in-memory through the existing Step 3 scheduler; there is no
// persistence, no UI, and no model selection here by design.

const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };

const jsonResponse = (content, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }], usage,
});
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = (calls, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content: '', finish_reason: 'tool_calls', tool_calls: calls } }], usage,
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition, message, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await tick();
  }
}

// A scheduler bug must fail the test, not hang it.
function withTimeout(promise, message, ms = 2000) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A scripted model: responses are consumed one per inference turn, in order. */
function script(responses) {
  const payloads = [];
  const queue = [...responses];
  const fetchImpl = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    const next = queue.shift();
    assert.ok(next, `unexpected extra inference request #${payloads.length}`);
    return next;
  };
  return { fetchImpl, payloads };
}

/**
 * A model endpoint whose requests park until released, so a test can hold a
 * child mid-turn (to interrupt it) or hold the lane (to observe queueing).
 * Every parked request honors its AbortSignal like the real transport does.
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

function childOf(parentSessionId) {
  const [session] = sessionManager.listChildren(parentSessionId);
  assert.ok(session, `no child session was created for ${parentSessionId}`);
  return session;
}

const rolesOf = payload => payload.messages.map(message => message.role);
const toolNamesIn = payload => payload.tools.map(tool => tool.function.name).sort();

test('1. a message continues the same child session with its context preserved', async () => {
  const { fetchImpl, payloads } = script([
    jsonResponse('Initial findings.', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }),
    jsonResponse('Deeper findings.', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
  ]);
  const output = await runtime.runInvestigation({
    task: 'Investigate the queue.', rootPath: process.cwd(), engine,
    parentSessionId: 'msg-complete', fetchImpl,
    // Parent history passed anyway: it must never reach a child request.
    parentMessages: [{ role: 'user', content: 'PARENT SECRET HISTORY' }],
  });
  assert.equal(output, 'Initial findings.');
  const session = childOf('msg-complete');
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);

  const result = runtime.sendMessage(session.id, 'now dig deeper', { parentSessionId: 'msg-complete' });
  assert.deepEqual(result,
    { childSessionId: session.id, status: sessionManager.SESSION_STATUS.WAITING, pending: 1 });

  await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
    'the continued child never finished its next turn');
  assert.equal(sessionManager.listChildren('msg-complete').length, 1, 'continuation reuses the same child');
  assert.equal(session.result, 'Deeper findings.');
  assert.deepEqual(session.usage, { prompt_tokens: 16, completion_tokens: 6, total_tokens: 22 },
    'usage is summed across turns');

  // Two turns, two attempts, one conversation: the second payload replays the
  // child's own history plus the new instruction — never the parent's.
  assert.equal(payloads.length, 2);
  assert.deepEqual(rolesOf(payloads[1]), ['system', 'user', 'assistant', 'user']);
  assert.equal(payloads[1].messages[1].content, 'Investigate the queue.');
  assert.equal(payloads[1].messages[3].content, 'now dig deeper');
  assert.ok(!JSON.stringify(payloads).includes('PARENT SECRET HISTORY'));
  assert.deepEqual(session.context.map(message => message.role),
    ['system', 'user', 'assistant', 'user', 'assistant']);
  const executions = listExecutions(session.id);
  assert.equal(executions.length, 2, 'first run + one driven turn');
  assert.deepEqual(executions.map(execution => execution.status), ['completed', 'completed']);
});

test('2. a message wakes a completed child through the inference scheduler', async () => {
  const original = inferenceScheduler.scheduleInference;
  const turns = [];
  inferenceScheduler.scheduleInference = options => {
    turns.push({ allowTools: options.allowTools, model: options.engine?.modelId });
    return original(options);
  };
  try {
    const { fetchImpl } = script([jsonResponse('first answer'), jsonResponse('second answer')]);
    await runtime.runInvestigation({
      task: 'Watch the wake path.', rootPath: process.cwd(), engine,
      parentSessionId: 'msg-wake', fetchImpl,
    });
    const session = childOf('msg-wake');
    runtime.sendMessage(session.id, 'go on', { parentSessionId: 'msg-wake' });
    assert.equal(session.status, sessionManager.SESSION_STATUS.WAITING,
      'the child is observably waiting before any async work runs');
    await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
      'the woken child never finished');
    assert.equal(turns.length, 2, 'one scheduler submission per turn, resumed one included');
    assert.equal(turns[1].allowTools, true, 'the resumed turn opts into tools through the scheduler');
    assert.equal(turns[1].model, 'local-model');
  } finally {
    inferenceScheduler.scheduleInference = original;
  }
});

test('3. queued messages are processed in arrival order (FIFO)', async () => {
  const { fetchImpl, payloads } = script([
    jsonResponse('start'),
    jsonResponse('answer A'),
    jsonResponse('answer B'),
    jsonResponse('answer C'),
  ]);
  await runtime.runInvestigation({
    task: 'Count messages.', rootPath: process.cwd(), engine,
    parentSessionId: 'msg-fifo', fetchImpl,
  });
  const session = childOf('msg-fifo');

  const first = runtime.sendMessage(session.id, 'A', { parentSessionId: 'msg-fifo' });
  const second = runtime.sendMessage(session.id, 'B', { parentSessionId: 'msg-fifo' });
  const third = runtime.sendMessage(session.id, 'C', { parentSessionId: 'msg-fifo' });
  assert.equal(first.pending, 1);
  assert.equal(second.pending, 2);
  assert.equal(third.pending, 3);
  assert.deepEqual(session.inbox.map(entry => entry.message), ['A', 'B', 'C'],
    'the inbox holds every message in arrival order before the driver runs');

  await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
    'the queued messages never drained');
  // One turn per message, in order — each payload's newest instruction is the
  // message that was queued first.
  assert.equal(payloads.length, 4);
  assert.deepEqual(payloads.slice(1).map(payload => payload.messages.at(-1).content), ['A', 'B', 'C']);
  assert.deepEqual(
    session.context.filter(message => message.role === 'user').map(message => message.content),
    ['Count messages.', 'A', 'B', 'C'],
    'the context interleaves every instruction with its own answer, in order',
  );
});

test('4. a message to a running child queues without starting a concurrent turn', async () => {
  const model = parkingModel();
  const turn = runtime.runInvestigation({
    task: 'Long running task.', rootPath: process.cwd(), engine,
    parentSessionId: 'msg-running', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const session = childOf('msg-running');
  assert.equal(listExecutions(session.id).length, 1, 'exactly one attempt owns the context');

  const result = runtime.sendMessage(session.id, 'follow-up', { parentSessionId: 'msg-running' });
  assert.deepEqual(result,
    { childSessionId: session.id, status: sessionManager.SESSION_STATUS.RUNNING, pending: 1 });
  await delay(20);
  assert.equal(model.requests.length, 1, 'a queued message must not start a second inference');
  assert.equal(listExecutions(session.id).length, 1, 'no second attempt may exist while the first runs');

  model.requests[0].release('first answer');
  await turn;
  await until(() => model.requests.length === 2, 'the queued message never ran after the first turn');
  model.requests[1].release('second answer');
  await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
    'the continued child never finished');
  assert.equal(model.maxActive, 1, 'the two turns never overlap on a capacity-1 lane');
  assert.deepEqual(listExecutions(session.id).map(execution => execution.status),
    ['completed', 'completed']);
});

test('5. interrupt aborts the active turn, keeps a valid context, and stays sticky', async () => {
  const model = parkingModel();
  const turn = runtime.runInvestigation({
    task: 'Task to interrupt.', rootPath: process.cwd(), engine,
    parentSessionId: 'int-first', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const session = childOf('int-first');

  const result = runtime.interrupt(session.id, { parentSessionId: 'int-first' });
  assert.deepEqual(result,
    { childSessionId: session.id, status: sessionManager.SESSION_STATUS.RUNNING, interrupted: true });
  await assert.rejects(turn, { name: 'AbortError' }, 'an interrupted foreground turn releases its caller');

  assert.equal(model.requests[0].settled, true, 'the active inference was aborted');
  assert.equal(session.status, sessionManager.SESSION_STATUS.INTERRUPTED);
  assert.deepEqual(session.context.map(message => message.role), ['system', 'user'],
    'interrupt rolls back to the last safe boundary, never a half-written turn');
  assert.deepEqual(listExecutions(session.id).map(execution => execution.status), ['interrupted'],
    'the attempt is interrupted, not failed or cancelled');
  assert.equal(continuationManager.getRecord(session.id).pendingContinuation, true,
    'the unfinished turn is noted for re-drive');

  // Interrupt is sticky: nothing restarts on its own.
  const requestsBefore = model.requests.length;
  await delay(30);
  assert.equal(model.requests.length, requestsBefore, 'no inference may restart without an explicit wake');
  assert.equal(session.status, sessionManager.SESSION_STATUS.INTERRUPTED);
  assert.equal(session.inbox.length, 0);
});

test('6. resume re-drives the interrupted turn first, then drains the inbox — through the scheduler', async () => {
  const model = parkingModel();
  const payloads = [];
  const fetchImpl = (url, options) => {
    payloads.push(JSON.parse(options.body));
    return model.fetch(url, options);
  };
  const turn = runtime.runInvestigation({
    task: 'Resume this task.', rootPath: process.cwd(), engine,
    parentSessionId: 'int-resume', fetchImpl,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const session = childOf('int-resume');
  runtime.interrupt(session.id, { parentSessionId: 'int-resume' });
  await assert.rejects(turn, { name: 'AbortError' });

  runtime.sendMessage(session.id, 'extra note', { parentSessionId: 'int-resume' });
  assert.equal(session.inbox.length, 1);
  const resume = runtime.resume(session.id, { parentSessionId: 'int-resume' });
  assert.deepEqual(resume,
    { childSessionId: session.id, status: sessionManager.SESSION_STATUS.WAITING, resumed: true });

  const original = inferenceScheduler.scheduleInference;
  const resumedTurns = [];
  inferenceScheduler.scheduleInference = options => {
    resumedTurns.push({ allowTools: options.allowTools, model: options.engine?.modelId });
    return original(options);
  };
  try {
    await until(() => model.requests.length === 2, 'the resumed turn never started');
    model.requests[1].release('answered the original task');
    await until(() => model.requests.length === 3, 'the queued message never started');
    model.requests[2].release('answered the note');
    await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
      'the resumed child never finished');
    assert.equal(resumedTurns.length, 2, 'both resumed turns go through the Step 3 scheduler');
    for (const resumed of resumedTurns) {
      assert.equal(resumed.allowTools, true);
      assert.equal(resumed.model, 'local-model');
    }
  } finally {
    inferenceScheduler.scheduleInference = original;
  }

  // Same session, same context, in the right order: the interrupted turn is
  // re-driven first (its instruction was already in the context), then the
  // queued message gets its own turn.
  assert.deepEqual(rolesOf(payloads[1]), ['system', 'user'], 'the unfinished turn replays the original task');
  assert.equal(payloads[1].messages[1].content, 'Resume this task.');
  assert.ok(!JSON.stringify(payloads[1]).includes('extra note'),
    'the inbox message must not leak into the re-driven turn');
  assert.deepEqual(rolesOf(payloads[2]), ['system', 'user', 'assistant', 'user']);
  assert.equal(payloads[2].messages.at(-1).content, 'extra note');
  assert.deepEqual(listExecutions(session.id).map(execution => execution.status),
    ['interrupted', 'completed', 'completed']);
  assert.deepEqual(session.context.map(message => message.role),
    ['system', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(session.result, 'answered the note');
});

test('7. only the owning parent may control a child, and messages are validated', async () => {
  const { fetchImpl, payloads } = script([jsonResponse('done')]);
  await runtime.runInvestigation({
    task: 'Private task.', rootPath: process.cwd(), engine,
    parentSessionId: 'auth-parent', fetchImpl,
  });
  const session = childOf('auth-parent');

  assert.throws(() => runtime.sendMessage(session.id, 'sneaky', { parentSessionId: 'someone-else' }),
    /Only the owning parent session may control this child\./);
  assert.throws(() => runtime.sendMessage(session.id, 'sneaky'),
    /Only the owning parent session may control this child\./, 'a missing parent id is refused too');
  assert.throws(() => runtime.interrupt(session.id, { parentSessionId: 'someone-else' }),
    /Only the owning parent session may control this child\./);
  assert.throws(() => runtime.resume(session.id, { parentSessionId: 'someone-else' }),
    /Only the owning parent session may control this child\./);
  assert.throws(() => runtime.sendMessage('no-such-child', 'hi', { parentSessionId: 'auth-parent' }),
    /Unknown child session: no-such-child\./);
  assert.throws(() => runtime.sendMessage(session.id, '   ', { parentSessionId: 'auth-parent' }),
    /message must be a non-empty string of at most 8000 characters\./);
  assert.throws(() => runtime.sendMessage(session.id, 'x'.repeat(8001), { parentSessionId: 'auth-parent' }),
    /message must be a non-empty string of at most 8000 characters\./);

  // Every refused call left no trace: no inbox entry, no wake, no new turn.
  await delay(20);
  assert.equal(session.inbox.length, 0);
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(payloads.length, 1, 'no inference may follow a refused control call');
});

test('8. continuation keeps prior tool results, offers only the allowlist, and never parent history', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-context-'));
  try {
    await fs.writeFile(path.join(rootPath, 'notes.txt'), 'CONTINUATION MARKER');
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'notes.txt' })]),
      jsonResponse('First findings.'),
      toolResponse([toolCall('c2', 'read_project_file', { relative_path: 'notes.txt' })]),
      jsonResponse('Final findings.'),
    ]);
    await runtime.runInvestigation({
      task: 'Investigate notes.', rootPath, engine,
      parentSessionId: 'ctx-keep', fetchImpl,
      parentMessages: [{ role: 'user', content: 'PARENT SECRET HISTORY' }],
    });
    const session = childOf('ctx-keep');
    assert.deepEqual(session.context.map(message => message.role),
      ['system', 'user', 'assistant', 'tool', 'assistant']);

    runtime.sendMessage(session.id, 'keep digging', { parentSessionId: 'ctx-keep' });
    await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
      'the continued child never finished');

    // The continuation payload starts from the committed prefix: the original
    // tool result is still there, followed by the new instruction.
    assert.equal(payloads.length, 4);
    assert.deepEqual(rolesOf(payloads[2]),
      ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    assert.match(payloads[2].messages[3].content, /CONTINUATION MARKER/,
      'the prior tool result survives into the next turn');
    assert.equal(payloads[2].messages[5].content, 'keep digging');
    // Same read-only allowlist on resumed turns, offered through the payload.
    assert.deepEqual(toolNamesIn(payloads[2]), [...CHILD_TOOL_NAMES].sort());
    assert.equal(payloads[2].tool_choice, 'auto');
    assert.deepEqual(rolesOf(payloads[3]),
      ['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool']);
    // Nothing of the parent's conversation ever appears on the wire.
    assert.ok(!JSON.stringify(payloads).includes('PARENT SECRET HISTORY'));
    assert.deepEqual(session.context.map(message => message.role),
      ['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('9. interrupt frees the lane and the child stays resumable', async () => {
  const model = parkingModel();
  const turn = runtime.runInvestigation({
    task: 'Interrupt me.', rootPath: process.cwd(), engine,
    parentSessionId: 'int-lane', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const session = childOf('int-lane');
  runtime.interrupt(session.id, { parentSessionId: 'int-lane' });
  await assert.rejects(turn, { name: 'AbortError' });
  assert.equal(model.active, 0, 'the aborted inference released its scheduler slot');

  // The lane serves the next generation immediately: a leaked slot would make
  // this queue forever instead of finishing.
  const other = await withTimeout(runtime.runInvestigation({
    task: 'next', rootPath: process.cwd(), engine,
    parentSessionId: 'int-lane-next',
    fetchImpl: async () => jsonResponse('slot released'),
  }), 'the interrupted child kept its scheduler slot');
  assert.equal(other, 'slot released');

  // Distinct from cancellation: the same child resumes afterwards.
  const resume = runtime.resume(session.id, { parentSessionId: 'int-lane' });
  assert.equal(resume.resumed, true);
  await until(() => model.requests.length === 2, 'the resumed turn never started');
  model.requests[1].release('resumed answer');
  await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED,
    'the interrupted child never resumed');
  assert.equal(session.result, 'resumed answer');
  assert.deepEqual(listExecutions(session.id).map(execution => execution.status),
    ['interrupted', 'completed']);
  assert.equal(model.active, 0);
});

test('10. cancellation stays terminal: a cancelled child cannot be messaged or resumed', async () => {
  const model = parkingModel();
  const handle = runtime.startInvestigation({
    task: 'Doomed background task.', rootPath: process.cwd(), engine,
    parentSessionId: 'cancel-vs-int', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const session = sessionManager.getSession(handle.childSessionId);

  const cancelled = nextLifecycle('cancelled', handle.executionId);
  assert.equal(runtime.cancelBackground(handle.executionId), true);
  await cancelled;
  assert.equal(session.status, sessionManager.SESSION_STATUS.CANCELLED);
  assert.equal(model.requests[0].settled, true);
  assert.equal(model.active, 0);

  assert.throws(() => runtime.sendMessage(session.id, 'anyone there?', { parentSessionId: 'cancel-vs-int' }),
    /is cancelled and cannot be messaged\./);
  assert.throws(() => runtime.resume(session.id, { parentSessionId: 'cancel-vs-int' }),
    /is cancelled and cannot be resumed\./);
  assert.throws(() => runtime.interrupt(session.id, { parentSessionId: 'cancel-vs-int' }),
    /is cancelled and cannot be interrupted\./);
  await delay(20);
  assert.equal(session.inbox.length, 0, 'a refused call never queues anything');
  assert.equal(model.requests.length, 1, 'a terminal child never generates again');
});

test('11. a message continues a background child, reported on backgroundEvents', async () => {
  const model = parkingModel();
  const payloads = [];
  const fetchImpl = (url, options) => {
    payloads.push(JSON.parse(options.body));
    return model.fetch(url, options);
  };
  const seen = { started: [], completed: [] };
  const listeners = {
    started: payload => seen.started.push(payload),
    completed: payload => seen.completed.push(payload),
  };
  runtime.backgroundEvents.on('started', listeners.started);
  runtime.backgroundEvents.on('completed', listeners.completed);
  try {
    const handle = runtime.startInvestigation({
      task: 'Background task.', rootPath: process.cwd(), engine,
      parentSessionId: 'bg-msg', fetchImpl,
    });
    const session = sessionManager.getSession(handle.childSessionId);
    await until(() => model.requests.length === 1, 'the background child never reached the model');

    const result = runtime.sendMessage(handle.childSessionId, 'more work', { parentSessionId: 'bg-msg' });
    assert.deepEqual(result,
      { childSessionId: handle.childSessionId, status: sessionManager.SESSION_STATUS.RUNNING, pending: 1 });

    const firstDone = nextLifecycle('completed', handle.executionId);
    model.requests[0].release('background first');
    await firstDone;
    await until(() => model.requests.length === 2, 'the driven turn never started');
    model.requests[1].release('background second');
    await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
      'the continued background child never finished');

    assert.equal(session.result, 'background second');
    assert.equal(payloads[1].messages.at(-1).content, 'more work');
    const mine = list => list.filter(payload => payload.childSessionId === handle.childSessionId);
    assert.equal(mine(seen.started).length, 2, 'started: first turn + driven turn');
    assert.equal(mine(seen.completed).length, 2, 'completed: first turn + driven turn');
  } finally {
    runtime.backgroundEvents.removeListener('started', listeners.started);
    runtime.backgroundEvents.removeListener('completed', listeners.completed);
  }
});

test('12. a failed resumed turn settles as failed and never leaks its scheduler slot', async () => {
  const model = parkingModel();
  const turn = runtime.runInvestigation({
    task: 'Fail on resume.', rootPath: process.cwd(), engine,
    parentSessionId: 'resume-fail', fetchImpl: model.fetch,
  });
  await until(() => model.requests.length === 1, 'the child never reached the model');
  const session = childOf('resume-fail');
  runtime.interrupt(session.id, { parentSessionId: 'resume-fail' });
  await assert.rejects(turn, { name: 'AbortError' });

  runtime.resume(session.id, { parentSessionId: 'resume-fail' });
  await until(() => model.requests.length === 2, 'the resumed turn never started');
  model.requests[1].release(new Response('server body', { status: 500 }));
  await until(() => session.status === sessionManager.SESSION_STATUS.FAILED,
    'the failing resumed turn never settled');
  assert.match(session.error, /HTTP 500/);
  assert.deepEqual(listExecutions(session.id).map(execution => execution.status),
    ['interrupted', 'failed']);

  // A failed child is terminal: no more messages, no resume.
  assert.throws(() => runtime.sendMessage(session.id, 'again', { parentSessionId: 'resume-fail' }),
    /is failed and cannot be messaged\./);
  assert.throws(() => runtime.resume(session.id, { parentSessionId: 'resume-fail' }),
    /is failed and cannot be resumed\./);

  // And its slot came back: the lane serves the next run immediately.
  const recovery = await withTimeout(runtime.runInvestigation({
    task: 'recover', rootPath: process.cwd(), engine,
    parentSessionId: 'resume-fail-recover',
    fetchImpl: async () => jsonResponse('lane healthy'),
  }), 'the failed resumed turn leaked its scheduler slot');
  assert.equal(recovery, 'lane healthy');
});

test('13. resume with nothing pending is a safe no-op', async () => {
  const { fetchImpl, payloads } = script([jsonResponse('answer')]);
  await runtime.runInvestigation({
    task: 'Quick answer.', rootPath: process.cwd(), engine,
    parentSessionId: 'resume-noop', fetchImpl,
  });
  const session = childOf('resume-noop');

  const result = runtime.resume(session.id, { parentSessionId: 'resume-noop' });
  assert.deepEqual(result,
    { childSessionId: session.id, status: sessionManager.SESSION_STATUS.COMPLETED, resumed: false });
  await delay(30);
  assert.equal(payloads.length, 1, 'resume must not invent a task out of thin air');
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(session.inbox.length, 0);
});

test('14. interrupting a waiting child stops its scheduled driver turn until resume', async () => {
  const { fetchImpl, payloads } = script([jsonResponse('first'), jsonResponse('after resume')]);
  await runtime.runInvestigation({
    task: 'About to be interrupted.', rootPath: process.cwd(), engine,
    parentSessionId: 'wait-int', fetchImpl,
  });
  const session = childOf('wait-int');

  runtime.sendMessage(session.id, 'never processed', { parentSessionId: 'wait-int' });
  assert.equal(session.status, sessionManager.SESSION_STATUS.WAITING);
  const result = runtime.interrupt(session.id, { parentSessionId: 'wait-int' });
  assert.deepEqual(result,
    { childSessionId: session.id, status: sessionManager.SESSION_STATUS.INTERRUPTED, interrupted: true });

  // The driver was already scheduled — it must refuse to start.
  await delay(30);
  assert.equal(payloads.length, 1, 'the scheduled driver must not run an interrupted child');
  assert.equal(session.status, sessionManager.SESSION_STATUS.INTERRUPTED);
  assert.equal(session.inbox.length, 1, 'the message survives for after the resume');
  assert.equal(continuationManager.getRecord(session.id).pendingContinuation, false,
    'the first turn had finished; there is nothing to re-drive');

  const resume = runtime.resume(session.id, { parentSessionId: 'wait-int' });
  assert.equal(resume.resumed, true);
  await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
    'the inbox never drained after resume');
  assert.equal(payloads.length, 2);
  assert.deepEqual(rolesOf(payloads[1]), ['system', 'user', 'assistant', 'user']);
  assert.equal(payloads[1].messages.at(-1).content, 'never processed');
});

test('15. one-shot file-analysis children are not continuable', async () => {
  const output = await runtime.runFileAnalysis({
    task_description: 'Analyze the file.', target_files: [], rootPath: process.cwd(), engine,
    parentSessionId: 'oneshot-msg',
    fetchImpl: async () => jsonResponse('analysis done'),
  });
  assert.equal(output, 'analysis done');
  const session = childOf('oneshot-msg');

  assert.throws(() => runtime.sendMessage(session.id, 'again', { parentSessionId: 'oneshot-msg' }),
    /only agent-loop children are continuable/);
  assert.throws(() => runtime.interrupt(session.id, { parentSessionId: 'oneshot-msg' }),
    /only agent-loop children are continuable/);
  assert.throws(() => runtime.resume(session.id, { parentSessionId: 'oneshot-msg' }),
    /only agent-loop children are continuable/);
  assert.equal(session.inbox.length, 0);
});

test('16. a resumed turn queues behind the parent generation on a capacity-1 lane', async () => {
  const { fetchImpl, payloads } = script([jsonResponse('child first'), jsonResponse('child second')]);
  await runtime.runInvestigation({
    task: 'Child task.', rootPath: process.cwd(), engine,
    parentSessionId: 'order-child', fetchImpl,
  });
  const session = childOf('order-child');

  // Occupy the only capacity-1 slot with the parent's own generation.
  const holder = parkingModel();
  const holderTurn = runtime.runFileAnalysis({
    task_description: 'holder', target_files: [], rootPath: process.cwd(), engine,
    parentSessionId: 'order-holder',
    fetchImpl: holder.fetch,
  });
  await until(() => holder.requests.length === 1, 'the parent generation never occupied the lane');

  const result = runtime.sendMessage(session.id, 'queued work', { parentSessionId: 'order-child' });
  assert.equal(result.status, sessionManager.SESSION_STATUS.WAITING);

  await until(() => session.status === sessionManager.SESSION_STATUS.RUNNING,
    'the driven turn never claimed the child');
  await delay(20);
  assert.equal(payloads.length, 1, 'the resumed turn must wait in the scheduler queue, not reach the model');
  assert.equal(session.status, sessionManager.SESSION_STATUS.RUNNING,
    'a queued turn owns the child without generating');

  // Release the holder: the lane frees and the queued turn runs.
  holder.requests[0].release('holder done');
  await withTimeout(holderTurn, 'the holder never finished');
  await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
    'the queued turn never ran after the lane freed');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].messages.at(-1).content, 'queued work');
});
