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
