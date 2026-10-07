const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { listExecutions } = require('../src/main/subagents/executionStore');
const inferenceScheduler = require('../src/main/subagents/inferenceScheduler');
const { chatCompletion } = require('../src/main/subagents/providers/localProvider');
const { CHILD_AGENT_SYSTEM_PROMPT, CHILD_TOOL_NAMES, DEFAULT_MAX_TURNS } = require('../src/main/subagents/agentLoop');
const { executeSpawnSubagent } = require('../src/main/tools/subagent');

const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };

const jsonResponse = (content, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content, finish_reason: 'stop' } }], usage,
});
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = (calls, usage) => Response.json({
  choices: [{ message: { role: 'assistant', content: '', finish_reason: 'tool_calls', tool_calls: calls } }], usage,
});

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

const toolNamesIn = payload => payload.tools.map(tool => tool.function.name).sort();

test('1. a child finishes after one model response when no tools are needed', async () => {
  const { fetchImpl, payloads } = script([jsonResponse('Auth uses signed JWTs.', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 })]);
  const output = await runtime.runInvestigation({
    task: 'How does authentication work?', rootPath: process.cwd(), engine,
    parentSessionId: 'loop-single', fetchImpl,
  });
  assert.equal(output, 'Auth uses signed JWTs.');
  assert.equal(payloads.length, 1, 'exactly one inference turn');
  const [payload] = payloads;
  assert.equal(payload.stream, false);
  assert.equal(payload.messages.length, 2, 'only the system prompt and the task');
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, CHILD_AGENT_SYSTEM_PROMPT);
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'How does authentication work?');
  assert.equal(payload.tool_choice, 'auto');
  assert.deepEqual(toolNamesIn(payload), [...CHILD_TOOL_NAMES].sort(), 'the allowlisted schemas are offered');
  const [session] = sessionManager.listChildren('loop-single');
  assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  assert.equal(session.result, 'Auth uses signed JWTs.');
  assert.deepEqual(session.usage, { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 });
  const [execution] = listExecutions(session.id);
  assert.equal(execution.kind, 'investigation');
  assert.equal(execution.status, 'completed');
});

test('2. one tool call runs model -> read tool -> tool result -> model -> final answer', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-read-'));
  try {
    await fs.writeFile(path.join(rootPath, 'auth.md'), 'TOKEN_SECRET rotates daily.');
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'auth.md' })], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      jsonResponse('The token is rotated daily.', { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }),
    ]);
    const output = await runtime.runInvestigation({
      task: 'How often does the token rotate?', rootPath, engine,
      parentSessionId: 'loop-one-tool', fetchImpl,
    });
    assert.equal(output, 'The token is rotated daily.');
    assert.equal(payloads.length, 2);
    const second = payloads[1];
    assert.equal(second.messages.length, 4, 'system, user, assistant tool call, tool result');
    assert.deepEqual(second.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(second.messages[2].tool_calls[0].id, 'c1');
    assert.equal(second.messages[2].tool_calls[0].function.name, 'read_project_file');
    assert.equal(second.messages[3].tool_call_id, 'c1');
    assert.match(second.messages[3].content, /TOKEN_SECRET rotates daily/, 'the real file content reaches the model');
    const [session] = sessionManager.listChildren('loop-one-tool');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
    assert.deepEqual(session.usage, { prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 },
      'usage is summed across turns');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('3. multiple tool turns keep the child investigating until a final answer', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-multi-'));
  try {
    await fs.writeFile(path.join(rootPath, 'app.js'), 'const sessionToken = loadToken();');
    await fs.writeFile(path.join(rootPath, 'config.js'), 'tokenTtlSeconds = 3600;');
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'search_project_content', { query: 'token' })]),
      toolResponse([toolCall('c2', 'read_project_file', { relative_path: 'app.js' })]),
      toolResponse([toolCall('c3', 'read_project_file', { relative_path: 'config.js' })]),
      jsonResponse('Tokens load per request and live 3600 seconds.'),
    ]);
    const output = await runtime.runInvestigation({
      task: 'Investigate token handling.', rootPath, engine,
      parentSessionId: 'loop-multi', fetchImpl,
    });
    assert.equal(output, 'Tokens load per request and live 3600 seconds.');
    assert.equal(payloads.length, 4, 'search -> read -> read -> final means four inferences');
    const expectedTools = ['search_project_content', 'read_project_file', 'read_project_file'];
    for (let turn = 0; turn < expectedTools.length; turn += 1) {
      const payload = payloads[turn + 1];
      const expectedLength = 2 + (turn + 1) * 2;
      assert.equal(payload.messages.length, expectedLength, `turn ${turn + 2} carries the whole child history`);
      const assistant = payload.messages[payload.messages.length - 2];
      const tool = payload.messages[payload.messages.length - 1];
      assert.equal(assistant.role, 'assistant');
      assert.equal(assistant.tool_calls[0].function.name, expectedTools[turn]);
      assert.equal(tool.role, 'tool');
      assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
    }
    // Each turn's context includes the previous turns' real results.
    assert.match(payloads[1].messages[3].content, /matches/);
    assert.match(payloads[2].messages[5].content, /sessionToken/);
    assert.match(payloads[3].messages[7].content, /tokenTtlSeconds/);
    const [session] = sessionManager.listChildren('loop-multi');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('4. forbidden tools are rejected, never executed, and never advertised', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-allow-'));
  try {
    const { fetchImpl, payloads } = script([
      toolResponse([
        toolCall('c1', 'execute_command', { command: 'touch pwned.txt' }),
        toolCall('c2', 'write_project_file', { relative_path: 'written.txt', content: 'owned' }),
        toolCall('c3', 'spawn_sub_agent', { task: 'recurse' }),
      ]),
      jsonResponse('No forbidden capability is available.'),
    ]);
    const output = await runtime.runInvestigation({
      task: 'Try to escalate.', rootPath, engine,
      parentSessionId: 'loop-allowlist', fetchImpl,
    });
    assert.equal(output, 'No forbidden capability is available.');
    // Every request only ever advertises the allowlist.
    for (const payload of payloads) {
      for (const name of toolNamesIn(payload)) assert.ok(CHILD_TOOL_NAMES.includes(name), `${name} must not be offered`);
    }
    const second = payloads[1];
    assert.equal(second.messages.filter(message => message.role === 'tool').length, 3,
      'every rejected call still gets a protocol-valid tool result');
    assert.match(second.messages[3].content, /Tool "execute_command" is not available to this agent/);
    assert.match(second.messages[4].content, /Tool "write_project_file" is not available to this agent/);
    assert.match(second.messages[5].content, /Tool "spawn_sub_agent" is not available to this agent/);
    // Nothing actually ran.
    await assert.rejects(fs.stat(path.join(rootPath, 'pwned.txt')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(rootPath, 'written.txt')), /ENOENT/);
    const [session] = sessionManager.listChildren('loop-allowlist');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('5. the child context contains only its system prompt, task, and own tool history', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-iso-'));
  try {
    await fs.writeFile(path.join(rootPath, 'notes.txt'), 'CHILD OWN RESULT MARKER');
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'notes.txt' })]),
      jsonResponse('Isolated answer.'),
    ]);
    await runtime.runInvestigation({
      task: 'Isolation check task.',
      // Parent-side history must be unreachable: the runtime has no field for
      // it, and passing one anyway must have no effect on any request.
      parentMessages: [{ role: 'user', content: 'PARENT SECRET HISTORY' }],
      parentSessionId: 'loop-isolation', rootPath, engine, fetchImpl,
    });
    const wire = JSON.stringify(payloads);
    assert.ok(!wire.includes('PARENT SECRET HISTORY'), 'parent history must never reach a request');
    const [session] = sessionManager.listChildren('loop-isolation');
    assert.ok(session, 'the child session exists');
    const second = payloads[1];
    assert.deepEqual(second.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(second.messages[0].content, CHILD_AGENT_SYSTEM_PROMPT);
    assert.equal(second.messages[1].content, 'Isolation check task.');
    assert.match(second.messages[3].content, /CHILD OWN RESULT MARKER/, 'only its own tool results');
    assert.ok(!wire.includes('PARENT SECRET HISTORY'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('6. every child inference turn goes through the inference scheduler', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-sched-'));
  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'A');
    const original = inferenceScheduler.scheduleInference;
    const turns = [];
    inferenceScheduler.scheduleInference = options => {
      turns.push({ allowTools: options.allowTools, model: options.engine?.modelId });
      return original(options);
    };
    try {
      const { fetchImpl, payloads } = script([
        toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'a.txt' })]),
        toolResponse([toolCall('c2', 'list_directory', { relative_path: '.' })]),
        jsonResponse('Final.'),
      ]);
      await runtime.runInvestigation({
        task: 'Walk the scheduler.', rootPath, engine,
        parentSessionId: 'loop-scheduler', fetchImpl,
      });
      assert.equal(payloads.length, 3);
      assert.equal(turns.length, 3, 'one scheduler submission per model turn — never a direct provider call');
      for (const turn of turns) {
        assert.equal(turn.allowTools, true, 'the loop opts into tools through the scheduler');
        assert.equal(turn.model, 'local-model');
      }
    } finally {
      inferenceScheduler.scheduleInference = original;
    }
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('7. another session can take the model slot between child turns', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-conc-'));
  try {
    const order = [];
    const payloads = [];
    let other = null;
    const fetchImpl = async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      order.push(`child:${payloads.length}`);
      if (payloads.length === 1) {
        // Another session asks for inference while the child is mid-loop; the
        // capacity-1 lane must run it between the child's turns.
        other = runtime.runFileAnalysis({
          task_description: 'other', target_files: [], rootPath, engine,
          parentSessionId: 'loop-conc-other',
          fetchImpl: async () => { order.push('other'); return jsonResponse('other summary'); },
        });
      }
      return payloads.length === 1
        ? toolResponse([toolCall('c1', 'list_directory', { relative_path: '.' })])
        : jsonResponse('child done');
    };
    const output = await runtime.runInvestigation({
      task: 'Interleave me.', rootPath, engine,
      parentSessionId: 'loop-conc', fetchImpl,
    });
    assert.equal(output, 'child done');
    assert.equal(await other, 'other summary');
    assert.deepEqual(order, ['child:1', 'other', 'child:2'],
      'the slot must be released after child turn 1 so the queued session runs before child turn 2');
    for (const parent of ['loop-conc', 'loop-conc-other']) {
      const [session] = sessionManager.listChildren(parent);
      assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
    }
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('8. a failed read-only tool returns the error to the child model and the loop survives', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-fail-'));
  try {
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'read_project_file', { relative_path: 'missing.txt' })]),
      jsonResponse('The file is missing; answering from the task alone.'),
    ]);
    const output = await runtime.runInvestigation({
      task: 'Read a file that does not exist.', rootPath, engine,
      parentSessionId: 'loop-toolfail', fetchImpl,
    });
    assert.equal(output, 'The file is missing; answering from the task alone.');
    assert.equal(payloads.length, 2, 'a tool error continues the loop instead of crashing it');
    assert.match(payloads[1].messages[3].content, /^Error: FILE_NOT_FOUND/);
    const [session] = sessionManager.listChildren('loop-toolfail');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED, 'a child tool failure must not fail the session');
    assert.equal(session.error, null);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('9. cancellation stops the loop without starting another inference', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-cancel-'));
  try {
    const controller = new AbortController();
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      controller.abort(); // cancel while turn 1 is in flight
      return toolResponse([toolCall('c1', 'list_directory', { relative_path: '.' })]);
    };
    await assert.rejects(
      runtime.runInvestigation({
        task: 'Cancel me mid-loop.', rootPath, engine, signal: controller.signal,
        parentSessionId: 'loop-cancel', fetchImpl,
      }),
      { name: 'AbortError' },
    );
    assert.equal(requests, 1, 'no second inference may start after cancellation');
    const [session] = sessionManager.listChildren('loop-cancel');
    assert.equal(session.status, sessionManager.SESSION_STATUS.CANCELLED);
    const [execution] = listExecutions(session.id);
    assert.equal(execution.status, 'cancelled');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('10a. the inference-turn limit terminates a child that never answers', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-limitt-'));
  try {
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'list_directory', { relative_path: '.' })]),
      toolResponse([toolCall('c2', 'list_directory', { relative_path: '.' })]),
      toolResponse([toolCall('c3', 'list_directory', { relative_path: '.' })]),
    ]);
    await assert.rejects(
      runtime.runInvestigation({
        task: 'Loop forever.', rootPath, engine, maxTurns: 2,
        parentSessionId: 'loop-limit-turns', fetchImpl,
      }),
      /inference-turn limit \(2\)/,
    );
    assert.equal(payloads.length, 2, 'exactly maxTurns inferences are allowed');
    const [session] = sessionManager.listChildren('loop-limit-turns');
    assert.equal(session.status, sessionManager.SESSION_STATUS.FAILED);
    assert.match(session.error, /inference-turn limit/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('10b. the tool-call limit terminates a runaway tool chain', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-limitc-'));
  try {
    const { fetchImpl, payloads } = script([
      toolResponse([
        toolCall('c1', 'list_directory', { relative_path: '.' }),
        toolCall('c2', 'list_directory', { relative_path: '.' }),
      ]),
    ]);
    await assert.rejects(
      runtime.runInvestigation({
        task: 'Spam tools.', rootPath, engine, maxToolCalls: 1,
        parentSessionId: 'loop-limit-tools', fetchImpl,
      }),
      /tool-call limit \(1\)/,
    );
    assert.equal(payloads.length, 1);
    const [session] = sessionManager.listChildren('loop-limit-tools');
    assert.equal(session.status, sessionManager.SESSION_STATUS.FAILED);
    assert.match(session.error, /tool-call limit/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('10c. invalid loop limits are rejected before any model request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return jsonResponse('x'); };
  await assert.rejects(
    runtime.runInvestigation({ task: 'x', rootPath: process.cwd(), engine, maxTurns: 0, fetchImpl }),
    /maxTurns must be an integer from 1 to 100/,
  );
  await assert.rejects(
    runtime.runInvestigation({ task: 'x', rootPath: process.cwd(), engine, maxToolCalls: 'ten', fetchImpl }),
    /maxToolCalls must be an integer from 1 to 100/,
  );
  await assert.rejects(
    runtime.runInvestigation({ task: '', rootPath: process.cwd(), engine, fetchImpl }),
    /task must be a non-empty string/,
  );
  await assert.rejects(
    runtime.runInvestigation({ task: 'x', rootPath: process.cwd(), engine: null, fetchImpl }),
    /Start the local model server/,
  );
  assert.equal(requests, 0);
});

test('an inference failure propagates and leaves the scheduler slot usable', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-http-'));
  try {
    const broken = async () => new Response('server body', { status: 500 });
    await assert.rejects(
      runtime.runInvestigation({ task: 'x', rootPath, engine, parentSessionId: 'loop-http', fetchImpl: broken }),
      /Child agent request failed \(HTTP 500\)\./,
    );
    const [failed] = sessionManager.listChildren('loop-http');
    assert.equal(failed.status, sessionManager.SESSION_STATUS.FAILED);
    assert.match(failed.error, /HTTP 500/);
    // The failed turn released its slot: the next investigation runs normally.
    const output = await runtime.runInvestigation({
      task: 'recover', rootPath, engine, parentSessionId: 'loop-http-recover',
      fetchImpl: async () => jsonResponse('recovered'),
    });
    assert.equal(output, 'recovered');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("the child's web tool runs behind the existing SSRF validation", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-web-'));
  try {
    const { fetchImpl, payloads } = script([
      toolResponse([toolCall('c1', 'get_single_web_page_content', { url: 'http://127.0.0.1:8080/admin' })]),
      jsonResponse('Blocked, as expected.'),
    ]);
    const output = await runtime.runInvestigation({
      task: 'Fetch an internal page.', rootPath, engine,
      parentSessionId: 'loop-web', fetchImpl,
    });
    assert.equal(output, 'Blocked, as expected.');
    assert.equal(payloads.length, 2);
    // The child reaches the *existing* web tool: the same public-URL validation
    // (SSRF guard) applies, and no unrestricted HTTP path exists for it.
    assert.match(payloads[1].messages[3].content, /Error: Only public HTTP or HTTPS pages are supported/);
    const [session] = sessionManager.listChildren('loop-web');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('the local provider keeps requests tool-free unless a caller explicitly opts in', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return jsonResponse('ok'); };
  const offeredTools = [{ type: 'function', function: { name: 'read_project_file', parameters: { type: 'object' } } }];
  // Default: even a payload carrying tools is forced tool-free.
  await chatCompletion({ engine, payload: { model: 'm', messages: [], tools: offeredTools }, fetchImpl });
  assert.deepEqual(bodies[0].tools, []);
  assert.equal(bodies[0].tool_choice, 'none');
  // Explicit opt-in passes the tool list through with tool_choice 'auto'.
  await chatCompletion({ engine, payload: { model: 'm', messages: [], tools: offeredTools }, allowTools: true, fetchImpl });
  assert.equal(bodies[1].tools.length, 1);
  assert.equal(bodies[1].tool_choice, 'auto');
  // Opting in without a tool list still fails closed.
  await chatCompletion({ engine, payload: { model: 'm', messages: [] }, allowTools: true, fetchImpl });
  assert.deepEqual(bodies[2].tools, []);
  assert.equal(bodies[2].tool_choice, 'none');
});

test('spawn_sub_agent with investigate=true runs the loop end to end through the real provider', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'child-loop-e2e-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      const reply = requests.length === 1
        ? { choices: [{ message: { role: 'assistant', content: '', finish_reason: 'tool_calls',
          tool_calls: [toolCall('e1', 'read_project_file', { relative_path: 'auth.md' })] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
        : { choices: [{ message: { role: 'assistant', content: 'E2E findings', finish_reason: 'stop' } }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fs.writeFile(path.join(rootPath, 'auth.md'), 'E2E CHILD FILE TEXT');
    const live = { ...engine, port: server.address().port };
    const answer = await executeSpawnSubagent({
      task: 'Investigate how auth works.',
      expected_output: 'A markdown summary.',
      constraint: 'No speculation.',
      investigate: true,
      rootPath,
      engine: live,
      parentSessionId: 'loop-e2e',
    });
    assert.equal(answer, 'E2E findings');
    assert.equal(requests.length, 2, 'two real HTTP inference turns');
    for (const payload of requests) {
      assert.equal(payload.stream, false);
      assert.equal(payload.tool_choice, 'auto');
      assert.deepEqual(toolNamesIn(payload), [...CHILD_TOOL_NAMES].sort());
    }
    // The joined instruction carries the spawn-level formatting.
    assert.match(requests[0].messages[1].content, /Expected output: A markdown summary\./);
    assert.match(requests[0].messages[1].content, /Constraint: No speculation\./);
    // The second request carries the child's own tool round trip.
    assert.deepEqual(requests[1].messages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
    assert.match(requests[1].messages[3].content, /E2E CHILD FILE TEXT/);
    const [session] = sessionManager.listChildren('loop-e2e');
    assert.equal(session.status, sessionManager.SESSION_STATUS.COMPLETED);
    assert.equal(session.model, 'local-model');
    assert.deepEqual(session.usage, { prompt_tokens: 22, completion_tokens: 9, total_tokens: 31 });
    assert.equal(listExecutions(session.id)[0].kind, 'investigation');
    assert.ok(DEFAULT_MAX_TURNS >= 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
