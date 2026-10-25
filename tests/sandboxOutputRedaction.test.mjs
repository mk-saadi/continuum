import test from 'node:test';
import assert from 'node:assert/strict';
import { formatToolResult } from '../src/lib/toolResultFormatter.mjs';
import { sanitizeChatMessages } from '../src/lib/memoryChat.mjs';
const secrets = 'api_key=synthetic-sensitive-value\n-----BEGIN PRIVATE KEY-----\nsynthetic-private-content\n-----END PRIVATE KEY-----\nghp_1234567890abcdefghij\n' + 'Abc123'.repeat(12);
test('model output redacted recursively before context; user card preserves original with marker', () => {
  const raw = { success: false, stdout: secrets, stderr: 'token=synthetic-sensitive-value' };
  const r = formatToolResult(raw, 'execute_command');
  assert.equal(r.displayResult.stdout, secrets);
  assert.equal(r.displayResult.modelOutputRedacted, true);
  for (const secret of ['synthetic-sensitive-value', 'synthetic-private-content', 'ghp_1234567890abcdefghij', 'Abc123'.repeat(12)]) assert.ok(!r.content.includes(secret));
  assert.match(r.content, /redacted/);
});
test('history replay also redacts command results', () => {
  const rows = sanitizeChatMessages([{ role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'execute_command', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call', content: JSON.stringify({ stdout: secrets }) }]);
  assert.ok(!rows.at(-1).content.includes('synthetic-sensitive-value'));
});
test('ordinary output remains byte-identical and is not marked', () => {
  const r = formatToolResult('{ "stdout": "hello" }', 'execute_command');
  assert.equal(r.content, '{ "stdout": "hello" }'); assert.equal(r.redacted, false);
});
