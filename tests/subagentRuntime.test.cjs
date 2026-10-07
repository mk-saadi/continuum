const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { scheduleInference } = require('../src/main/subagents/inferenceScheduler');
const { chatCompletion } = require('../src/main/subagents/providers/localProvider');
const runner = require('../src/main/subAgentRunner');

const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };
const jsonResponse = (content, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }], usage,
});

test('local provider posts one non-streaming tool-free request to the local server', async () => {
  let seen;
  const fetchImpl = async (url, options) => { seen = { url: String(url), options }; return jsonResponse('ok'); };
  const reply = await chatCompletion({
    engine,
    payload: { model: engine.modelId, messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 1024 },
    fetchImpl,
  });
  assert.equal(seen.url, 'http://127.0.0.1:4321/v1/chat/completions');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen.options.body);
  assert.equal(body.stream, false);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, 'none');
  assert.equal(body.model, 'local-model');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 1024);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.choices[0].message.content, 'ok');
});

test('local provider reports HTTP failures without parsing the error body', async () => {
  const fetchImpl = async () => new Response('Do not leak this server body', { status: 500 });
  const reply = await chatCompletion({ engine, payload: { model: 'm', messages: [] }, fetchImpl });
  assert.deepEqual(reply, { ok: false, status: 500 });
});

test('the inference scheduler forwards exactly one execution to the provider', async () => {
  let calls = 0;
  const reply = await scheduleInference({
    engine,
    payload: { model: 'm', messages: [] },
    fetchImpl: async url => {
      calls++;
      assert.equal(String(url), 'http://127.0.0.1:4321/v1/chat/completions');
      return jsonResponse('scheduled');
    },
  });
  assert.equal(calls, 1);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.choices[0].message.content, 'scheduled');
});

test('each execution runs in its own child session with recorded lifecycle and usage', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-runtime-'));
  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'FILE TEXT');
    const payloads = [];
    const fetchImpl = async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return jsonResponse('file summary', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    };
    const request = { task_description: 'Summarize', target_files: ['a.txt'], rootPath, engine, fetchImpl };
    const first = await runtime.runFileAnalysis({ ...request, parentSessionId: 'parent-one', agentId: 'tester' });
    const second = await runtime.runFileAnalysis({ ...request, parentSessionId: 'parent-one', agentId: 'tester' });
    assert.equal(first, 'file summary');
    assert.equal(second, 'file summary');
    const sessions = sessionManager.listSessions().filter(item => item.parentSessionId === 'parent-one');
    assert.equal(sessions.length, 2);
    const [a, b] = sessions;
    assert.notEqual(a.id, b.id);
    for (const session of sessions) {
      assert.equal(session.status, 'completed');
      assert.equal(session.model, 'local-model');
      assert.equal(session.agentId, 'tester');
      assert.equal(session.usage.completion_tokens, 5);
      assert.ok(session.createdAt);
      assert.ok(session.completedAt);
      assert.equal(session.error, null);
      assert.equal(sessionManager.getSession(session.id), session);
    }
    // The request stays isolated: two messages, no tools, no parent history.
    const payload = payloads[0];
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.tool_choice, 'none');
    assert.match(payload.messages[1].content, /\[FILE: a\.txt\]\nFILE TEXT\n\[END FILE\]/);
    assert.ok(!JSON.stringify(payload).includes('MAIN HISTORY'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('a failed execution is recorded on the session and the original error is rethrown', async () => {
  const fetchImpl = async () => new Response('server body', { status: 500 });
  await assert.rejects(
    runtime.runFileAnalysis({ task_description: 'x', target_files: [], rootPath: process.cwd(), engine,
      parentSessionId: 'parent-fail', fetchImpl }),
    /Sub-agent request failed \(HTTP 500\)\./,
  );
  const session = sessionManager.listSessions().find(item => item.parentSessionId === 'parent-fail');
  assert.equal(session.status, 'failed');
  assert.match(session.error, /HTTP 500/);
  assert.ok(session.completedAt);
});

test('cancellation aborts mid-request and records the session as cancelled', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort();
  });
  await assert.rejects(
    runtime.runFileAnalysis({ task_description: 'x', target_files: [], rootPath: process.cwd(), engine,
      parentSessionId: 'parent-abort', signal: controller.signal, fetchImpl }),
    { name: 'AbortError' },
  );
  const session = sessionManager.listSessions().find(item => item.parentSessionId === 'parent-abort');
  assert.equal(session.status, 'cancelled');
});

test('malformed input is rejected before any model request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse('x'); };
  const base = { rootPath: process.cwd(), engine, fetchImpl };
  await assert.rejects(runtime.runFileAnalysis({ ...base, task_description: '', target_files: [] }), /non-empty/);
  await assert.rejects(runtime.runFileAnalysis({ ...base, task_description: 'ok', target_files: [null] }), /up to 32 file paths/);
  await assert.rejects(runtime.runFileAnalysis({ ...base, task_description: 'ok', target_files: [], engine: null }), /Start the local model server/);
  await assert.rejects(runtime.runWebExtraction({ url: 'https://example.com', query: '', engine, fetchImpl }), /query must be/);
  assert.equal(calls, 0);
});

test('web extraction runs through the runtime with page text in an isolated request', async () => {
  let payload;
  const output = await runtime.runWebExtraction({
    url: 'https://example.com/story',
    query: 'When does it launch?',
    engine,
    parentSessionId: 'parent-web',
    pageFetchImpl: async () => new Response(
      '<article><p>Navigation filler</p><p>The launch date is 1 October.</p></article>',
      { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return jsonResponse('The launch date is 1 October.', { completion_tokens: 4 });
    },
  });
  assert.equal(output, 'The launch date is 1 October.');
  assert.equal(payload.temperature, 0);
  assert.equal(payload.max_tokens, 450);
  assert.equal(payload.stream, false);
  assert.deepEqual(payload.tools, []);
  assert.equal(payload.tool_choice, 'none');
  assert.match(payload.messages[1].content, /The launch date is 1 October/);
  assert.ok(!payload.messages[1].content.includes('Navigation filler'));
  const session = sessionManager.listSessions().find(item => item.parentSessionId === 'parent-web');
  assert.equal(session.status, 'completed');
  assert.equal(session.model, 'local-model');
  assert.equal(session.usage.completion_tokens, 4);
});

test('the legacy runSubAgent facade flows through the same runtime boundary', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-facade-'));
  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'LEGACY TEXT');
    let payload;
    const output = await runner.runSubAgent({
      task_description: 'Summarize', target_files: ['a.txt'], rootPath, engine, parentSessionId: 'parent-legacy',
      fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return jsonResponse('legacy summary'); },
    });
    assert.equal(output, 'legacy summary');
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.tool_choice, 'none');
    assert.match(payload.messages[1].content, /LEGACY TEXT/);
    const session = sessionManager.listSessions().find(item => item.parentSessionId === 'parent-legacy');
    assert.equal(session.status, 'completed');
    assert.equal(session.model, 'local-model');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
