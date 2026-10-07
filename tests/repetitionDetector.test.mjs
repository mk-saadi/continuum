import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepetitionDetector } from '../src/lib/repetitionDetector.mjs';
import { runMemoryChat, REASONING_LOOP_NOTICE } from '../src/lib/memoryChat.mjs';
const paragraph = 'I should inspect the implementation carefully before choosing the next approach.\n';
const base = { baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Be helpful.' }] };
const encode = delta => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);

test('detects three consecutive significant blocks across arbitrary boundaries', () => {
  for (const width of [1, 7, 50, 5000]) {
    const detector = createRepetitionDetector();
    const text = 'Unique preface.\n' + paragraph.repeat(3) + 'Must not emit this tail';
    let accepted = '', detected = false;
    for (let index = 0; index < text.length && !detected; index += width) {
      const result = detector.push(text.slice(index, index + width));
      accepted += result.text; detected = result.detected;
    }
    assert.equal(detected, true);
    assert.ok(!accepted.includes('Must not emit'));
    assert.ok(('Unique preface.\n' + paragraph.repeat(3)).startsWith(accepted));
    assert.ok(accepted.length >= paragraph.length * 3, 'Three full repeated blocks, possibly rotated across punctuation, are required');
  }
});

test('allows two copies, nonconsecutive repetitions and formatting separators', () => {
  for (const text of [paragraph.repeat(2), paragraph + 'Different thought.\n' + paragraph + 'Another thought.\n' + paragraph,
    ' '.repeat(2000), '-|'.repeat(2000)]) {
    assert.equal(createRepetitionDetector().push(text).detected, false);
  }
  const detector = createRepetitionDetector();
  detector.push(paragraph.repeat(2));
  // Faraway output does not participate in a later match.
  for (let i = 0; i < 100; i++) detector.push(`Unique sentence number ${i}: ${i * i}, continue.\n`);
  assert.equal(detector.push(paragraph).detected, false);
});

for (const mode of ['reasoning_content', 'reasoning', 'inline-think', 'content']) {
  test(`aborts live ${mode} loops, cancels reader and publishes the visible notice once`, async () => {
    let serverSignal, cancelled = false, output = '', requests = 0;
    const parent = new AbortController();
    const steps = [];
    const result = await runMemoryChat({ ...base, signal: parent.signal,
      onText: text => { output += text; }, onExecutionSteps: value => steps.push(value),
      executeTool: () => assert.fail('No tool may run after a loop'),
      fetchImpl: async (_url, options) => {
        requests++; serverSignal = options.signal;
        const deltas = [];
        if (mode === 'inline-think') deltas.push({ content: '<thi' }, { content: 'nk>' });
        const text = paragraph.repeat(20);
        const key = mode === 'inline-think' ? 'content' : mode;
        for (let index = 0; index < text.length; index += 13) deltas.push({ [key]: text.slice(index, index + 13) });
        return new Response(new ReadableStream({
          start(controller) {
            serverSignal.addEventListener('abort', () => { /* A real fetch closes its socket here. */ });
            for (const delta of deltas) {
              const bytes = encode(delta);
              // Split the SSE wire format too, including JSON boundaries.
              for (let index = 0; index < bytes.length; index += 11) controller.enqueue(bytes.slice(index, index + 11));
            }
            // Never close: the detector must terminate without waiting for [DONE].
          },
          cancel() { cancelled = true; },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    assert.equal(serverSignal.aborted, true);
    assert.equal(parent.signal.aborted, false, 'caller stays live for IPC and persistence');
    assert.equal(cancelled, true);
    assert.equal(requests, 1);
    assert.equal(result, output);
    assert.equal(output.split(REASONING_LOOP_NOTICE).length - 1, 1);
    if (mode !== 'content') {
      assert.equal(output.trim(), REASONING_LOOP_NOTICE, 'notice is outside the reasoning block');
      assert.equal(steps.at(-1)[0].content, paragraph.repeat(3));
      assert.ok(steps.at(-1)[0].endedAt !== undefined);
    }
  });
}

test('loop termination discards partial tool calls and preserves earlier visible text', async () => {
  let executed = false;
  const result = await runMemoryChat({ ...base,
    executeTool: async () => { executed = true; },
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode({ content: 'Partial answer.\n' }));
      controller.enqueue(encode({ tool_calls: [{ index: 0, id: 'unfinished', function: { name: 'anything', arguments: '{' } }] }));
      controller.enqueue(encode({ reasoning_content: paragraph.repeat(3) }));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  assert.equal(executed, false);
  assert.match(result, /^Partial answer\./);
  assert.ok(result.endsWith(REASONING_LOOP_NOTICE));
});

test('detectors reset each model round and user cancellation remains an AbortError', async () => {
  let calls = 0;
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
  const result = await runMemoryChat({ ...base, chatTools: tools, executeTool: async () => 'Found it',
    fetchImpl: async () => {
      calls++;
      return Response.json({ choices: [{ finish_reason: calls < 3 ? 'tool_calls' : 'stop', message: {
        reasoning_content: paragraph, content: calls === 3 ? 'Done [TASK COMPLETE]' : '',
        ...(calls < 3 ? { tool_calls: [{ id: `call${calls}`, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } : {}),
      } }] });
    },
  });
  assert.equal(result, 'Done [TASK COMPLETE]'); assert.equal(calls, 3);
  const controller = new AbortController(); let visible = '';
  await assert.rejects(runMemoryChat({ ...base, signal: controller.signal, onText: value => { visible += value; },
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, false);
      return new Response(new ReadableStream({ start(stream) {
        options.signal.addEventListener('abort', () => stream.error(options.signal.reason));
        controller.abort();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  }), { name: 'AbortError' });
  assert.ok(!visible.includes(REASONING_LOOP_NOTICE));
});
