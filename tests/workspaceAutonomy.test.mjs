import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';

const require = createRequire(import.meta.url);
const { createToolFailureCircuitBreaker, failedToolReason, createProjectToolLoopGuard } = require('../src/main/engineManager.js');

const SEARCH = 'search_files';
const READ = 'read_file';
const WRITE = 'write_project_file';

const chatTools = [SEARCH, READ, WRITE].map((name) => ({ type: 'function', function: { name } }));
const base = { baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Work autonomously.' }], chatTools };

// One tool call per round with distinct args so the repetition guard never
// trips; the final round answers in text.
const neverPause = () => assert.fail('Workspace runs must never hit a turn/round pause');

async function runWorkspace({ rounds, tools, extra = {} }) {
  let requests = 0, executions = 0;
  const text = await runMemoryChat({ ...base, ...extra,
    casualMode: false,
    projectId: 'workspace-proj',
    projectToolLoopGuard: createProjectToolLoopGuard('workspace-proj'),
    failedToolReason,
    onPaused: neverPause,
    executeTool: async (call) => {
      executions++;
      if (call.name === WRITE) return { success: true };
      return `contents of ${call.name}`;
    },
    fetchImpl: async () => {
      requests++;
      const names = Array.isArray(tools) ? tools : [tools ?? SEARCH];
      return Response.json({ choices: [{
        message: requests > rounds ? { content: 'Shipped.' }
          : { content: null, tool_calls: [{ id: `call-${requests}`, type: 'function',
            function: { name: names[(requests - 1) % names.length], arguments: JSON.stringify({ target: `file-${requests}.txt` }) } }] },
        finish_reason: requests > rounds ? 'stop' : 'tool_calls' }] });
    },
  });
  return { text, requests, executions };
}

test('workspace run completes 40 tool rounds with no limit-triggered pause', async () => {
  // Explicit small budgets must not gate workspace runs either.
  const { text, requests, executions } = await runWorkspace({ rounds: 40, extra: { maxAutoTurns: 5, maxToolRounds: 5 } });
  assert.equal(text, 'Shipped.');
  assert.equal(requests, 41);
  assert.equal(executions, 40);
});

for (const tools of [[SEARCH, READ], [SEARCH, WRITE]]) {
  test(`reads-only and coding tasks run the same 35 rounds without pausing (${tools.join('+')})`, async () => {
    const { text, requests, executions } = await runWorkspace({ rounds: 35, tools });
    assert.equal(text, 'Shipped.');
    assert.equal(requests, 36);
    assert.equal(executions, 35);
  });
}

test('repeated tool failures still abort a workspace run with a clear status', async () => {
  let requests = 0;
  const notices = [];
  const result = await runMemoryChat({ ...base, casualMode: false, projectId: 'workspace-proj',
    chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
    toolFailureCircuitBreaker: createToolFailureCircuitBreaker(),
    failedToolReason,
    onCircuitBreak: (reason) => notices.push(reason),
    onPaused: neverPause,
    executeTool: async () => 'SUBAGENT_FETCH_ERROR: timed out',
    fetchImpl: async () => {
      if (++requests > 5) throw new Error('An extra completion was requested.');
      return Response.json({ choices: [{ message: { content: '',
        tool_calls: [{ id: `call-${requests}`, type: 'function', function: { name: 'execute_command', arguments: '{}' } }] },
        finish_reason: 'tool_calls' }] });
    },
  });
  assert.equal(requests, 5);
  assert.deepEqual(notices, ['Execution aborted: 5 consecutive tool calls failed. (A tool call failed. x5)']);
  assert.match(result, /Execution aborted: 5 consecutive tool calls failed/);
});

test('repeated identical calls are still detected in workspace runs', async () => {
  let requests = 0, executions = 0;
  const text = await runMemoryChat({ ...base, casualMode: false, projectId: 'workspace-proj',
    chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
    projectToolLoopGuard: createProjectToolLoopGuard('workspace-proj'),
    failedToolReason,
    onPaused: neverPause,
    executeTool: async () => { executions++; return { exitCode: 0, stdout: 'ok' }; },
    fetchImpl: async (_url, options) => {
      requests++;
      if (requests <= 3) return Response.json({ choices: [{ message: { content: '',
        tool_calls: [{ id: `call-${requests}`, type: 'function', function: { name: 'execute_command', arguments: '{"command":"pwd"}' } }] },
        finish_reason: 'tool_calls' }] });
      assert.match(JSON.parse(options.body).messages.at(-1).content, /\[LOOP DETECTED\]/);
      return Response.json({ choices: [{ message: { content: 'Rerouted.' }, finish_reason: 'stop' }] });
    },
  });
  assert.equal(text, 'Rerouted.');
  assert.equal(executions, 2);
});

test('a recoverable tool failure retries and the long run still completes', async () => {
  let requests = 0, executions = 0;
  const text = await runMemoryChat({ ...base, casualMode: false, projectId: 'workspace-proj',
    projectToolLoopGuard: createProjectToolLoopGuard('workspace-proj'),
    failedToolReason,
    onPaused: neverPause,
    executeTool: async () => {
      executions++;
      if (executions === 1) throw new Error('Tool failed once');
      return 'ok';
    },
    fetchImpl: async () => {
      requests++;
      if (requests > 35) return Response.json({ choices: [{ message: { content: 'Recovered.' }, finish_reason: 'stop' }] });
      return Response.json({ choices: [{ message: { content: null,
        tool_calls: [{ id: `call-${requests}`, type: 'function',
          function: { name: SEARCH, arguments: JSON.stringify({ target: `file-${requests}.txt` }) } }] },
        finish_reason: 'tool_calls' }] });
    },
  });
  assert.equal(text, 'Recovered.');
  assert.equal(requests, 36);
  assert.equal(executions, 35);
});

test('user cancellation aborts a long workspace run immediately', async () => {
  const controller = new AbortController();
  let requests = 0, executions = 0;
  await assert.rejects(runMemoryChat({ ...base, casualMode: false, projectId: 'workspace-proj',
    signal: controller.signal,
    onPaused: neverPause,
    executeTool: async () => {
      executions++;
      if (executions === 3) controller.abort();
      return 'ok';
    },
    fetchImpl: async () => {
      requests++;
      return Response.json({ choices: [{ message: { content: null,
        tool_calls: [{ id: `call-${requests}`, type: 'function',
          function: { name: SEARCH, arguments: JSON.stringify({ target: `file-${requests}.txt` }) } }] },
        finish_reason: 'tool_calls' }] });
    },
  }), { name: 'AbortError' });
  assert.equal(executions, 3);
  assert.equal(requests, 3);
});

test('casual runs still pause at the turn budget', async () => {
  let requests = 0, pauses = 0;
  await runMemoryChat({ ...base, casualMode: true, maxAutoTurns: 2,
    onPaused: async (state) => { pauses++; assert.equal(state.reason, 'turn_limit'); return false; },
    executeTool: async () => 'ok',
    fetchImpl: async () => {
      requests++;
      return Response.json({ choices: [{ message: { content: null,
        tool_calls: [{ id: `call-${requests}`, type: 'function',
          function: { name: SEARCH, arguments: JSON.stringify({ target: `file-${requests}.txt` }) } }] },
        finish_reason: 'tool_calls' }] });
    },
  });
  assert.equal(requests, 2);
  assert.equal(pauses, 1);
});
