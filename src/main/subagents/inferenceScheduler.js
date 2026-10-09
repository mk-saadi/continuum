'use strict';

const { resolveProvider } = require('./providers');

// The inference scheduler is the single place that decides when a model
// generation may run. It sits between an execution and its provider:
//
//   execution -> submit({ provider, model, maxConcurrency, task, signal })
//                    |
//                    +-- capacity free -> run task now (task = provider call)
//                    |
//                    +-- capacity used  -> enqueue in that provider/model's
//                                          FIFO queue, start when a slot frees
//
// Capacity belongs to a provider/model lane, never to a session: many logical
// sessions (main, child A, child B ...) can ask at any time, and the scheduler
// translates that into whatever inference capacity the provider/model exposes.
// Lanes are independent, so a busy local lane never blocks a cloud lane.
//
// The scheduler deliberately knows nothing about transport: it never builds a
// request, it only runs the `task` closure it is handed. Ordering is plain FIFO
// per lane — no priorities, weights, fairness, or routing in this step. This is
// an in-process coordination layer; queueing here does not make the caller's
// await return early — a queued caller simply waits for its turn.
//
// Slot ownership has exactly one path: start() increments `running` once per
// entry (the entry is shifted out of the queue first), and release() decrements
// it once per entry (guarded by `released`), then pumps the queue. Completion,
// failure, and cancellation of a running request all funnel through release(),
// so a slot can never stay occupied or go negative.

function normalizeMaxConcurrency(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function abortReason(signal) {
  return signal?.reason ?? Object.assign(new Error('The inference request was cancelled.'),
    { name: 'AbortError' });
}

function createInferenceScheduler() {
  // Minimal lane state, keyed by provider+model so queues are isolated:
  //   { maxConcurrency, running, queue: [] }
  const lanes = new Map();

  function laneFor({ provider, model, maxConcurrency }) {
    const key = `${provider}\u0000${model}`;
    let lane = lanes.get(key);
    if (!lane) {
      lane = { maxConcurrency: normalizeMaxConcurrency(maxConcurrency), running: 0, queue: [] };
      lanes.set(key, lane);
    } else {
      // The latest declaration for a lane is authoritative (e.g. a restarted
      // engine reporting a different slot count for the same provider/model).
      lane.maxConcurrency = normalizeMaxConcurrency(maxConcurrency);
    }
    return lane;
  }

  // The only caller that starts work. Synchronous and reentrancy-safe: it
  // increments `running` before any await, so two overlapping pumps can never
  // over-commit a lane, and each entry is started at most once.
  function pump(lane) {
    while (lane.running < lane.maxConcurrency && lane.queue.length > 0) {
      const entry = lane.queue.shift();
      if (entry.settled) continue; // already removed/cancelled: never start it
      start(lane, entry);
    }
  }

  function start(lane, entry) {
    entry.started = true;
    if (entry.signal && entry.onAbort) {
      // From here the task owns the signal (the provider's existing abort
      // mechanism); the scheduler only waits for the task to settle.
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = null;
    }
    lane.running += 1;
    let outcome;
    try {
      outcome = entry.task();
    } catch (error) {
      release(lane, entry, () => entry.reject(error));
      return;
    }
    Promise.resolve(outcome).then(
      value => release(lane, entry, () => entry.resolve(value)),
      error => release(lane, entry, () => entry.reject(error)),
    );
  }

  // One release per started entry: decrement, settle the caller, then schedule
  // the next queued request. Safe to call from simultaneous completions —
  // JavaScript runs these sequentially and the `released` flag makes each
  // decrement happen exactly once.
  function release(lane, entry, settle) {
    if (entry.released) return;
    entry.released = true;
    lane.running -= 1;
    if (lane.running < 0) lane.running = 0; // unreachable guard: never negative
    if (!entry.settled) {
      entry.settled = true;
      settle();
    }
    pump(lane);
  }

  // submit() -> Promise for this one inference. The caller awaits it normally;
  // if the slot is busy the promise simply settles later, when the queue
  // reaches it. A signal that fires while the entry is queued removes it from
  // the queue and rejects it without ever touching a slot.
  function submit({ provider, model, maxConcurrency, task, signal }) {
    if (typeof task !== 'function') throw new TypeError('Inference request requires a task.');
    if (typeof provider !== 'string' || !provider.trim() ||
        typeof model !== 'string' || !model.trim()) {
      throw new TypeError('Inference request requires a provider and a model id.');
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const lane = laneFor({ provider, model, maxConcurrency });
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject,
        started: false, settled: false, released: false, onAbort: null };
      if (signal && typeof signal.addEventListener === 'function') {
        entry.onAbort = () => {
          if (entry.started) return; // running: the task's own abort path settles it
          const index = lane.queue.indexOf(entry);
          if (index >= 0) lane.queue.splice(index, 1); // dequeue: never starts
          if (entry.settled) return;
          entry.settled = true;
          signal.removeEventListener('abort', entry.onAbort);
          entry.onAbort = null;
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      lane.queue.push(entry);
      pump(lane);
    });
  }

  return { submit };
}

// The scheduler shared by every subagent execution in this process. One local
// model server, one lane, one queue — and each queued caller still awaits its
// own result as before.
const defaultScheduler = createInferenceScheduler();

// Execution -> scheduler -> provider -> model. Resolves the provider and its
// capability from the execution's engine descriptor, then hands the scheduler a
// task closure that performs the actual generation through the provider. Both
// failure modes surface as clean rejections: an unknown provider or a missing
// model id is reported before anything is queued or sent.
//
// `allowTools` is a capability flag, not scheduling state: the scheduler still
// only gates when the generation may run. It is forwarded to the provider so
// the default request shape stays tool-free (see the local provider), and only
// the child agent loop — which must model tool calls across its turns — opts in.
async function scheduleInference({ engine, payload, signal, fetchImpl, recoverContext, allowTools = false }) {
  const provider = resolveProvider(engine);
  return defaultScheduler.submit({
    ...provider.capability(engine),
    signal,
    task: () => provider.chatCompletion({ engine, payload, signal, fetchImpl, recoverContext, allowTools }),
  });
}

module.exports = { scheduleInference, createInferenceScheduler };
