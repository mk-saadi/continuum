import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMessageForDisplay, compactStepsForDisplay, TOOL_DISPLAY_LIMIT } from '../src/lib/toolDisplay.mjs';

test('large tool results stay in persistence input while chat state receives a capped preview', () => {
  const raw = 'x'.repeat(100_000);
  const saved = { role: 'assistant', executionSteps: [{ type: 'tool_call', result: raw }] };
  const display = compactMessageForDisplay(saved);
  assert.equal(saved.executionSteps[0].result, raw);
  assert.ok(display.executionSteps[0].result.length < TOOL_DISPLAY_LIMIT + 100);
  assert.match(display.executionSteps[0].result, /truncated in chat/);
});

test('completed tool previews retain identity while a later tool streams', () => {
  const first = compactStepsForDisplay([
    { id: 'done', type: 'tool_call', toolName: 'read_file', status: 'complete', result: 'saved' },
    { id: 'live', type: 'tool_call', toolName: 'search', status: 'preparing', streamingArguments: 'a' },
  ]);
  const next = compactStepsForDisplay([
    { id: 'done', type: 'tool_call', toolName: 'read_file', status: 'complete', result: 'saved' },
    { id: 'live', type: 'tool_call', toolName: 'search', status: 'preparing', streamingArguments: 'ab' },
  ], first);
  assert.equal(next[0], first[0]);
  assert.notEqual(next[1], first[1]);
  assert.equal(next[1].streamingArguments, 'ab');
});
