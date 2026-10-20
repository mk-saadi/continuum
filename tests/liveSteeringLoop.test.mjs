import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';

// Phase 2.1 — live steering delivery boundaries in the real model/tool loop.
// The transport is a deterministic fake; no inference call is made.

const memoryTools = [{
  name: 'search_memory', description: 'search', input_schema: { type: 'object' },
}];
const base = {
  baseUrl: 'http://localhost',
  modelId: 'test',
  messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Do the task.' }],
  memoryTools,
};
const chunk = (delta, finishReason = null) => ({
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});
function stream(chunks, { onStart } = {}) {
  const bytes = new TextEncoder().encode(
    `${chunks.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`,
  );
  return new Response(new ReadableStream({
    start(controller) {
      onStart?.();
      for (let index = 0; index < bytes.length; index += 5) {
        controller.enqueue(bytes.slice(index, index + 5));
      }
      controller.close();
    },
  }));
}
const toolCall = (round = 1) => [
  chunk({ tool_calls: [{ index: 0, id: `call-${round}`, function: { name: 'search_memory', arguments: '{"query":"x"}' } }] }),
  chunk({}, 'tool_calls'),
];
const final = (content) => [chunk({ content }), chunk({}, 'stop')];
const messagesOf = (request) => JSON.parse(request.body).messages;
const steeringMessages = (messages) => messages.filter(
  (message) => message.role === 'user' && String(message.content).includes('User steering instruction received during this run'),
);
function instruction(id, content) {
  return { id, content, deliveryRequestId: `request-${id}` };
}
function harness({ queueAt = [], maxSteeringContinuations } = {}) {
  const takeCalls = [];
  const delivered = [];
  const undelivered = [];
  let index = 0;
  return {
    takeCalls,
    delivered,
    undelivered,
    takeSteeringInstructions: async () => {
      takeCalls.push(index);
      const next = queueAt[index] ?? [];
      index++;
      return next;
    },
    markSteeringDelivered: async (ids, requestId) => {
      delivered.push({ ids, requestId });
    },
    markSteeringUndelivered: async (ids, reason) => {
      undelivered.push({ ids, reason });
    },
    maxSteeringContinuations,
  };
}

test('without steering hooks the loop is unchanged', async () => {
  let requests = 0;
  const text = await runMemoryChat({
    ...base,
    fetchImpl: async () => {
      requests++;
      return stream(final('Done.'));
    },
  });
  assert.equal(text, 'Done.');
  assert.equal(requests, 1);
});

test('steering is injected at the next request boundary, never inside a tool batch', async () => {
  const hooks = harness({ queueAt: [[], [instruction('s1', 'Prefer the unit tests.')]] });
  const requests = [];
  const text = await runMemoryChat({
    ...base,
    ...hooks,
    executeTool: async () => ({ success: true }),
    fetchImpl: async (_url, request) => {
      requests.push(messagesOf(request));
      return stream(requests.length === 1 ? toolCall(1) : final('Finished with the unit tests.'));
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(steeringMessages(requests[0]).length, 0);
  assert.equal(steeringMessages(requests[1]).length, 1);
  assert.match(steeringMessages(requests[1])[0].content, /Prefer the unit tests\./);
  // The instruction follows the tool result; it never replaces or precedes it.
  assert.ok(requests[1].findIndex((message) => message.role === 'tool') <
    requests[1].findIndex((message) => message.role === 'user' &&
      String(message.content).includes('Prefer the unit tests.')));
  assert.deepEqual(hooks.delivered, [{ ids: ['s1'], requestId: 'request-s1' }]);
  assert.deepEqual(hooks.undelivered, []);
  assert.equal(text, 'Finished with the unit tests.');
});

test('multiple instructions keep submission order inside one request', async () => {
  const hooks = harness({
    queueAt: [[instruction('a', 'First instruction.'), instruction('b', 'Second instruction.')]],
  });
  let request;
  await runMemoryChat({
    ...base,
    ...hooks,
    fetchImpl: async (_url, options) => {
      request = messagesOf(options);
      return stream(final('Done.'));
    },
  });
  const injected = steeringMessages(request);
  assert.equal(injected.length, 2);
  assert.ok(injected[0].content.endsWith('First instruction.'));
  assert.ok(injected[1].content.endsWith('Second instruction.'));
  assert.deepEqual(hooks.delivered[0].ids, ['a', 'b']);
});

test('a steer arriving during the final answer triggers one bounded continuation', async () => {
  const hooks = harness({ queueAt: [[], [instruction('late', 'Also mention the caveat.')]] });
  const requests = [];
  const text = await runMemoryChat({
    ...base,
    ...hooks,
    fetchImpl: async (_url, request) => {
      requests.push(messagesOf(request));
      return stream(final(requests.length === 1 ? 'First answer.' : 'Second answer with caveat.'));
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(steeringMessages(requests[0]).length, 0);
  assert.equal(steeringMessages(requests[1]).length, 1);
  const late = steeringMessages(requests[1])[0];
  const lateIndex = requests[1].indexOf(late);
  assert.equal(requests[1][lateIndex - 1].role, 'assistant');
  assert.equal(requests[1][lateIndex - 1].content, 'First answer.');
  assert.deepEqual(hooks.delivered, [{ ids: ['late'], requestId: 'request-late' }]);
  assert.ok(text.includes('First answer.'));
  assert.ok(text.includes('Second answer with caveat.'));
});

test('the continuation cap stops an endless final-answer steering race', async () => {
  const hooks = harness({
    queueAt: [[], [instruction('one', 'One more.')], [instruction('two', 'Too late.')]],
    maxSteeringContinuations: 1,
  });
  let requests = 0;
  const text = await runMemoryChat({
    ...base,
    ...hooks,
    fetchImpl: async () => {
      requests++;
      return stream(final(`Answer ${requests}.`));
    },
  });
  assert.equal(requests, 2);
  // The third queue read is skipped by the cap, so the second instruction is
  // never claimed by this run.
  assert.equal(hooks.takeCalls.length, 2);
  assert.deepEqual(hooks.delivered, [{ ids: ['one'], requestId: 'request-one' }]);
  assert.equal(text, 'Answer 1.Answer 2.');
});

test('a transport failure marks the claimed instruction undelivered', async () => {
  const hooks = harness({ queueAt: [[instruction('fail', 'Try this.')]] });
  await assert.rejects(runMemoryChat({
    ...base,
    ...hooks,
    fetchImpl: async () => { throw new Error('connection refused'); },
  }), /connection refused/);
  assert.deepEqual(hooks.delivered, []);
  assert.equal(hooks.undelivered.length, 1);
  assert.deepEqual(hooks.undelivered[0].ids, ['fail']);
  assert.match(hooks.undelivered[0].reason, /connection refused/);
});

test('a steering message already in the transcript survives context recovery', async () => {
  const hooks = harness({ queueAt: [[instruction('keep', 'Keep this constraint.')]] });
  let recoveredMessages = null;
  await runMemoryChat({
    ...base,
    ...hooks,
    executeTool: async () => ({ success: true }),
    recoverContext: async () => ({ messages: [{ role: 'system', content: 'REBUILT PREFIX' }] }),
    fetchImpl: async (_url, options) => {
      const messages = messagesOf(options);
      if (messages.some((message) => message.content === 'REBUILT PREFIX')) {
        return stream(final('Recovered.'));
      }
      if (messages.some((message) => message.role === 'tool')) {
        const recovered = await options.contextRecovery({ contextWindowLimit: 1024 });
        recoveredMessages = recovered.messages;
        return stream(final('Recovered.'));
      }
      return stream(toolCall(1));
    },
  });
  assert.ok(recoveredMessages);
  assert.equal(recoveredMessages[0].content, 'REBUILT PREFIX');
  assert.equal(steeringMessages(recoveredMessages).length, 1);
  assert.match(steeringMessages(recoveredMessages)[0].content, /Keep this constraint\./);
  // The recovered transcript keeps the tool pair before the steering message.
  assert.ok(recoveredMessages.some((message) => message.role === 'tool'));
});
