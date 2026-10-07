const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { listExecutions } = require('../src/main/subagents/executionStore');
const { executeSpawnSubagent } = require('../src/main/tools/subagent');

const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };
const jsonResponse = (content, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }], usage,
});
const fileRequest = (rootPath, overrides = {}) => ({
  task_description: 'Summarize', target_files: [], rootPath, engine, ...overrides,
});

test('every child session gets a unique id derived from its parent, never the parent id', async () => {
  const parent = 'session_parent_a';
  const fetchImpl = async () => jsonResponse('ok', { completion_tokens: 1 });
  const first = await runtime.runFileAnalysis(fileRequest(process.cwd(), { parentSessionId: parent, fetchImpl }));
  const second = await runtime.runFileAnalysis(fileRequest(process.cwd(), { parentSessionId: parent, fetchImpl }));
  assert.equal(first, 'ok');
  assert.equal(second, 'ok');
  const children = sessionManager.listChildren(parent);
  assert.equal(children.length, 2);
  const [a, b] = children;
  assert.notEqual(a.id, b.id);
  for (const child of children) {
    assert.ok(child.id.startsWith(`${parent}_child_`), `${child.id} should be derived from its parent`);
    assert.notEqual(child.id, parent);
  }
});

test('the child records its parent and siblings are enumerable per parent', async () => {
  const fetchImpl = async () => jsonResponse('ok');
  await runtime.runFileAnalysis(fileRequest(process.cwd(), { parentSessionId: 'session_tree', fetchImpl }));
  await runtime.runWebExtraction({ url: 'https://example.com', query: 'q?', engine, parentSessionId: 'session_tree',
    pageFetchImpl: async () => new Response('<article><p>Page body text.</p></article>', { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async () => jsonResponse('Page body text.') });
  await runtime.runFileAnalysis(fileRequest(process.cwd(), { parentSessionId: 'session_other', fetchImpl }));

  const children = sessionManager.listChildren('session_tree');
  assert.equal(children.length, 2);
  for (const child of children) assert.equal(child.parentSessionId, 'session_tree');
  assert.equal(sessionManager.listChildren('session_other').length, 1);
  // The relationship is also readable directly off the child record.
  for (const child of children) assert.equal(sessionManager.getSession(child.id), child);
});

test('a successful execution completes the session with result, usage, and exactly one execution', async () => {
  const parent = 'session_success';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const output = await runtime.runFileAnalysis(
    fileRequest(process.cwd(), { parentSessionId: parent, fetchImpl: async () => jsonResponse('file summary', usage) }));
  assert.equal(output, 'file summary');

  const [session] = sessionManager.listChildren(parent);
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(session.result, 'file summary');
  assert.deepEqual(session.usage, usage);
  assert.equal(session.error, null);
  assert.ok(session.createdAt);
  assert.ok(session.startedAt);
  assert.ok(session.completedAt);
  assert.equal(typeof session.durationMs, 'number');

  // Session and execution are separate records: one attempt, linked to its session.
  const executions = listExecutions(session.id);
  assert.equal(executions.length, 1);
  const [execution] = executions;
  assert.equal(execution.sessionId, session.id);
  assert.equal(execution.kind, 'file-analysis');
  assert.equal(execution.status, 'completed');
  assert.equal(execution.result, 'file summary');
  assert.deepEqual(execution.usage, usage);
  assert.notEqual(execution.id, session.id);
});

test('a failed execution fails the session and rethrows the original error', async () => {
  const parent = 'session_fail';
  const fetchImpl = async () => new Response('server body', { status: 500 });
  await assert.rejects(
    runtime.runFileAnalysis(fileRequest(process.cwd(), { parentSessionId: parent, fetchImpl })),
    /Sub-agent request failed \(HTTP 500\)\./,
  );
  const [session] = sessionManager.listChildren(parent);
  assert.equal(session.status, sessionManager.SESSION_STATUS.FAILED);
  assert.match(session.error, /HTTP 500/);
  assert.equal(session.result, null);
  assert.ok(session.completedAt);
  const [execution] = listExecutions(session.id);
  assert.equal(execution.status, 'failed');
  assert.match(execution.error, /HTTP 500/);
});

test('cancellation ends both the session and the execution as cancelled', async () => {
  const parent = 'session_cancel';
  const controller = new AbortController();
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort();
  });
  await assert.rejects(
    runtime.runFileAnalysis(fileRequest(process.cwd(), { parentSessionId: parent, signal: controller.signal, fetchImpl })),
    { name: 'AbortError' },
  );
  const [session] = sessionManager.listChildren(parent);
  assert.equal(session.status, sessionManager.SESSION_STATUS.CANCELLED);
  const [execution] = listExecutions(session.id);
  assert.equal(execution.status, 'cancelled');
});

test('usage is associated with the child session when the provider reports it', async () => {
  const parent = 'session_usage';
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
  await runtime.runWebExtraction({ url: 'https://example.com', query: 'When?', engine, parentSessionId: parent,
    pageFetchImpl: async () => new Response('<article><p>Launch is on 1 October.</p></article>', { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async () => jsonResponse('1 October', usage) });
  const [session] = sessionManager.listChildren(parent);
  assert.equal(session.status, 'completed');
  assert.deepEqual(session.usage, usage);
  const [execution] = listExecutions(session.id);
  assert.equal(execution.kind, 'web-extraction');
  assert.deepEqual(execution.usage, usage);
});

test('each spawn_sub_agent call opens its own completed child session end to end', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-spawn-session-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'E2E summary', finish_reason: 'stop' } }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'E2E FILE TEXT');
    const live = { ...engine, port: server.address().port };
    const parent = 'session_spawn_e2e';
    const first = await executeSpawnSubagent({ task: 'Summarize the file', target_file: path.join(rootPath, 'a.txt'),
      engine: live, parentSessionId: parent });
    const second = await executeSpawnSubagent({ task: 'Summarize the file', target_file: path.join(rootPath, 'a.txt'),
      engine: live, parentSessionId: parent });
    assert.equal(first, 'E2E summary');
    assert.equal(second, 'E2E summary');

    const children = sessionManager.listChildren(parent);
    assert.equal(children.length, 2);
    const [a, b] = children;
    assert.notEqual(a.id, b.id);
    assert.ok(a.id.startsWith(`${parent}_child_`));
    for (const child of children) {
      assert.equal(child.status, 'completed');
      assert.equal(child.model, 'local-model');
      assert.equal(child.result, 'E2E summary');
      assert.equal(child.usage.completion_tokens, 3);
      assert.equal(listExecutions(child.id).length, 1);
    }
    // Existing request shape is unchanged: isolated, tool-free, one file injected.
    assert.equal(requests.length, 2);
    for (const payload of requests) {
      assert.equal(payload.messages.length, 2);
      assert.equal(payload.stream, false);
      assert.deepEqual(payload.tools, []);
      assert.equal(payload.tool_choice, 'none');
      assert.match(payload.messages[1].content, /\[FILE: .*a\.txt\]\nE2E FILE TEXT\n\[END FILE\]/);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('a session starts in created and moves to running before it reaches a terminal state', () => {
  const session = sessionManager.createSession({ parentSessionId: 'session_lifecycle' });
  try {
    assert.equal(session.status, sessionManager.SESSION_STATUS.CREATED);
    assert.equal(session.startedAt, null);
    sessionManager.startSession(session);
    assert.equal(session.status, sessionManager.SESSION_STATUS.RUNNING);
    assert.ok(session.startedAt);
    // Starting twice must not reset the start time or leave the lifecycle.
    const startedAt = session.startedAt;
    sessionManager.startSession(session);
    assert.equal(session.status, sessionManager.SESSION_STATUS.RUNNING);
    assert.equal(session.startedAt, startedAt);
  } finally {
    sessionManager.completeSession(session, { usage: null, result: 'done' });
  }
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(session.result, 'done');
});
