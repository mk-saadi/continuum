import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';

const require = createRequire(import.meta.url);
const { createToolFailureCircuitBreaker, failedToolReason } = require('../src/main/engineManager.js');
const call = id => ({ id, type: 'function', function: { name: 'execute_command', arguments: '{}' } });
const reply = calls => Response.json({ choices: [{ message: { content: '', tool_calls: calls }, finish_reason: 'tool_calls' }] });

test('failure classifier catches structured, shell, and text errors', () => {
  for (const output of [{ isError: true }, { success: false }, { exitCode: 1 },
    'error: blocked', 'SUBAGENT_FETCH_ERROR: timed out', { content: [{ type: 'text', text: 'error: failed' }] }]) {
    assert.ok(failedToolReason(output), JSON.stringify(output));
  }
  assert.equal(failedToolReason({ success: true, output: 'ok' }), null);
});

test('consecutive failures abort before another completion and publish a visible notice', async () => {
  const requests = [], notices = [], streamed = [];
  const result = await runMemoryChat({
    baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Rules' }],
    chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
    toolFailureCircuitBreaker: createToolFailureCircuitBreaker(),
    onCircuitBreak: reason => notices.push(reason), onText: delta => streamed.push(delta),
    executeTool: async () => 'SUBAGENT_FETCH_ERROR: timed out',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length > 5) throw new Error('An extra completion was requested.');
      return reply([call(`call-${requests.length}`)]);
    },
  });
  assert.equal(requests.length, 5);
  assert.deepEqual(notices, ['Execution aborted: 5 consecutive tool calls failed. (A tool call failed. x5)']);
  assert.match(result, /Execution aborted: 5 consecutive tool calls failed\. \(A tool call failed\. x5\)/);
  assert.equal(streamed.join(''), result);
});

test('successful calls reset the streak while the total cap persists', () => {
  const breaker = createToolFailureCircuitBreaker({ maxConsecutiveToolFailures: 5, maxTotalToolFailures: 10 });
  for (let i = 0; i < 9; i++) {
    breaker.record({ success: false });
    if (i % 4 === 3) breaker.record({ success: true });
    assert.equal(breaker.abortReason, null);
  }
  breaker.record({ success: true });
  breaker.record({ isError: true });
  assert.equal(breaker.abortReason, 'Execution aborted: Exceeded maximum total tool failure cap (10). (A tool call failed.)');
});

test('abort notice classifies each distinct failure reason with its count', () => {
  const breaker = createToolFailureCircuitBreaker({ maxConsecutiveToolFailures: 3, maxTotalToolFailures: 10 });
  breaker.record('error: ENOENT no such file or directory'); // generic error regex fires first for strings
  breaker.record({ success: false, error: 'SUBAGENT_FETCH_ERROR: HTTP 429' });
  breaker.record('file not found at /tmp/missing.txt');
  assert.equal(breaker.abortReason,
    'Execution aborted: 3 consecutive tool calls failed. (A file path was not found.; A tool call failed. x2)');
});
