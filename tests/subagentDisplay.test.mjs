import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentUsageLines, subagentResultTitle } from '../src/lib/subagentDisplay.mjs';

test('legacy and missing token usage are unavailable rather than measured zero', () => {
  assert.match(subagentUsageLines({}).join('\n'), /input tokens: unavailable/);
  assert.match(subagentUsageLines({ usage: { completion_tokens: 0 } }).join('\n'), /output tokens: 0/);
  assert.match(subagentUsageLines({ usage: { prompt_tokens: 42 } }).join('\n'), /coverage unavailable/);
});
test('effective child limits and shared parent snapshot remain distinct', () => {
  const lines = subagentUsageLines({ accounting: {
    toolCalls: 2, blockedCalls: 1, turns: 4, aggregateToolCalls: 7, aggregateLimit: 40,
    inputTokens: 1000, inputCoverage: 'mixed', outputTokens: 522, outputMeasured: 10,
    outputReserved: 512, outputCoverage: 'reserved', finalizationAttempted: true,
    finalizationStopReason: 'output_budget',
    effective: { maxToolCalls: 10, maxTurns: 8, inputBudget: 32000, outputBudget: 16000 },
  } }).join('\n');
  assert.match(lines, /Child tool calls: 2 \/ 10; blocked attempts: 1/);
  assert.match(lines, /model requests: 4 \/ 8/);
  assert.match(lines, /shared snapshot\): 7 \/ 40/);
  assert.match(lines, /1,000 \/ 32,000 \(mixed\)/);
  assert.match(lines, /\(reserved\); measured: 10; reserved: 512/);
  assert.match(lines, /Reporting attempted; stopped: output_budget/);
});
test('output labels preserve completed, partial, cancellation and failure distinctions', () => {
  assert.equal(subagentResultTitle('completed'), 'Final answer');
  assert.equal(subagentResultTitle('partial'), 'Partial findings');
  for (const status of ['failed', 'cancelled', 'interrupted']) assert.equal(subagentResultTitle(status), 'Returned output');
});
test('zero-request accounting is explicitly unavailable', () => {
  const lines = subagentUsageLines({ accounting: { inputTokens: 0, inputCoverage: 'unavailable', outputTokens: 0, outputCoverage: 'unavailable' } }).join('\n');
  assert.match(lines, /input tokens: 0 \/ unavailable \(unavailable\)/);
  assert.match(lines, /output tokens accounted: 0 \/ unavailable \(unavailable\)/);
});
