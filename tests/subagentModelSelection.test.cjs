const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Step 7: the subagent architecture from Steps 1-6 connected to the
// application's real model selection. One app setting decides what a child
// runs on — null (follow the parent chat's model), the local model server, or
// a saved cloud provider — and it is resolved exactly once per child at the
// runtime boundary. Everything downstream is unchanged: the scheduler still
// decides when a generation may run (lanes are provider + model), the child
// keeps its read-only allowlist whatever model it runs on, and a model change
// only ever affects the next spawn.

// --- IPC composition root (same harness shape as cloudIpc.test.cjs) --------
// Every src/main module loads inside this mock window: db.js captures `app`
// from electron at require time, so initDatabase() only works when the mocked
// app.isReady() was in place while it loaded. The window closes right after —
// the tests themselves run against the (mostly real) cached modules.
const handlers = new Map();
const originalLoad = Module._load;
let memoryEnabled = true;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => global.fetch(...params) };
  if (name === './promptBuilder') return { ...originalLoad.call(this, name, ...args), buildSessionSystemPrompt: () => ({ role: 'system', content: memoryEnabled ? '[BACKGROUND KNOWLEDGE & USER PREFERENCES]\nSaved fact' : '', memoryContext: true }) };
  if (name === './profileSettings') return { getSessionSettings: () => ({ effective: { memoryEnabled }, params: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 } }) };
  if (name === './samplingManager') return { getGlobalSamplingParams: () => ({ temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 }) };
  if (name === 'electron') return { app: { isReady: () => true }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { listExecutions } = require('../src/main/subagents/executionStore');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');
const modelSelection = require('../src/main/subagents/modelSelection');
const cloudProviders = require('../src/main/cloudProviders');
const { executeSpawnSubagent, PARENT_RESULT_LIMIT } = require('../src/main/tools/subagent');
const { buildSessionSystemPrompt } = require('../src/main/promptBuilder');
const { db } = require('../src/main/db');
const mcpManager = require('../src/main/mcpManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
Module._load = originalLoad;

// --- Constants -------------------------------------------------------------
const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };
const engineConfig = { port: 8123, modelPath: '/models/loaded.gguf', activeModelConfig: { contextLength: 8192 } };
const CLOUD_TARGET = { type: 'cloud', provider: 'step7-cloud', model: 'cloud-child' };
const CLOUD_SELECTION = { type: 'cloud', provider: 'step7-cloud', model: 'cloud-child' };
// What a cloud chat hands its tools (ipcHandlers buildChatEngine).
const cloudParentEngine = { provider: 'cloud', modelId: 'cloud-child', chatTarget: CLOUD_TARGET };
// The local selection resolves to this shape through the engine config:
// { provider: 'local', port: 8123, modelId: '/models/loaded.gguf', contextLength: 8192 }.

// --- Scripted / parked model endpoints -------------------------------------
const jsonResponse = (content, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }], usage,
});
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = (calls, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content: '', finish_reason: 'tool_calls', tool_calls: calls } }], usage,
});

const tick = () => new Promise(resolve => setImmediate(resolve));

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
 * child mid-turn (to interrupt it) or hold a lane (to observe queueing).
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

/** A fetch that must never be reached: any call fails the test loudly. */
function forbiddenFetch(label) {
  const calls = [];
  return { calls, fetchImpl: async (...args) => { calls.push(args); throw new Error(`${label} transport must not be used`); } };
}

// --- Cloud transport seam --------------------------------------------------
// The cloud provider builds its own transport from the saved provider and
// ignores a caller-supplied fetchImpl, so the stub replaces createCloudFetch
// on the module object (cloudProvider calls it through the module per request).
const originalCreateCloudFetch = cloudProviders.createCloudFetch;
let cloudTargets = [];
/** Accepts either a script ({ fetchImpl }) or a parking model ({ fetch }). */
function installCloud(transport) {
  const fetchImpl = transport.fetchImpl ?? transport.fetch;
  cloudTargets = [];
  cloudProviders.createCloudFetch = (target, options = {}) => {
    cloudTargets.push({ target, stream: options.stream });
    return (url, requestOptions) => fetchImpl(url, requestOptions);
  };
}
function uninstallCloud() {
  cloudProviders.createCloudFetch = originalCreateCloudFetch;
  cloudTargets = [];
}

// --- Selection helpers -----------------------------------------------------
const setSelection = value => modelSelection.saveSubagentModel(value);
const clearSelection = () => modelSelection.saveSubagentModel(null);
const childOf = parentSessionId => {
  const [session] = sessionManager.listChildren(parentSessionId);
  assert.ok(session, `no child session was created for ${parentSessionId}`);
  return session;
};
const toolNamesIn = payload => payload.tools.map(tool => tool.function.name).sort();
const nextLifecycle = (type, executionId, ms = 2000) => new Promise((resolve, reject) => {
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

// --- Suite fixtures --------------------------------------------------------
let directory;
let originalInit;
let originalReload;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-model-'));
  require('../src/main/db').initDatabase(directory);
  // The one saved cloud provider the selection validates against. Nothing in
  // the runtime hard-codes it: it comes from the same registry the chat uses.
  cloudProviders.saveCloudProvider({
    id: 'step7-cloud', name: 'Step 7 Cloud', baseUrl: 'https://cloud.example/v1',
    modelId: 'cloud-child', apiKey: 'test-key', apiType: 'openai',
  });
  originalInit = mcpManager.init;
  originalReload = mcpManager.reload;
  mcpManager.init = mcpManager.reload = async () => {};
});

after(async () => {
  mcpManager.init = originalInit;
  mcpManager.reload = originalReload;
  modelSelection.setEngineConfigProvider(() => null);
  try { clearSelection(); } catch { /* the database may never have opened */ }
  uninstallCloud();
  try { require('../src/main/db').closeDatabase(); } catch { /* already closed */ }
  await fs.rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('1. the selection round-trips through its IPC channels and is validated', async () => {
  let engineConfigValue = null;
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  const event = { sender };
  const dispose = registerIpcHandlers({ isTrustedSender: () => true, getEngineConfig: () => engineConfigValue });
  try {
    // Default: no selection at all — children follow the parent chat's model.
    assert.equal(await handlers.get('subagent:get-model')(event), null);

    assert.deepEqual(await handlers.get('subagent:save-model')(event, { type: 'local' }), { type: 'local' });
    assert.deepEqual(await handlers.get('subagent:get-model')(event), { type: 'local' });

    assert.deepEqual(await handlers.get('subagent:save-model')(event, CLOUD_SELECTION), CLOUD_SELECTION);
    assert.deepEqual(await handlers.get('subagent:get-model')(event), CLOUD_SELECTION);

    // Validation reuses the chat's own provider check: unknown provider and
    // known-provider/wrong-model are both refused.
    await assert.rejects(
      handlers.get('subagent:save-model')(event, { type: 'cloud', provider: 'missing-provider', model: 'cloud-child' }),
      /Invalid chat provider\. Select a saved provider and model\./);
    await assert.rejects(
      handlers.get('subagent:save-model')(event, { type: 'cloud', provider: 'step7-cloud', model: 'other-model' }),
      /Invalid chat provider\. Select a saved provider and model\./);
    await assert.rejects(handlers.get('subagent:save-model')(event, 'local'),
      /must be null \(follow the chat model\)/);
    await assert.rejects(handlers.get('subagent:save-model')(event, { type: 'gpu' }),
      /Invalid sub-agent model selection/);

    // The rejected offers never replaced the good one...
    assert.deepEqual(await handlers.get('subagent:get-model')(event), CLOUD_SELECTION);
    // ...and clearing goes back to "follow the chat model".
    assert.equal(await handlers.get('subagent:save-model')(event, null), null);
    assert.equal(await handlers.get('subagent:get-model')(event), null);
  } finally {
    dispose();
    modelSelection.setEngineConfigProvider(() => null);
  }
});

test('2. with no setting a child inherits the parent chat model exactly', async () => {
  clearSelection();

  // local parent + local selection: the parent descriptor flows through.
  const local = script([jsonResponse('Local child answer.', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 })]);
  const output = await runtime.runInvestigation({
    task: 'Inherit locally.', rootPath: process.cwd(), engine,
    parentSessionId: 'sel-inherit-local', fetchImpl: local.fetchImpl,
  });
  assert.equal(output, 'Local child answer.');
  assert.equal(local.payloads[0].model, 'local-model', 'the child asked for the parent model');
  const localChild = childOf('sel-inherit-local');
  assert.equal(localChild.provider, 'local');
  assert.equal(localChild.providerId, null);
  assert.equal(localChild.model, 'local-model');

  // cloud parent + cloud selection: the cloud descriptor itself is inherited,
  // so "same model" needs no extra machinery — and the local transport of a
  // forwarded fetchImpl is still never asked to serve a cloud child.
  const cloud = script([jsonResponse('Cloud child answer.', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 })]);
  const forbidden = forbiddenFetch('local');
  installCloud(cloud);
  try {
    const answer = await runtime.runInvestigation({
      task: 'Inherit in the cloud.', rootPath: process.cwd(), engine: cloudParentEngine,
      parentSessionId: 'sel-inherit-cloud', fetchImpl: forbidden.fetchImpl,
    });
    assert.equal(answer, 'Cloud child answer.');
    assert.equal(forbidden.calls.length, 0, 'a cloud child never uses the forwarded local fetch');
    assert.equal(cloudTargets.length, 1);
    assert.deepEqual(cloudTargets[0].target, CLOUD_TARGET, 'the inherited target is the parent chat model');
    assert.equal(cloudTargets[0].stream, false, 'sub-agent requests are single non-streaming JSON');
    assert.equal(cloud.payloads[0].model, 'cloud-child');
    const cloudChild = childOf('sel-inherit-cloud');
    assert.equal(cloudChild.provider, 'cloud');
    assert.equal(cloudChild.providerId, 'step7-cloud');
    assert.equal(cloudChild.model, 'cloud-child');
  } finally {
    uninstallCloud();
  }
});

test('3. a cloud selection routes a local chat\'s child to the saved provider', async () => {
  setSelection(CLOUD_SELECTION);
  const local = forbiddenFetch('local');
  const cloud = script([jsonResponse('Routed to the cloud.', { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 })]);
  installCloud(cloud);
  try {
    const output = await runtime.runInvestigation({
      task: 'Override my model.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-cloud-override', fetchImpl: local.fetchImpl,
    });
    assert.equal(output, 'Routed to the cloud.');
    assert.equal(local.calls.length, 0, 'the parent chat\'s local transport was bypassed');
    assert.deepEqual(cloudTargets[0].target, CLOUD_TARGET);
    assert.equal(cloud.payloads[0].model, 'cloud-child');

    // Minimal observability: the child record names provider, model, and
    // lifecycle — nothing more than the runtime already keeps.
    const session = childOf('sel-cloud-override');
    const snapshot = runtime.describeChild(session.id);
    assert.deepEqual(
      { childSessionId: snapshot.childSessionId, parentSessionId: snapshot.parentSessionId,
        provider: snapshot.provider, providerId: snapshot.providerId, model: snapshot.model,
        status: snapshot.status, turns: snapshot.turns, kind: snapshot.kind, background: snapshot.background },
      { childSessionId: session.id, parentSessionId: 'sel-cloud-override', provider: 'cloud',
        providerId: 'step7-cloud', model: 'cloud-child',
        status: sessionManager.SESSION_STATUS.COMPLETED, turns: 1,
        kind: 'investigation', background: false });
    assert.deepEqual(snapshot.usage, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 });
    assert.ok(!Number.isNaN(Date.parse(snapshot.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(snapshot.startedAt)));
    assert.ok(!Number.isNaN(Date.parse(snapshot.completedAt)));
    assert.equal(typeof snapshot.durationMs, 'number');
    assert.ok(snapshot.durationMs >= 0);
    assert.deepEqual(listExecutions(session.id).map(execution => `${execution.kind}:${execution.background}`),
      ['investigation:false']);
  } finally {
    uninstallCloud();
    clearSelection();
  }
});

test('4. a local selection overrides a cloud chat and fails loudly without a server', async () => {
  setSelection({ type: 'local' });
  modelSelection.setEngineConfigProvider(() => engineConfig);
  const cloud = forbiddenFetch('cloud');
  const local = parkingModel();
  installCloud(cloud);
  try {
    const run = runtime.runInvestigation({
      task: 'Override to local.', rootPath: process.cwd(), engine: cloudParentEngine,
      parentSessionId: 'sel-local-override', fetchImpl: local.fetch,
    });
    await until(() => local.requests.length === 1, 'the child never reached the local model server');
    assert.equal(local.requests[0].url, 'http://127.0.0.1:8123/v1/chat/completions',
      'the local selection resolves the running engine, not the parent\'s descriptor');
    assert.equal(local.requests[0].body.model, '/models/loaded.gguf');
    local.requests[0].release('Server child answer.');
    assert.equal(await withTimeout(run, 'the local child never finished'), 'Server child answer.');
    assert.equal(cloud.calls.length, 0, 'a local child never touches the cloud transport');
    const session = childOf('sel-local-override');
    assert.equal(session.provider, 'local');
    assert.equal(session.providerId, null);
    assert.equal(session.model, '/models/loaded.gguf');

    // Local selected but no engine config wired (headless/no server): the
    // child refuses to start with the existing local error text.
    modelSelection.setEngineConfigProvider(() => null);
    await assert.rejects(runtime.runInvestigation({
      task: 'No server.', rootPath: process.cwd(), engine: cloudParentEngine,
      parentSessionId: 'sel-local-noserver', fetchImpl: local.fetch,
    }), /Start the local model server before delegating a task\./);
    assert.equal(sessionManager.listChildren('sel-local-noserver').length, 0,
      'a child never opens without a resolvable model');

    // A saved cloud selection whose provider is no longer valid fails at the
    // same boundary, loudly, instead of routing to the wrong model.
    setSelection({ type: 'cloud', provider: 'step7-cloud', model: 'cloud-child' });
    db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('subagentModel', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(JSON.stringify({ type: 'cloud', provider: 'deleted-provider', model: 'gone' }));
    await assert.rejects(runtime.runInvestigation({
      task: 'Ghost provider.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-ghost', fetchImpl: local.fetch,
    }), /Invalid chat provider\. Select a saved provider and model\./);
    assert.equal(sessionManager.listChildren('sel-ghost').length, 0);
  } finally {
    modelSelection.setEngineConfigProvider(() => null);
    uninstallCloud();
    clearSelection();
  }
});

test('5. an unreadable stored selection fails at spawn, never silently', async () => {
  db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('subagentModel', ?) "
    + 'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run('not-json');
  try {
    const local = forbiddenFetch('local');
    await assert.rejects(runtime.runInvestigation({
      task: 'Broken setting.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-broken', fetchImpl: local.fetchImpl,
    }), /not readable\. Choose the model again in Settings\./);
    assert.equal(local.calls.length, 0, 'no inference happens when the model cannot be resolved');
    assert.equal(sessionManager.listChildren('sel-broken').length, 0);
  } finally {
    clearSelection();
  }
});

test('6. foreground, messages, and background runs all keep the one resolved model', async () => {
  setSelection(CLOUD_SELECTION);
  const forbidden = forbiddenFetch('local');
  const fg = script([
    jsonResponse('First answer.', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }),
    jsonResponse('Second answer.', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
  ]);
  installCloud(fg);
  try {
    // Foreground turn.
    const first = await runtime.runInvestigation({
      task: 'Keep my model.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-continuity', fetchImpl: forbidden.fetchImpl,
    });
    assert.equal(first, 'First answer.');
    const session = childOf('sel-continuity');

    // sendMessage drives the next turn through the continuation record, which
    // holds the engine resolved at spawn — the model must not change.
    const queued = runtime.sendMessage(session.id, 'and again', { parentSessionId: 'sel-continuity' });
    assert.equal(queued.pending, 1);
    await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED && !session.inbox.length,
      'the messaged child never finished its turn');
    assert.equal(session.result, 'Second answer.');
    assert.deepEqual(session.usage, { prompt_tokens: 16, completion_tokens: 6, total_tokens: 22 },
      'usage accumulates across turns of the same child');
    assert.equal(fg.payloads.length, 2);
    for (const payload of fg.payloads) assert.equal(payload.model, 'cloud-child');
    assert.equal(cloudTargets.length, 2, 'both turns went through the cloud transport');
    for (const target of cloudTargets) assert.deepEqual(target.target, CLOUD_TARGET);
    assert.equal(forbidden.calls.length, 0, 'no path fell back to the parent chat\'s transport');
    assert.equal(session.model, 'cloud-child', 'the child record never changed model');

    // A detached run of the same selection behaves identically.
    const bg = parkingModel();
    installCloud(bg);
    const handle = runtime.startInvestigation({
      task: 'Background on the same model.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-continuity-bg', fetchImpl: forbidden.fetchImpl,
    });
    const done = nextLifecycle('completed', handle.executionId);
    await until(() => bg.requests.length === 1, 'the background child never reached the cloud');
    assert.deepEqual(bg.requests[0].body.model, 'cloud-child');
    bg.requests[0].release('Background answer.');
    await done;
    const bgSession = sessionManager.getSession(handle.childSessionId);
    assert.equal(bgSession.result, 'Background answer.');
    assert.equal(bgSession.provider, 'cloud');
    assert.equal(bgSession.model, 'cloud-child');
    const snapshot = runtime.describeChild(handle.childSessionId);
    assert.equal(snapshot.background, true);
    assert.equal(snapshot.turns, 1);
    assert.equal(forbidden.calls.length, 0);
  } finally {
    uninstallCloud();
    clearSelection();
  }
});

test('7. interrupt and resume keep the child on the model it started with', async () => {
  setSelection(CLOUD_SELECTION);
  const cloud = parkingModel();
  installCloud(cloud);
  try {
    const run = runtime.runInvestigation({
      task: 'Interrupt me.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-interrupt', fetchImpl: forbiddenFetch('local').fetchImpl,
    });
    await until(() => cloud.requests.length === 1, 'the child never reached the cloud model');
    const session = childOf('sel-interrupt');
    assert.equal(session.model, 'cloud-child');

    runtime.interrupt(session.id, { parentSessionId: 'sel-interrupt' });
    await assert.rejects(run, { name: 'AbortError' });
    assert.equal(cloud.requests[0].settled, true, 'the aborted inference released its scheduler slot');

    const resumed = runtime.resume(session.id, { parentSessionId: 'sel-interrupt' });
    assert.equal(resumed.resumed, true);
    await until(() => cloud.requests.length === 2, 'the resumed turn never started');
    assert.deepEqual(cloud.requests[1].body.model, 'cloud-child', 'resume reused the spawn-time model');
    assert.deepEqual(cloudTargets[1].target, CLOUD_TARGET);
    cloud.requests[1].release('Resumed answer.');
    await until(() => session.status === sessionManager.SESSION_STATUS.COMPLETED,
      'the interrupted child never resumed');
    assert.equal(session.result, 'Resumed answer.');
    assert.equal(session.model, 'cloud-child', 'interrupt/resume never switched models');
    assert.deepEqual(listExecutions(session.id).map(execution => execution.status),
      ['interrupted', 'completed']);
    assert.equal(cloud.active, 0, 'the lane slot was released');
  } finally {
    uninstallCloud();
    clearSelection();
  }
});

test('8. a cloud model still gets the read-only child allowlist', async () => {
  setSelection(CLOUD_SELECTION);
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-cloud-ro-'));
  const cloud = script([
    toolResponse([toolCall('c1', 'write_project_file', { relative_path: 'pwned.txt', content: 'owned' })],
      { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }),
    jsonResponse('No write capability is available.', { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }),
  ]);
  installCloud(cloud);
  try {
    const output = await runtime.runInvestigation({
      task: 'Write a file.', rootPath, engine,
      parentSessionId: 'sel-readonly', fetchImpl: forbiddenFetch('local').fetchImpl,
    });
    assert.equal(output, 'No write capability is available.');

    // The model only ever sees the read-only allowlist — cloud or not.
    assert.deepEqual(toolNamesIn(cloud.payloads[0]), [...CHILD_TOOL_NAMES].sort());
    assert.ok(!toolNamesIn(cloud.payloads[0]).includes('spawn_sub_agent'));
    assert.ok(!toolNamesIn(cloud.payloads[0]).includes('write_project_file'),
      'a forbidden tool is never advertised');
    assert.equal(cloud.payloads[0].tool_choice, 'auto');

    // The attempted write is rejected before execution and reported to the model.
    assert.deepEqual(cloud.payloads[1].messages.map(message => message.role),
      ['system', 'user', 'assistant', 'tool']);
    assert.match(cloud.payloads[1].messages[3].content, /is not available to this agent/);
    assert.ok(cloud.payloads[1].messages[3].content.includes(`Allowed tools: ${CHILD_TOOL_NAMES.join(', ')}.`));
    await assert.rejects(fs.access(path.join(rootPath, 'pwned.txt')), 'no file was written');

    const session = childOf('sel-readonly');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
    assert.equal(session.provider, 'cloud');
    assert.equal(session.model, 'cloud-child');
  } finally {
    uninstallCloud();
    clearSelection();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('9. the single local slot queues children resolved to the same server model', async () => {
  setSelection({ type: 'local' });
  modelSelection.setEngineConfigProvider(() => engineConfig);
  const cloud = forbiddenFetch('cloud');
  const local = parkingModel();
  installCloud(cloud);
  try {
    const first = runtime.startInvestigation({
      task: 'Slot holder.', rootPath: process.cwd(), engine: cloudParentEngine,
      parentSessionId: 'sel-slot-a', fetchImpl: local.fetch,
    });
    await until(() => local.requests.length === 1, 'the first child never reached the model server');

    const second = runtime.startInvestigation({
      task: 'Queued sibling.', rootPath: process.cwd(), engine: cloudParentEngine,
      parentSessionId: 'sel-slot-b', fetchImpl: local.fetch,
    });
    await tick();
    await tick();
    assert.equal(local.requests.length, 1,
      'the second child waits in the scheduler queue for the single local slot');

    const secondDone = nextLifecycle('completed', second.executionId);
    local.requests[0].release('Slot A done.');
    await until(() => local.requests.length === 2, 'the queued child never started after the slot freed');
    local.requests[1].release('Slot B done.');
    await secondDone;

    assert.equal(local.maxActive, 1, 'capacity 1 must never run two generations at once');
    for (const request of local.requests) {
      assert.equal(request.url, 'http://127.0.0.1:8123/v1/chat/completions');
      assert.equal(request.body.model, '/models/loaded.gguf');
    }
    assert.equal(cloud.calls.length, 0, 'a local selection never reaches the cloud transport');
    assert.equal(sessionManager.getSession(first.childSessionId).model, '/models/loaded.gguf');
    assert.equal(sessionManager.getSession(second.childSessionId).model, '/models/loaded.gguf');
  } finally {
    modelSelection.setEngineConfigProvider(() => null);
    uninstallCloud();
    clearSelection();
  }
});

test('10. mixed lanes run in parallel and a setting change only affects the next spawn', async () => {
  setSelection({ type: 'local' });
  modelSelection.setEngineConfigProvider(() => engineConfig);
  const local = parkingModel();
  const cloud = parkingModel();
  installCloud(cloud);
  try {
    // Child A resolves to the local server and holds the only local slot.
    const first = runtime.startInvestigation({
      task: 'Local lane.', rootPath: process.cwd(), engine: cloudParentEngine,
      parentSessionId: 'sel-mixed-local', fetchImpl: local.fetch,
    });
    await until(() => local.requests.length === 1, 'the local child never started');

    // The setting changes while A is mid-turn: it affects the next spawn only.
    setSelection(CLOUD_SELECTION);
    const second = runtime.startInvestigation({
      task: 'Cloud lane.', rootPath: process.cwd(), engine,
      parentSessionId: 'sel-mixed-cloud', fetchImpl: local.fetch,
    });
    const secondDone = nextLifecycle('completed', second.executionId);
    await until(() => cloud.requests.length === 1, 'the cloud child never started on its own lane');
    assert.deepEqual(cloud.requests[0].body.model, 'cloud-child');
    assert.equal(local.requests.length, 1, 'the busy local lane did not block the cloud lane');

    cloud.requests[0].release('Cloud answer.');
    await secondDone;
    assert.equal(sessionManager.getSession(second.childSessionId).result, 'Cloud answer.');
    assert.equal(sessionManager.getSession(first.childSessionId).status,
      sessionManager.SESSION_STATUS.RUNNING,
      'a finished cloud child must not disturb the still-parked local one');
    assert.equal(sessionManager.getSession(first.childSessionId).model, '/models/loaded.gguf',
      'changing the setting never re-models a live child');

    const firstDone = nextLifecycle('completed', first.executionId);
    local.requests[0].release('Local answer.');
    await firstDone;
    assert.equal(local.maxActive, 1);
    assert.equal(cloud.maxActive, 1);
    assert.equal(local.requests.length, 1, 'the cloud child never used the local transport');
  } finally {
    modelSelection.setEngineConfigProvider(() => null);
    uninstallCloud();
    clearSelection();
  }
});

test('11. the parent-facing result stays bounded while the child keeps the full answer', async () => {
  clearSelection();
  // Joined with single spaces: the agent loop trims the final answer, so the
  // stored child result is exactly this string (no trailing whitespace).
  const full = Array(80).fill('FINDING the cloud child retains everything it produced.').join(' ');
  assert.ok(full.length > PARENT_RESULT_LIMIT * 2);
  const cloud = script([jsonResponse(full, { prompt_tokens: 10, completion_tokens: 400, total_tokens: 410 })]);
  installCloud(cloud);
  try {
    const answer = await executeSpawnSubagent({
      task: 'Report everything you find.',
      investigate: true,
      rootPath: process.cwd(),
      engine: cloudParentEngine,
      parentSessionId: 'sel-parent-cap',
    });
    // What the parent pays in context: one short, clearly-marked summary.
    assert.equal(answer.length, PARENT_RESULT_LIMIT);
    assert.ok(answer.endsWith('[Summary truncated]'));
    assert.ok(answer.length < full.length);
    // What the child keeps: the complete findings, internally, intact.
    const session = childOf('sel-parent-cap');
    assert.equal(session.result, full, 'the full answer stays in the child session');
    assert.equal(session.context[session.context.length - 1].content, full,
      'the full answer stays in the continuation context');
    assert.equal(session.model, 'cloud-child');
  } finally {
    uninstallCloud();
  }
});

test('12. the chat engine descriptor keeps both chat types delegatable', () => {
  const { buildChatEngine } = modelSelection;
  assert.deepEqual(buildChatEngine({ cloud: false, config: engineConfig, modelId: 'local-model' }),
    { provider: 'local', port: 8123, modelId: 'local-model', contextLength: 8192 });
  assert.deepEqual(buildChatEngine({ cloud: true, target: CLOUD_TARGET }), {
    provider: 'cloud',
    modelId: 'cloud-child',
    chatTarget: CLOUD_TARGET,
  }, 'a cloud chat carries its target so spawn_sub_agent stays available to it');
  assert.equal(buildChatEngine({ cloud: false, config: null, modelId: 'm' }), null);
});

test('13. the parent-facing protocol advertises the investigate invocation', () => {
  const prompt = buildSessionSystemPrompt({
    sessionId: null, modelId: 'local-model', delegationAvailable: true, userText: '',
  });
  assert.ok(prompt.content.includes('### Sub-Agent Delegation Protocol'));
  assert.ok(prompt.content.includes('Autonomous Investigation'),
    'the trigger bullet explains when to investigate');
  assert.ok(prompt.content.includes('call `spawn_sub_agent` with `investigate: true`'),
    'the trigger bullet names the exact flag');
  assert.ok(prompt.content.includes('exactly one of: a public URL'),
    'the invocation rule states investigate is exclusive with url/target_file');
  assert.ok(prompt.content.includes('Its tool set is fixed and read-only'),
    'the protocol promises the read-only guarantee');
  assert.ok(prompt.content.includes('"investigate": true,'),
    'the example invocation shows the flag');

  const withoutDelegation = buildSessionSystemPrompt({
    sessionId: null, modelId: 'local-model', delegationAvailable: false, userText: '',
  });
  assert.ok(!withoutDelegation.content.includes('### Sub-Agent Delegation Protocol'),
    'the protocol is only advertised when spawn_sub_agent is actually offered');
});
