import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';
const require = createRequire(import.meta.url);
const { createProjectToolLoopGuard } = require('../src/main/engineManager.js');
const call = id => ({ id, type: 'function', function: { name: 'execute_command', arguments: '{"command":"pwd"}' } });
const reply = (content, toolCalls = []) => Response.json({ choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] });

test('project inspector hashes arguments, uses a sliding window, and resets after interception', () => {
  const guard = createProjectToolLoopGuard('project');
  const hash = createHash('sha256').update(JSON.stringify({ command: 'pwd' })).digest('hex');
  assert.equal(guard.inspect('execute_command', { command: 'pwd' }), null);
  assert.deepEqual(guard.recentTools, [{ toolName: 'execute_command', argsHash: hash }]);
  assert.equal(guard.inspect('execute_command', { command: 'pwd' }), null);
  assert.match(guard.inspect('execute_command', { command: 'pwd' }), /^\[LOOP DETECTED\]:/);
  assert.equal(guard.recentTools.length, 0);
  assert.equal(guard.inspect('execute_command', { command: 'pwd' }), null);
  guard.inspect('other_tool', { command: 'pwd' });
  assert.equal(guard.inspect('execute_command', { command: 'pwd' }), null, 'a different tool interrupts the consecutive run');
  assert.equal(createProjectToolLoopGuard(null).inspect('execute_command', { command: 'pwd' }), null);
});

test('the third identical project call is skipped and the next model prompt contains a warning', async () => {
  for (const projectId of ['project', null]) {
    const requests = [], executed = [], snapshots = [];
    const text = await runMemoryChat({
      baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Rules' }],
      chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
      projectId, projectToolLoopGuard: createProjectToolLoopGuard(projectId),
      executeTool: async tool => { executed.push(tool); return { exitCode: 0, stdout: 'ok' }; },
      onExecutionSteps: steps => snapshots.push(steps),
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length <= 3) return reply('', [call(`call-${requests.length}`)]);
        return reply('Done. [TASK COMPLETE]');
      },
    });
    assert.equal(text, 'Done. [TASK COMPLETE]');
    assert.equal(requests.length, 4);
    assert.equal(executed.length, projectId ? 2 : 3);
    assert.equal(requests[3].messages.filter(message => message.role === 'tool').length, 3);
    const lastTool = requests[3].messages.find(message => message.role === 'tool' && message.tool_call_id === 'call-3');
    if (projectId) {
      assert.match(requests[3].messages[0].content, /\[LOOP DETECTED\]: You have executed 'execute_command' 3 times/);
      assert.match(lastTool.content, /\[LOOP DETECTED\]/);
      assert.equal(snapshots.at(-1).filter(step => step.type === 'tool_call').at(-1).status, 'error');
    } else {
      assert.doesNotMatch(requests[3].messages[0].content, /\[LOOP DETECTED\]/);
      assert.doesNotMatch(lastTool.content, /\[LOOP DETECTED\]/);
    }
  }
});

test('other calls in the same batch are answered but not dispatched after a loop warning', async () => {
  let executions = 0;
  const requests = [];
  await runMemoryChat({
    baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Rules' }],
    chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
    projectId: 'project', projectToolLoopGuard: createProjectToolLoopGuard('project'),
    executeTool: async () => { executions++; return { exitCode: 0 }; },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length < 3) return reply('', [call(`call-${requests.length}`)]);
      if (requests.length === 3) return reply('', [call('call-3'), call('call-4')]);
      return reply('Done. [TASK COMPLETE]');
    },
  });
  assert.equal(executions, 2);
  assert.equal(requests[3].messages.filter(message => message.role === 'tool').length, 4);
  assert.match(requests[3].messages.find(message => message.tool_call_id === 'call-4').content, /skipped after repetition loop warning/);
});
