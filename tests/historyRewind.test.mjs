import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runMemoryChat, sanitizeChatMessages } from '../src/lib/memoryChat.mjs';
const require = createRequire(import.meta.url);
const { rewindFailedTurnRange, failedToolReason } = require('../src/main/engineManager.js');

const call = (id, name = 'execute_command') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const tool = (id, output) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(output) });
const assistant = (id, name) => ({ role: 'assistant', content: null, tool_calls: [call(id, name)] });
const reply = (content, toolCalls = []) => Response.json({ choices: [{
  message: { content, tool_calls: toolCalls }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
}] });

test('rewind helper removes completed failed tool pairs without mutating source history', () => {
  const messages = [
    { role: 'system', content: 'Rules' }, { role: 'user', content: 'Fix build' },
    assistant('a'), tool('a', { exitCode: 2, stderr: 'syntax error' }),
    assistant('b', 'read_project_file'), tool('b', { success: false, error: 'ENOENT: missing file' }),
  ];
  const snapshot = structuredClone(messages);
  const rewound = rewindFailedTurnRange(messages, 2);
  assert.equal(rewound.length, 3);
  assert.match(rewound[2].content, /^\[CONTEXT REWOUND\]:/);
  assert.match(rewound[2].content, /Command exited with status 2/);
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(sanitizeChatMessages(rewound).map(message => message.role), ['system', 'user']);
  assert.equal(rewindFailedTurnRange(messages, 0), messages, 'a user boundary cannot be crossed');
  assert.equal(rewindFailedTurnRange([...messages.slice(0, -1)], 2).length, messages.length - 1, 'incomplete calls stay intact');
});

test('project prompt is rewound after consecutive errors; casual prompt and audit steps remain complete', async () => {
  for (const projectId of ['project-1', null]) {
    const requests = [], events = [], snapshots = [];
    const result = await runMemoryChat({
      baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Fix' }],
      chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
      projectId, rewindFailedTurnRange, failedToolReason,
      onContextRewind: event => events.push(event), onExecutionSteps: steps => snapshots.push(steps),
      executeTool: async ({ name }) => name === 'execute_command'
        ? requests.length === 1 ? { exitCode: 1, stderr: 'failed' } : { success: false, error: 'ENOENT: missing path' }
        : { success: true },
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) return reply('', [call('first')]);
        if (requests.length === 2) return reply('', [call('second')]);
        return reply('Try a different file. [TASK COMPLETE]');
      },
    });
    assert.equal(result, 'Try a different file. [TASK COMPLETE]');
    assert.equal(requests.length, 3);
    const savedSteps = snapshots.at(-1).filter(step => step.type === 'tool_call');
    assert.equal(savedSteps.length, 2, 'audit execution steps remain complete');
    assert.deepEqual(savedSteps.map(step => step.status), ['error', 'error']);
    if (projectId) {
      assert.equal(events.length, 1);
      assert.equal(requests[2].messages.filter(message => message.role === 'tool').length, 0);
      assert.match(requests[2].messages[0].content, /\[CONTEXT REWOUND\]/);
    } else {
      assert.equal(events.length, 0);
      assert.equal(requests[2].messages.filter(message => message.role === 'tool').length, 2);
      assert.doesNotMatch(requests[2].messages[0].content, /\[CONTEXT REWOUND\]/);
    }
  }
});

test('a strategy switch rewinds one failed attempt before the next project tool turn', async () => {
  const requests = [], events = [];
  await runMemoryChat({
    baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Rules' }],
    chatTools: [{ type: 'function', function: { name: 'execute_command' } }],
    projectId: 'project-1', rewindFailedTurnRange, failedToolReason,
    onContextRewind: event => events.push(event),
    executeTool: async () => requests.length === 1 ? { exitCode: 2 } : { exitCode: 0 },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) return reply('', [call('first')]);
      if (requests.length === 2) return reply('I will try a different approach.', [call('second')]);
      return reply('Done. [TASK COMPLETE]');
    },
  });
  assert.equal(events.length, 1);
  assert.equal(requests[2].messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(requests[2].messages.find(message => message.role === 'tool').tool_call_id, 'second');
  assert.match(requests[2].messages[0].content, /\[CONTEXT REWOUND\]/);
});
