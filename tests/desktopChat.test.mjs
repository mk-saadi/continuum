import test from 'node:test';
import assert from 'node:assert/strict';
import { runDesktopChat } from '../src/lib/desktopChat.mjs';

test('authoritative invoke stats reach the save callback even without a final stats event', async () => {
  const oldWindow = globalThis.window;
  const expected = { promptTokens: 10, completionTokens: 5, totalTokens: 15, time: 1, tokensPerSecond: 5 };
  let stats = null, removed = false, listener;
  globalThis.window = { chatAPI: {
    onEvent: callback => { listener = callback; return () => { removed = true; }; },
    run: async ({ requestId }) => {
      listener({ requestId: 'stale-turn', type: 'stats', stats: { totalTokens: 999 } });
      listener({ requestId, type: 'text', delta: 'Done' });
      return { text: 'Done', stats: expected };
    },
  } };
  try {
    const result = await runDesktopChat({ modelId: 'test', messages: [], onStats: value => { stats = value; } });
    assert.deepEqual(stats, expected);
    assert.deepEqual(result.stats, expected);
    assert.equal(removed, true);
  } finally { globalThis.window = oldWindow; }
});

test('document indexing scopes progress events and removes listeners', async () => {
  const { indexDesktopDocuments } = await import('../src/lib/desktopChat.mjs');
  const oldWindow = globalThis.window;
  let listener, removed = false;
  const progress = [];
  globalThis.window = {
    chatAPI: { onEvent: fn => { listener = fn; return () => { removed = true; }; }, cancel: async () => {} },
    api: { indexDocuments: async ({ requestId, attachments }) => {
      assert.equal(attachments.length, 1);
      listener({ requestId: 'old', type: 'indexing', completed: 99 });
      listener({ requestId, type: 'indexing', completed: 1, total: 2 });
      return ['managed.pdf'];
    } },
  };
  try {
    assert.deepEqual(await indexDesktopDocuments([{ file_path: 'managed.pdf' }], { onProgress: p => progress.push(p) }), ['managed.pdf']);
    assert.equal(progress.length, 3);
    assert.equal(progress[0], null);
    assert.equal(progress[1].completed, 1);
    assert.equal(progress[2], null);
    assert.equal(removed, true);
  } finally { globalThis.window = oldWindow; }
});

test('stream updates batch every 50ms and flush the final short burst', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldWindow = globalThis.window;
  let listener, requestId, finish, removed = false;
  const text = [], thinking = [], stats = [];
  globalThis.window = { chatAPI: {
    onEvent: callback => { listener = callback; return () => { removed = true; }; },
    run: payload => { requestId = payload.requestId; return new Promise(resolve => { finish = resolve; }); },
  } };
  try {
    const chat = runDesktopChat({ modelId: 'test', messages: [], onText: value => text.push(value),
      onThinking: value => thinking.push(value), onStats: value => stats.push(value) });
    for (let i = 0; i < 100; i++) {
      listener({ requestId, type: 'text', delta: 'x' });
      listener({ requestId, type: 'thinking', thinking: { text: `Reasoning ${i}` } });
    }
    assert.equal(text.length, 0);
    t.mock.timers.tick(49);
    assert.equal(text.length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(text, ['x'.repeat(100)]);
    assert.deepEqual(thinking, [{ text: 'Reasoning 99' }]);
    listener({ requestId, type: 'text', delta: 'final' });
    listener({ requestId, type: 'stats', stats: { totalTokens: 1 } });
    finish({ text: 'x'.repeat(100) + 'final', stats: { totalTokens: 101 } });
    await chat;
    assert.deepEqual(text, ['x'.repeat(100), 'final']);
    assert.deepEqual(stats, [{ totalTokens: 101 }]);
    assert.equal(removed, true);
    t.mock.timers.tick(100);
    assert.equal(text.length, 2);
  } finally { globalThis.window = oldWindow; }
});

for (const outcome of ['error', 'abort']) {
  test(`pending text and thinking flush on ${outcome} without a delayed timer`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const oldWindow = globalThis.window;
    const controller = new AbortController();
    let listener, requestId, fail, removed = false;
    const text = [], thinking = [];
    globalThis.window = { chatAPI: {
      onEvent: callback => { listener = callback; return () => { removed = true; }; },
      run: payload => { requestId = payload.requestId; return new Promise((resolve, reject) => { fail = reject; }); },
      cancel: async () => { fail(new Error('Cancelled')); },
    } };
    try {
      const chat = runDesktopChat({ modelId: 'test', messages: [], signal: controller.signal,
        onText: value => text.push(value), onThinking: value => thinking.push(value) });
      listener({ requestId, type: 'text', delta: 'Partial' });
      listener({ requestId, type: 'thinking', thinking: { text: 'Partial thought' } });
      if (outcome === 'abort') controller.abort();
      else fail(new Error('Disconnected'));
      await assert.rejects(chat, outcome === 'abort' ? { name: 'AbortError' } : /Disconnected/);
      assert.deepEqual(text, ['Partial']);
      assert.deepEqual(thinking, [{ text: 'Partial thought' }]);
      assert.equal(removed, true);
      t.mock.timers.tick(100);
      assert.equal(text.length, 1);
    } finally { globalThis.window = oldWindow; }
  });
}


test('indexing resets discard buffered progress before generation and on completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldWindow = globalThis.window;
  let listener, requestId, finish;
  const progress = [];
  globalThis.window = { chatAPI: {
    onEvent: callback => { listener = callback; return () => {}; },
    run: payload => { requestId = payload.requestId; return new Promise(resolve => { finish = resolve; }); },
  } };
  try {
    const chat = runDesktopChat({ modelId: 'model', messages: [], onIndexing: value => progress.push(value) });
    assert.deepEqual(progress, [null]);
    listener({ requestId, type: 'indexing', stage: 'Indexed', fileName: 'old.txt' });
    listener({ requestId, type: 'indexing', progress: null });
    t.mock.timers.tick(50);
    assert.deepEqual(progress, [null, null]);
    listener({ requestId: 'old-request', type: 'indexing', stage: 'Indexed' });
    listener({ requestId, type: 'text', delta: 'Answer' });
    finish({ text: 'Answer' });
    await chat;
    assert.deepEqual(progress, [null, null, null]);
  } finally { globalThis.window = oldWindow; }
});

test('failed chat clears indexing progress after flushing pending events', async () => {
  const oldWindow = globalThis.window;
  const progress = [];
  let listener;
  globalThis.window = { chatAPI: {
    onEvent: callback => { listener = callback; return () => {}; },
    run: async ({ requestId }) => {
      listener({ requestId, type: 'indexing', stage: 'Parsing', fileName: 'new.txt' });
      throw new Error('Indexing failed');
    },
  } };
  try {
    await assert.rejects(runDesktopChat({ modelId: 'model', messages: [], onIndexing: value => progress.push(value) }), /Indexing failed/);
    assert.equal(progress[0], null);
    assert.equal(progress.at(-1), null);
  } finally { globalThis.window = oldWindow; }
});

test('reasoning choice reaches normal and regenerated requests', async () => {
  const oldWindow = globalThis.window;
  const requests = [];
  const run = async payload => { requests.push(payload); return {}; };
  globalThis.window = { chatAPI: { onEvent: () => () => {}, run }, memoryPalace: { regenerateLast: run } };
  try {
    await runDesktopChat({ modelId: 'test', messages: [], reasoningEffort: 'low' });
    await runDesktopChat({ modelId: 'test', messages: [], reasoningEffort: 'high', regenerate: true });
    await runDesktopChat({ modelId: 'other', messages: [] });
    assert.deepEqual(requests.map(request => request.reasoningEffort), ['low', 'high', undefined]);
    assert.equal(Object.hasOwn(requests[2], 'reasoningEffort'), false);
  } finally { globalThis.window = oldWindow; }
});

test('live tool events populate one preparing card and transition through authoritative steps', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldWindow = globalThis.window;
  let listener, requestId, finish;
  const snapshots = [];
  globalThis.window = { chatAPI: {
    onEvent: callback => { listener = callback; return () => {}; },
    run: payload => { requestId = payload.requestId; return new Promise(resolve => { finish = resolve; }); },
  } };
  try {
    const chat = runDesktopChat({ modelId: 'test', messages: [], onExecutionSteps: steps => snapshots.push(steps) });
    listener({ requestId: 'other', type: 'tool_start', id: 'wrong', functionName: 'wrong' });
    listener({ requestId, type: 'tool_start', id: 'xml1', functionName: 'str_replace_editor' });
    listener({ requestId, type: 'tool_chunk', id: 'xml1', parameter: 'new_str', content: 'const ' });
    listener({ requestId, type: 'tool_chunk', id: 'xml1', parameter: 'new_str', content: 'x = 1;' });
    t.mock.timers.tick(50);
    assert.equal(snapshots[0].length, 1);
    assert.equal(snapshots[0][0].status, 'preparing');
    assert.equal(snapshots[0][0].streamingArguments, 'new_str:\nconst x = 1;');
    const final = [{ id: 'xml1', type: 'tool_call', toolName: 'str_replace_editor', status: 'complete', args: { new_str: 'const x = 1;' } }];
    listener({ requestId, type: 'step-update', executionSteps: final });
    finish({ text: '', executionSteps: final });
    await chat;
    assert.deepEqual(snapshots.at(-1), final);
    assert.equal(snapshots[0][0].status, 'preparing', 'previous snapshots remain immutable');
  } finally { globalThis.window = oldWindow; }
});

for (const regenerate of [false, true]) test(`cloud target reaches ${regenerate ? 'regeneration' : 'chat'} IPC`, async () => {
  const oldWindow = globalThis.window;
  const activeChatProvider = { type: 'cloud', provider: 'anthropic', model: 'claude-test' };
  let captured;
  const run = async payload => { captured = payload; return { text: 'OK' }; };
  globalThis.window = { chatAPI: { onEvent: () => () => {}, run }, memoryPalace: { regenerateLast: run } };
  try {
    await runDesktopChat({ activeChatProvider, modelId: 'cloud:anthropic:claude-test', messages: [], regenerate });
    assert.deepEqual(captured.activeChatProvider, activeChatProvider);
    assert.equal(captured.modelId, 'cloud:anthropic:claude-test');
  } finally { globalThis.window = oldWindow; }
});
