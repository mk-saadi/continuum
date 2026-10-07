import { PNG_BASE64, JPEG_BASE64 } from './fixtures/visionImages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';

const memoryTools = ['save_memory', 'search_memory'].map((name) => ({
  name, description: name, input_schema: { type: 'object' },
}));
const base = { baseUrl: 'http://localhost', modelId: 'test', messages: [{ role: 'system', content: 'Rules' }], memoryTools };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function stream(chunks) {
  const bytes = new TextEncoder().encode(chunks.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) {
    // Split event boundaries, JSON, and multibyte characters across reads.
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }));
}

test('fragmented save/search calls return matching tool results before the final reply', async () => {
  const requests = [], executed = [];
  let output = '';
  const text = await runMemoryChat({ ...base, reasoningEffort: 'low',
    onText: (delta) => { output += delta; },
    executeTool: async (call) => {
      executed.push(call);
      return call.name === 'save_memory' ? { success: true, message: 'Memory saved' } : [{ content: 'Use pnpm' }];
    },
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      if (requests.length === 1) return stream([
        chunk({ tool_calls: [{ index: 0, id: 'save1', function: { name: 'save_memory', arguments: '{"category":"preference",' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"content":"Use pnpm","always_inject":true}' } },
          { index: 1, id: 'search1', function: { name: 'search_memory', arguments: '{"query":"pnpm"}' } }] }),
        chunk({}, 'tool_calls'),
      ]);
      return stream([chunk({ content: 'Got it — pnpm. [TASK COMPLETE]' }), chunk({}, 'stop')]);
    },
  });
  assert.equal(text, 'Got it — pnpm. [TASK COMPLETE]');
  assert.ok(requests.every(request => request.chat_template_kwargs.reasoning_effort === 'low'));
  assert.equal(output, text);
  assert.equal(executed.length, 2);
  assert.equal(JSON.parse(executed[0].arguments).always_inject, true);
  assert.equal(requests[0].tools[0].function.name, 'save_memory');
  assert.equal(requests[1].messages[0].role, 'system');
  assert.equal(requests[1].messages[1].tool_calls.length, 2);
  assert.equal(requests[1].messages[2].tool_call_id, 'save1');
  assert.equal(JSON.parse(requests[1].messages[2].content).success, true);
  assert.equal(requests[1].messages[3].tool_call_id, 'search1');
});

test('truncated tool arguments never execute', async () => {
  let calls = 0;
  await assert.rejects(runMemoryChat({ ...base,
    executeTool: () => { calls++; },
    fetchImpl: async () => stream([
      chunk({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'save_memory', arguments: '{' } }] }),
      chunk({}, 'length'),
    ]),
  }), /Incomplete tool-call/);
  assert.equal(calls, 0);
});

test('unknown tools are returned as errors, never dispatched', async () => {
  let requests = 0;
  await runMemoryChat({ ...base,
    executeTool: () => { throw new Error('Must not execute'); },
    fetchImpl: async (_url, options) => {
      if (++requests === 1) return stream([
        chunk({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'shell', arguments: '{}' } }] }),
        chunk({}, 'tool_calls'),
      ]);
      assert.equal(JSON.parse(JSON.parse(options.body).messages.at(-1).content).success, false);
      return stream([chunk({ content: 'Hello' }, 'stop')]);
    },
  });
});

test('aborted requests do not execute tools or start network requests', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runMemoryChat({ ...base, signal: controller.signal,
    fetchImpl: () => { throw new Error('Must not fetch'); }, executeTool: () => {},
  }), { name: 'AbortError' });
});

test('tool round limit executes the boundary batch and yields without an error', async () => {
  let requests = 0, executions = 0, pauses = 0;
  await runMemoryChat({ ...base, maxToolRounds: 1,
    onPaused: async () => { pauses++; assert.equal(executions, 1); return false; },
    executeTool: () => { executions++; return { success: true }; },
    fetchImpl: async () => {
      requests++;
      return stream([chunk({ tool_calls: [{ index: 0, id: String(requests), function: { name: 'search_memory', arguments: '{"query":"test"}' } }] }), chunk({}, 'tool_calls')]);
    },
  });
  assert.equal(executions, 1);
  assert.equal(requests, 1);
  assert.equal(pauses, 1);
});

test('casual tool budget pauses before the sixth call and grants five at a time', async () => {
  const executed = [], pauses = [];
  let requests = 0;
  const text = await runMemoryChat({ ...base, casualMode: true,
    onToolLimit: async detail => {
      pauses.push({ ...detail, executed: executed.length });
      return true;
    },
    executeTool: async call => { executed.push(call.name); return { success: true }; },
    fetchImpl: async () => {
      if (++requests === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
        content: null, tool_calls: Array.from({ length: 11 }, (_, index) => ({
          id: `call${index}`, type: 'function', function: { name: 'search_memory', arguments: '{}' },
        })),
      } }] });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Done [TASK COMPLETE]' } }] });
    },
  });
  assert.equal(text, 'Done [TASK COMPLETE]');
  assert.equal(executed.length, 11);
  assert.deepEqual(pauses, [
    { currentCount: 5, nextTool: 'search_memory', executed: 5 },
    { currentCount: 10, nextTool: 'search_memory', executed: 10 },
  ]);
});

test('denying a casual tool call skips the pending batch and requests a tool-free final answer', async () => {
  const executed = [], requests = [], steps = [];
  const text = await runMemoryChat({ ...base, casualMode: true,
    onToolLimit: async () => false,
    onExecutionSteps: value => { steps.splice(0, steps.length, ...value); },
    executeTool: async call => { executed.push(call.name); return { success: true }; },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (requests.length === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
        content: null, tool_calls: Array.from({ length: 7 }, (_, index) => ({
          id: `call${index}`, type: 'function', function: { name: 'search_memory', arguments: '{}' },
        })),
      } }] });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Summary [TASK COMPLETE]' } }] });
    },
  });
  assert.equal(text, 'Summary [TASK COMPLETE]');
  assert.equal(executed.length, 5);
  assert.equal(steps[5].status, 'error');
  assert.equal(steps[6].status, 'error');
  assert.equal(requests[1].tool_choice, 'none');
  assert.deepEqual(requests[1].tools, []);
  assert.match(requests[1].messages.at(-1).content, /denied by user/);
  assert.equal(requests[1].messages.filter(message => message.role === 'tool').length, 7);
});

test('project chats bypass the casual tool budget', async () => {
  let executed = 0;
  await runMemoryChat({ ...base, casualMode: false,
    onToolLimit: () => assert.fail('Project chats must not pause'),
    executeTool: async () => { executed++; return {}; },
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: executed < 7 ? 'tool_calls' : 'stop', message:
      executed < 7 ? { content: null, tool_calls: [{ id: `call${executed}`, type: 'function', function: { name: 'search_memory', arguments: '{}' } }] }
        : { content: 'Done [TASK COMPLETE]' } }] }),
  });
  assert.equal(executed, 7);
});

test('usage-only final chunk supplies message stats and requests usage', async () => {
  let stats;
  const times = [1000, 3000];
  await runMemoryChat({ ...base, now: () => times.shift(), onStats: (value) => { stats = value; },
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
      return stream([chunk({ content: 'Hello' }, 'stop'), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }]);
    },
  });
  assert.deepEqual(stats, { startTime: 1000, endTime: 3000, time: 2, promptTokens: 10, completionTokens: 20, totalTokens: 30, tokensPerSecond: 10, scope: 'all', raw: [{ usage: { prompt_tokens: 10, completion_tokens: 20 }, timings: null }] });
});

test('missing usage and zero elapsed time never produce fabricated counts or Infinity', async () => {
  let stats;
  await runMemoryChat({ ...base, now: () => 1000, onStats: (value) => { stats = value; },
    fetchImpl: async () => stream([chunk({ content: 'Hello' }, 'stop')]),
  });
  assert.equal(stats.time, 0);
  assert.equal(stats.totalTokens, null);
  assert.equal(stats.tokensPerSecond, null);
});

test('usage from a stream ending without DONE is captured', async () => {
  let stats;
  await runMemoryChat({ ...base, onStats: (value) => { stats = value; },
    fetchImpl: async () => new Response(`data: ${JSON.stringify(chunk({ content: 'Hi' }, 'stop'))}\n\ndata: ${JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 2 }, choices: [] })}`),
  });
  assert.equal(stats.totalTokens, 6);
});

test('stats include all memory tool rounds', async () => {
  let stats, requests = 0;
  await runMemoryChat({ ...base, onStats: (value) => { stats = value; }, executeTool: async () => ({}),
    fetchImpl: async () => stream([
      ++requests === 1
        ? chunk({ tool_calls: [{ index: 0, id: 'search', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls')
        : chunk({ content: 'Answer [TASK COMPLETE]' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
  });
  assert.equal(stats.completionTokens, 10);
  assert.equal(stats.totalTokens, 30);
});

test('structured reasoning accumulates across tool rounds separately from answer text', async () => {
  let requests = 0, thinking;
  let time = 0;
  const text = await runMemoryChat({ ...base, now: () => (time += 100), onThinking: value => { thinking = value; }, executeTool: async () => ({}),
    fetchImpl: async (_url, options) => {
      if (++requests === 1) return stream([
        chunk({ reasoning_content: 'Check memory.' }),
        chunk({ tool_calls: [{ index: 0, id: 'search', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls'),
      ]);
      assert.equal(JSON.parse(options.body).messages[1].content, null);
      return stream([chunk({ reasoning: 'Use the result.' }), chunk({ content: 'Answer [TASK COMPLETE]' }, 'stop')]);
    },
  });
  assert.equal(text, 'Answer [TASK COMPLETE]');
  assert.equal(thinking.text, 'Check memory.\n\nUse the result.');
  assert.ok(thinking.duration > 0);
});

test('fragmented think tags and JSON completions preserve thinking without leaking it into the answer', async () => {
  let thinking;
  let result = await runMemoryChat({ ...base, onThinking: value => { thinking = value; },
    fetchImpl: async () => stream([chunk({ content: '<thi' }), chunk({ content: 'nk>Reason' }), chunk({ content: 'ing</th' }), chunk({ content: 'ink>Answer [TASK COMPLETE]' }, 'stop')]),
  });
  assert.equal(result, 'Answer [TASK COMPLETE]');
  assert.equal(thinking.text, 'Reasoning');
  result = await runMemoryChat({ ...base, onThinking: value => { thinking = value; }, fetchImpl: async () => Response.json({ choices: [{ message: { reasoning_content: 'JSON reasoning', content: 'JSON answer' }, finish_reason: 'stop' }] }) });
  assert.equal(result, 'JSON answer');
  assert.equal(thinking.text, 'JSON reasoning');
});

test('interrupted reasoning publishes partial text and duration for persistence', async () => {
  const controller = new AbortController();
  let thinking;
  await assert.rejects(runMemoryChat({ ...base, signal: controller.signal,
    onThinking: value => { thinking = value; controller.abort(); },
    fetchImpl: async () => stream([chunk({ content: '<think>Partial thought' })]),
  }), { name: 'AbortError' });
  assert.equal(thinking.text, 'Partial thought');
  assert.ok(thinking.duration >= 0);
});

test('timings on a stop chunk provide counts and generation speed without usage', async () => {
  let stats;
  await runMemoryChat({ ...base, onStats: value => { stats = value; }, fetchImpl: async () => stream([
    { ...chunk({ content: 'Answer [TASK COMPLETE]' }, 'stop'), timings: { prompt_n: 8, cache_n: 2, predicted_n: 20, predicted_ms: 500, predicted_per_second: 40 } },
  ]) });
  assert.equal(stats.promptTokens, 10);
  assert.equal(stats.completionTokens, 20);
  assert.equal(stats.totalTokens, 30);
  assert.equal(stats.tokensPerSecond, 40);
  assert.equal(stats.generationTime, 0.5);
});

test('partial usage trailers merge without erasing counters or double-counting snapshots', async () => {
  let stats;
  await runMemoryChat({ ...base, onStats: value => { stats = value; }, fetchImpl: async () => stream([
    { ...chunk({ content: 'Answer [TASK COMPLETE]' }, 'stop'), usage: { prompt_tokens: 12 } },
    { choices: [], usage: { prompt_tokens: null, completion_tokens: 5 } },
    { choices: [], usage: { completion_tokens: 5, total_tokens: 17 }, timings: { predicted_ms: 100 } },
    { choices: [], usage: {}, timings: { predicted_ms: null } },
  ]) });
  assert.equal(stats.totalTokens, 17);
  assert.equal(stats.promptTokens, 12);
  assert.equal(stats.completionTokens, 5);
  assert.equal(stats.tokensPerSecond, 50);
});

test('final answer stats survive a tool phase with no reported usage', async () => {
  let requests = 0, stats;
  await runMemoryChat({ ...base, onStats: value => { stats = value; }, executeTool: async () => ({}), fetchImpl: async () => {
    if (++requests === 1) return stream([chunk({ tool_calls: [{ index: 0, id: 'tool', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls')]);
    return stream([chunk({ content: 'Final [TASK COMPLETE]' }, 'stop'), { choices: [], usage: { prompt_tokens: 15, completion_tokens: 5 }, timings: { predicted_ms: 250 } }]);
  } });
  assert.equal(stats.scope, 'final');
  assert.equal(stats.totalTokens, 20);
  assert.equal(stats.tokensPerSecond, 20);
});

test('complete phase metrics sum counts and weight speed by generation duration', async () => {
  let requests = 0, stats;
  await runMemoryChat({ ...base, onStats: value => { stats = value; }, executeTool: async () => ({}), fetchImpl: async () => {
    if (++requests === 1) return stream([
      chunk({ tool_calls: [{ index: 0, id: 'tool', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, timings: { predicted_ms: 500 } },
    ]);
    return stream([chunk({ content: 'Final [TASK COMPLETE]' }, 'stop'), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 15 }, timings: { predicted_ms: 500 } }]);
  } });
  assert.equal(stats.totalTokens, 50);
  assert.equal(stats.completionTokens, 20);
  assert.equal(stats.generationTime, 1);
  assert.equal(stats.tokensPerSecond, 20);
});

test('sequential turns reset counters and JSON timings are captured', async () => {
  const stats = [];
  for (const usage of [{ prompt_tokens: 10, completion_tokens: 5 }, { prompt_tokens: 2, completion_tokens: 1 }, null]) {
    await runMemoryChat({ ...base, onStats: value => stats.push(value), fetchImpl: async () => stream([chunk({ content: 'Reply' }, 'stop'), { choices: [], usage }]) });
  }
  assert.deepEqual(stats.map(value => value.totalTokens), [15, 3, null]);
  await runMemoryChat({ ...base, onStats: value => stats.push(value), fetchImpl: async () => Response.json({
    choices: [{ message: { content: 'JSON' }, finish_reason: 'stop' }], timings: { prompt_n: 3, predicted_n: 2, predicted_ms: 100 },
  }) });
  assert.equal(stats.at(-1).totalTokens, 5);
  assert.equal(stats.at(-1).tokensPerSecond, 20);
});

test('request sanitization normalizes native history and pairs missing IDs without collisions', async () => {
  const messages = [...base.messages,
    { role: 'user', content: { text: 'Hello' }, metadata: 'omit' },
    { role: 'assistant', toolCalls: [
      { name: 'save_memory', args: { content: 'Remember' } },
      { id: 'call_0', function: { name: 'search_memory', arguments: '{"query":"hello"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_0', content: { results: [] } },
    { role: 'tool' },
    { role: 'assistant', content: { text: 'Saved' } },
    { role: 'user' },
  ];
  const original = structuredClone(messages);
  await runMemoryChat({ ...base, messages, fetchImpl: async (_url, options) => {
    const sent = JSON.parse(options.body).messages;
    assert.deepEqual(sent[1], { role: 'user', content: '{"text":"Hello"}' });
    assert.deepEqual(sent[2], { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'save_memory', arguments: '{"content":"Remember"}' } },
      { id: 'call_0', type: 'function', function: { name: 'search_memory', arguments: '{"query":"hello"}' } },
    ] });
    assert.deepEqual(sent[3], { role: 'tool', tool_call_id: 'call_0', content: '{"results":[]}' });
    assert.deepEqual(sent[4], { role: 'tool', tool_call_id: 'call_1', content: '""' });
    assert.equal(sent[5].content, '{"text":"Saved"}');
    assert.equal(sent[6].content, null);
    return stream([chunk({ content: 'Done [TASK COMPLETE]' }, 'stop')]);
  } });
  assert.deepEqual(messages, original);
});

test('undefined tool output is serialized on the next tool round', async () => {
  let requests = 0;
  await runMemoryChat({ ...base, executeTool: async () => undefined, fetchImpl: async (_url, options) => {
    if (++requests === 1) return stream([
      chunk({ tool_calls: [{ index: 0, id: 'search', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls'),
    ]);
    assert.deepEqual(JSON.parse(options.body).messages.at(-1), { role: 'tool', tool_call_id: 'search', content: '""' });
    return stream([chunk({ content: 'Done [TASK COMPLETE]' }, 'stop')]);
  } });
});

test('unmatched tool results are rejected before fetching', async () => {
  await assert.rejects(runMemoryChat({ ...base,
    messages: [...base.messages, { role: 'tool', tool_call_id: 'unknown', content: 'result' }],
    fetchImpl: () => assert.fail('Must not fetch invalid history'),
  }), /no matching assistant tool call/);
});

test('HTTP failures log the complete response body and exact formatted request payload', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  let payload;
  const body = '{"error":{"message":"Invalid tool schema"}}';
  await assert.rejects(runMemoryChat({ ...base, fetchImpl: async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(body, { status: 400 });
  } }), /HTTP 400/);
  assert.deepEqual(logs, [
    ['Model request failed: HTTP 400', body],
    ['Model request payload:', JSON.stringify(payload, null, 2)],
  ]);
});

test('optimized image content parts remain multimodal in the request', async () => {
  const content = [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG_BASE64}` } }];
  await runMemoryChat({ ...base, messages: [...base.messages, { role: 'user', content }],
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).messages.at(-1).content, content);
      return stream([chunk({ content: 'An image' }, 'stop')]);
    },
  });
});

test('retrieved document context is injected once without mutating input history', async () => {
  const messages = [...base.messages, { role: 'user', content: 'What is alpha?' }];
  let retrievals = 0;
  await runMemoryChat({ ...base, messages,
    retrieveDocuments: async question => {
      retrievals++; assert.equal(question, 'What is alpha?');
      return [{ file_name: 'guide.pdf', chunk_index: 2, chunk_text: 'alpha is first' }];
    },
    fetchImpl: async (_url, options) => {
      const sent = JSON.parse(options.body).messages;
      assert.ok(sent[0].content.startsWith('Rules\n\n'));
      assert.equal(sent.filter(message => message.role === 'system').length, 1);
      assert.match(sent[0].content, /Context from attached documents:/);
      assert.match(sent[0].content, /Chunk 1: guide.pdf, segment 3/);
      assert.match(sent[0].content, /alpha is first/);
      assert.match(sent[0].content, /User Question: What is alpha/);
      return stream([chunk({ content: 'First.' }, 'stop')]);
    },
  });
  assert.equal(retrievals, 1);
  assert.equal(messages[0].content, 'Rules');
});

test('sampling defaults and live session overrides reach every tool round', async () => {
  let reads = 0, requests = 0;
  await runMemoryChat({ ...base,
    getSamplingParams: () => (++reads === 1 ? { temperature: 0, top_p: 0, top_k: 1, repeat_penalty: 1.5, max_tokens: 100 } : { temperature: 1.2 }),
    executeTool: async () => ({}),
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (++requests === 1) {
        assert.equal(payload.temperature, 0); assert.equal(payload.top_p, 0);
        assert.equal(payload.top_k, 1); assert.equal(payload.repeat_penalty, 1.5); assert.equal(payload.max_tokens, 100);
        return stream([chunk({ tool_calls: [{ index: 0, id: 'sampling-call', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls')]);
      }
      assert.equal(payload.temperature, 1.2); assert.equal(payload.top_p, 0.9);
      assert.equal(payload.top_k, 40); assert.equal(payload.repeat_penalty, 1.1); assert.equal(payload.max_tokens, -1);
      return stream([chunk({ content: 'Done [TASK COMPLETE]' }, 'stop')]);
    },
  });
  assert.equal(reads, 2);
});

test('execution timeline interleaves thought/tool cycles with parsed arguments and independent snapshots', async () => {
  const snapshots = [];
  let round = 0, clock = 0;
  const result = await runMemoryChat({ ...base, now: () => clock += 10,
    onExecutionSteps: steps => snapshots.push(steps),
    resolveTool: name => ({ toolName: name, serverName: 'mcp/test' }),
    executeTool: async () => { clock += 7000; return { processed: 0 }; },
    fetchImpl: async () => {
      round++;
      if (round <= 2) return stream([
        chunk({ content: '<thi' }), chunk({ content: `nk>Reason ${round}` }), chunk({ content: '</think>' }),
        chunk({ tool_calls: [{ index: 0, id: `call-${round}`, function: { name: 'search_memory', arguments: '{"query":"test"}' } }] }, 'tool_calls'),
      ]);
      return stream([chunk({ reasoning_content: 'Done thinking' }), chunk({ content: 'Final answer [TASK COMPLETE]' }, 'stop')]);
    },
  });
  assert.equal(result, 'Final answer [TASK COMPLETE]');
  const steps = snapshots.at(-1);
  assert.deepEqual(steps.map(step => step.type), ['thought', 'tool_call', 'thought', 'tool_call', 'thought']);
  assert.deepEqual(steps.filter(step => step.type === 'thought').map(step => step.content), ['Reason 1', 'Reason 2', 'Done thinking']);
  assert.ok(steps.filter(step => step.type === 'thought').every(step => step.durationMs < 7000 && step.endedAt >= step.startedAt));
  assert.equal(steps[1].serverName, 'mcp/test');
  assert.deepEqual(steps[1].args, { query: 'test' });
  assert.deepEqual(steps[1].result, { processed: 0 });
  assert.equal(steps[1].status, 'complete');
  assert.equal(snapshots.find(value => value[1]?.status === 'running')[1].result, undefined);
  assert.equal(snapshots[0].length, 1);
});

test('multiple thought blocks in one round remain separate', async () => {
  let steps;
  await runMemoryChat({ ...base, onExecutionSteps: value => steps = value,
    fetchImpl: async () => stream([chunk({ content: '<think>First</think>Text<think>Second</think>End' }, 'stop')]),
  });
  assert.deepEqual(steps.map(step => step.content), ['First', 'Second']);
});

test('tool failures, malformed arguments, and cancellation finalize the matching step', async () => {
  for (const mode of ['throws', 'malformed', 'cancelled']) {
    const controller = new AbortController();
    let steps, round = 0, executions = 0;
    const run = runMemoryChat({ ...base, signal: controller.signal, onExecutionSteps: value => steps = value,
      executeTool: async () => { executions++; if (mode === 'cancelled') controller.abort(); else throw new Error('Tool failed'); },
      fetchImpl: async () => ++round === 1
        ? stream([chunk({ tool_calls: [{ index: 0, id: 'failed', function: { name: 'search_memory', arguments: mode === 'malformed' ? '{' : '{}' } }] }, 'tool_calls')])
        : stream([chunk({ content: 'Recovered' }, 'stop')]),
    });
    if (mode === 'cancelled') await assert.rejects(run, { name: 'AbortError' }); else await run;
    assert.equal(steps[0].id, 'failed');
    assert.equal(steps[0].status, 'error');
    assert.equal(steps[0].result.isError, true);
    assert.equal(executions, mode === 'malformed' ? 0 : 1);
  }
});

test('every tool round sends one leading system message without mutating session history', async () => {
  const messages = [
    { role: 'system', content: 'Base instructions' }, { role: 'user', content: 'Question' },
    { role: 'system', content: 'Memory' }, { role: 'system', content: 'Summary' },
  ];
  let round = 0;
  await runMemoryChat({ ...base, messages, executeTool: async () => 'OK',
    fetchImpl: async (_url, options) => {
      const sent = JSON.parse(options.body).messages;
      assert.deepEqual(sent[0], { role: 'system', content: 'Base instructions\n\nMemory\n\nSummary' });
      assert.equal(sent.filter(message => message.role === 'system').length, 1);
      assert.deepEqual(sent[1], messages[1]);
      if (++round === 1) return stream([chunk({ tool_calls: [{ index: 0, id: 'call', function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls')]);
      assert.equal(sent[2].role, 'assistant');
      assert.equal(sent[3].role, 'tool');
      return stream([chunk({ content: 'Done [TASK COMPLETE]' }, 'stop')]);
    },
  });
  assert.equal(round, 2);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].content, 'Base instructions');
});

test('reasoning effort varies per request and is omitted when unsupported', async () => {
  const bodies = [];
  for (const reasoningEffort of ['low', 'high', undefined]) {
    await runMemoryChat({ ...base, reasoningEffort, fetchImpl: async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return stream([chunk({ content: 'Answer [TASK COMPLETE]' }), chunk({}, 'stop')]);
    } });
  }
  assert.deepEqual(bodies.map(body => body.chat_template_kwargs), [
    { reasoning_effort: 'low' }, { reasoning_effort: 'high' }, undefined,
  ]);
});


test('thinking budget aliases use resolved limits and omit max_thinking_tokens for unlimited', async () => {
  for (const [budget, context, expected] of [[-1, 8192, -1], [0, 8192, 0], [2500, 8192, 2500], [4096, 8192, 4096], [32768, 8192, 6144], [4096, 4353, 2304]]) {
    let payload;
    await runMemoryChat({ ...base, loadedContextSize: context,
      samplingParams: { thinking_budget: 256 }, getSamplingParams: async () => ({ thinking_budget: budget }),
      fetchImpl: async (_url, request) => {
        payload = JSON.parse(request.body);
        return stream([chunk({ content: 'OK' }), chunk({}, 'stop')]);
      },
    });
    assert.equal(payload.thinking_budget, expected);
    assert.equal(payload.reasoning_budget, expected);
    if (expected > 0) assert.equal(payload.max_thinking_tokens, expected);
    else assert.equal(Object.hasOwn(payload, 'max_thinking_tokens'), false);
  }
  await assert.rejects(runMemoryChat({ ...base, loadedContextSize: 2048,
    samplingParams: { thinking_budget: 256 }, fetchImpl: () => assert.fail('Must reject before fetch'),
  }), /context is too small/);
});

test('screenshot tools in user compatibility mode send image content after all tool replies', async () => {
  const requests = [];
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } };
  await runMemoryChat({ ...base, toolImageMode: 'user',
    chatTools: [{ type: 'function', function: { name: 'take_screenshot', parameters: { type: 'object' } } }],
    executeTool: async () => image,
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return requests.length === 1 ? stream([
        chunk({ tool_calls: [{ index: 0, id: 'screen1', function: { name: 'take_screenshot', arguments: '{}' } }] }),
        chunk({}, 'tool_calls'),
      ]) : stream([chunk({ content: 'I see the screen. [TASK COMPLETE]' }), chunk({}, 'stop')]);
    },
  });
  const messages = requests[1].messages;
  assert.equal(messages.at(-2).role, 'tool');
  assert.ok(!messages.at(-2).content.includes('base64'));
  assert.equal(messages.at(-1).role, 'user');
  assert.deepEqual(messages.at(-1).content[1], image);
});

test('stream accumulator defaults missing indexes, initializes sparse calls, and filters malformed entries', async () => {
  const { readCompletion } = await import('../src/lib/memoryChat.mjs');
  const result = await readCompletion(stream([
    chunk({ tool_calls: [null, { function: { name: 'save_', arguments: '{"content":' } },
      { index: 5, function: { name: 'search_memory', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: null, id: 'late_id', function: { name: 'memory', arguments: '"ok"}' } },
      { index: 2 }, { index: 3, function: { name: ' ', arguments: '{}' } },
      { index: 4, function: { name: {}, arguments: '{' } },
      { index: 6, function: { arguments: '[]' } }] }),
    chunk({}, 'tool_calls'),
  ]), () => {}, undefined, () => 1, () => {});
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls[0], { id: 'late_id', type: 'function',
    function: { name: 'save_memory', arguments: '{"content":"ok"}' } });
  assert.match(result.toolCalls[1].id, /^call_\d+_5$/);
  assert.equal(result.toolCalls[1].function.name, 'search_memory');
});

test('stream accumulator still rejects explicitly invalid indexes', async () => {
  const { readCompletion } = await import('../src/lib/memoryChat.mjs');
  for (const index of [-1, 0.5, '0', 16]) {
    await assert.rejects(readCompletion(stream([
      chunk({ tool_calls: [{ index, function: { name: 'save_memory', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ]), () => {}, undefined, () => 1, () => {}), /Invalid tool-call index/);
  }
});

for (const finishReason of ['tool_calls', 'stop']) {
  test(`tool deltas preserve cached metadata and recover trailing delimiters (${finishReason})`, async () => {
    const { readCompletion } = await import('../src/lib/memoryChat.mjs');
    const args = JSON.stringify({ content: 'Unicode বাংলা, braces } ], quote " and slash \\', nested: { values: [1, 2] } });
    const result = await readCompletion(stream([
      chunk({ tool_calls: [{ index: 0, id: 'cached', function: { name: 'save_memory', arguments: args.slice(0, 20) } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'cached', function: { name: 'save_memory', arguments: args.slice(20) } }] }),
      chunk({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: null } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '}\n```' } }] }),
      chunk({}, finishReason),
    ]), () => {}, undefined, () => 1, () => {});
    assert.deepEqual(result.toolCalls, [{ id: 'cached', type: 'function', function: { name: 'save_memory', arguments: args } }]);
  });
}

test('stop tool responses reject incomplete JSON and never salvage partial nested objects', async () => {
  const { readCompletion } = await import('../src/lib/memoryChat.mjs');
  for (const args of ['{"nested":{}', '{"value":"unfinished}', '{}{"other":1}', '{broken}}', '']) {
    await assert.rejects(readCompletion(stream([
      chunk({ tool_calls: [{ index: 0, function: { name: 'save_memory', arguments: args } }] }),
      chunk({}, 'stop'),
    ]), () => {}, undefined, () => 1, () => {}), /Incomplete tool-call/);
  }
});

test('complete arguments with a truncated finish reason still never execute', async () => {
  const { readCompletion } = await import('../src/lib/memoryChat.mjs');
  for (const reason of ['length', 'content_filter', null]) {
    await assert.rejects(readCompletion(stream([
      chunk({ tool_calls: [{ index: 0, function: { name: 'save_memory', arguments: '{}' } }] }),
      chunk({}, reason),
    ]), () => {}, undefined, () => 1, () => {}), /Incomplete tool-call/);
  }
});
