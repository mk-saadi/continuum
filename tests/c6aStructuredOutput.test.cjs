'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeJSON } = require('../src/main/structuredOutput');
const { validate, summarizeCasual, KEYS } = require('../src/main/casualSummary');
const value = () => Object.fromEntries(KEYS.map(k => [k, k === 'instructions' ? ['Keep requirements and report failures.'] : []]));
const envelope = (content, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });
for (const [name, wrap] of [
  ['plain', s => s], ['Gemma fence', s => '```json\n' + s + '\n```'],
  ['Qwen BOM whitespace', s => '\uFEFF \n' + s + '\n'], ['trailing comma', s => s.slice(0, -1) + ',}'],
]) test(`C6-A Casual ${name} validates without inference`, () => {
  const d = {}; assert.deepEqual(JSON.parse(validate(envelope(wrap(JSON.stringify(value()))), d)), value());
  assert.equal(d.normalization, name === 'plain' ? 'unchanged' : 'repaired');
});
test('syntax repair preserves quoted delimiters and escaped quotes', () => {
  assert.deepEqual(normalizeJSON('{"s":"comma,} quote\\\"", "a":[1,],}').value, { s: 'comma,} quote"', a: [1] });
});
for (const bad of ['{"a":[,]}', '{"a":1,,}', 'text {"a":1}', '```json\n{}\n```\nmore', '{"a":1', '{"a":"unterminated}']) test('ambiguous or incomplete JSON rejected: ' + bad, () => assert.throws(() => normalizeJSON(bad), { code: 'invalid-json' }));
test('root extras explicitly stripped, mandatory categories never defaulted or coerced', () => {
  assert.deepEqual(JSON.parse(validate(envelope(JSON.stringify({ ...value(), schemaVersion: 1 })))), value());
  for (const v of [{ ...value(), criticalFindings: ['Must preserve this finding.'] }, { ...value(), references: [{ path: 'invented' }] }, { ...value(), instructions: 'Keep requirements' }, Object.fromEntries(Object.entries(value()).filter(([k]) => k !== 'instructions'))]) {
    assert.throws(() => validate(envelope(JSON.stringify(v))), { code: 'casual-summary-invalid' });
  }
});
test('valid-looking interrupted or truncated summary never accepted', () => {
  for (const reason of ['length', 'max_tokens', null]) assert.throws(() => validate(envelope(JSON.stringify(value()), reason)));
});
const measure = async () => ({ tokens: 100, limit: 8192, budget: 7000, method: 'server-template-tokenizer', budgetContract: { capacityMethod: 'runtime-reported' } });
const options = { modelId: 'fixture', url: 'http://fixture', messageBatch: [{ id: 1, role: 'user', content: 'Keep requirements and report failures.' }], measure, onDiagnostics: () => {} };
test('Casual fence consumes one inference and schema reaches generation boundary', async () => {
  let calls = 0;
  const result = await summarizeCasual({ ...options, generate: async request => { calls++; assert.deepEqual(request.response_format.schema.oneOf[0].required, KEYS); return envelope('```json\n' + JSON.stringify(value()) + '\n```'); } });
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(result), value());
});
test('Casual schema failure has exactly one bounded corrective attempt', async () => {
  let calls = 0; const diagnostics = [];
  const result = await summarizeCasual({ ...options, onDiagnostics: r => diagnostics.push(r), generate: async request => {
    calls++; if (calls === 1) return envelope(JSON.stringify({ ...value(), references: { path: 'a.md' } }));
    assert.match(request.messages.at(-1).content, /requiredFields/); return envelope(JSON.stringify(value()));
  } });
  assert.deepEqual(JSON.parse(result), value()); assert.equal(calls, 2); assert.equal(diagnostics[0].normalization, 'corrected');
});
test('Casual persistent failure bounded at two, truncation never corrected', async () => {
  let calls = 0;
  await assert.rejects(summarizeCasual({ ...options, generate: async () => { calls++; return envelope('{}'); } }), { code: 'casual-summary-invalid' });
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(summarizeCasual({ ...options, generate: async () => { calls++; return envelope(JSON.stringify(value()), 'length'); } }), { code: 'casual-summary-output-truncated' });
  assert.equal(calls, 1);
});
test('temporary counting failure retries before any inference; persistent estimates never activate', async () => {
  let counts = 0, calls = 0;
  await summarizeCasual({ ...options, measure: async () => ++counts === 1 ? { ...await measure(), method: 'approximate-full-request' } : measure(), generate: async () => { calls++; return envelope(JSON.stringify(value())); } });
  assert.equal(counts, 2); assert.equal(calls, 1);
  await assert.rejects(summarizeCasual({ ...options, measure: async () => ({ ...await measure(), method: 'approximate-full-request' }), generate: async () => { assert.fail('No inference without exact count'); } }), { code: 'casual-source-measurement-unavailable' });
});
