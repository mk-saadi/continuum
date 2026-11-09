'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/main/conversationCompaction');
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
function fixture(limit = 2000) {
  const messages = [{ role: 'system', content: 'Current instructions' }];
  for (let i = 0; i < 12; i++) messages.push({ role: 'user', content: `Turn ${i} ${'x'.repeat(500)}` });
  const saved = [], requests = [];
  const payload = { model: 'model', messages, tools: [{ type: 'function', function: { name: 'read' } }], max_tokens: 200 };
  return { owner: {}, payload, force: true, saved, requests,
    measure: async p => ({ tokens: Math.ceil(JSON.stringify(p).length / 4), limit, reserve: p.max_tokens, method: 'test-estimate' }),
    generate: async p => { requests.push(p); return reply('Consolidated objective and next actions.'); },
    save: async value => { saved.push(value); } };
}
test('one tool-free Markdown generation, original history unchanged, instructions and recent corrections retained', async () => {
  const f = fixture(); const original = structuredClone(f.payload);
  f.payload.messages.at(-1).content = 'Correction: use the new API';
  original.messages.at(-1).content = f.payload.messages.at(-1).content;
  const result = await core.compact(f);
  assert.equal(result.compressed, true); assert.equal(f.requests.length, 1); assert.equal(f.saved.length, 1);
  assert.deepEqual(f.payload, original); assert.deepEqual(f.requests[0].tools, []);
  assert.equal(result.payload.messages[0].content, 'Current instructions');
  assert.equal(result.payload.messages.at(-1).content, 'Correction: use the new API');
});
test('staging has complete disjoint coverage and consolidates each previous summary', async () => {
  const f = fixture(1400); f.oldSummary = 'EARLIER';
  const result = await core.compact(f); assert.equal(result.compressed, true); assert.ok(f.requests.length > 1);
  const inputs = f.requests.map(r => JSON.parse(r.messages[1].content));
  assert.equal(inputs[0].previousSummary, 'EARLIER');
  assert.equal(inputs[1].previousSummary, 'Consolidated objective and next actions.');
  const covered = inputs.flatMap(i => i.conversation);
  assert.deepEqual([...covered, ...result.tail], f.payload.messages.slice(1));
});
test('short requests avoid inference', async () => {
  const f = fixture(100000); f.force = false;
  assert.equal((await core.compact(f)).reason, 'below-threshold'); assert.equal(f.requests.length, 0);
});
test('tool rounds are indivisible and pending results reject', () => {
  const round = [{ role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] }, { role: 'tool', tool_call_id: 'b' }, { role: 'tool', tool_call_id: 'a' }];
  assert.deepEqual(core.units(round), [round]); assert.throws(() => core.units(round.slice(0, 2)), /unfinished-tool-round/);
});
test('empty, truncated, tool-calling and interrupted responses never commit', async () => {
  for (const r of [reply(''), { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, { choices: [{ finish_reason: 'stop', message: { content: 'x', tool_calls: [{}] } }] }, {}]) {
    const f = fixture(); f.generate = async () => r;
    await assert.rejects(core.compact(f), /incomplete-summary/); assert.equal(f.saved.length, 0);
  }
});
test('cancellation, changed sources, and persistence failures prevent success', async () => {
  const f = fixture(), c = new AbortController(); f.signal = c.signal;
  f.generate = async () => { c.abort(); return reply('x'); };
  await assert.rejects(core.compact(f), { name: 'AbortError' }); assert.equal(f.saved.length, 0);
  const changed = fixture(); changed.isCurrent = () => false;
  await assert.rejects(core.compact(changed), /source-changed/); assert.equal(changed.saved.length, 0);
  const failed = fixture(); failed.save = async () => { throw Object.assign(new Error('write failed'), { code: 'persistence-failed' }); };
  await assert.rejects(core.compact(failed), /write failed/);
});
test('rejected proactive summary is deferred once for an unchanged source and capacity', async () => {
  const f = fixture(2300); f.force = false; f.payload.max_tokens = 400;
  f.generate = async p => { f.requests.push(p); throw new Error('provider temporarily unavailable'); };
  await core.compact(f); await core.compact(f); assert.equal(f.requests.length, 1);
});
test('oversized single complete historical unit never silently disappears', async () => {
  const f = fixture(); f.payload.messages[1].content = 'X'.repeat(40000);
  const result = await core.compact(f);
  assert.equal(result.compressed, false); assert.equal(result.reason, 'historical-unit-exceeds-summary-capacity'); assert.equal(f.saved.length, 0);
});
test('legacy oversized prior summary is fully staged before newer history', async () => {
  const f = fixture(2000); f.oldSummary = 'LEGACY'.repeat(4000);
  const result = await core.compact(f); assert.equal(result.compressed, true); assert.ok(f.requests.length > 1);
  const conversation = f.requests.flatMap(p => JSON.parse(p.messages[1].content).conversation);
  const old = conversation.filter(m => m.content.startsWith('[Prior summary fragment')).map(m => m.content.replace(/^\[Prior summary fragment \d+\]\n/, '')).join('');
  assert.equal(old, f.oldSummary);
});
test('media stays in native parts rather than encoded JSON source text', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
  const content = core.summaryContent('', [{ role: 'user', content: [{ type: 'text', text: 'inspect this' }, image] }]);
  assert.equal(content[1], image); assert.ok(!content[0].text.includes('base64'));
});
test('forced recovery accepts a smaller fitting request even below ten percent savings', async () => {
  const f = fixture(10000); f.payload.max_tokens = 500;
  f.measure = async p => ({ tokens: p.messages.some(m => m.content?.startsWith(core.MARKER)) ? 7600 : p.messages[0]?.content === core.PROMPT ? 1000 : 8000,
    limit: 10000, reserve: p.max_tokens, method: 'test-estimate' });
  const result = await core.compact(f); assert.equal(result.compressed, true); assert.equal(result.before.tokens - result.after.tokens, 400);
});
test('the existing completion parser exposes XML tool calls even with tools disabled', async () => {
  const parser = require('../src/main/subagents/providers/streamCompletion');
  const result = await parser.readCompletion(Response.json(reply('<tool_call>{"name":"read_project_file","arguments":{"relative_path":"x"}}</tool_call>')));
  assert.throws(() => core.summaryText(result), /incomplete-summary/);
});
test('runtime warnings can consolidate while current system instructions remain independent', async () => {
  const f = fixture(); f.payload.messages.splice(2,0,{role:'system',compactionHistory:true,content:'Old runtime warning'});
  const result = await core.compact(f); assert.equal(result.compressed,true);
  assert.match(JSON.stringify(f.requests),/Old runtime warning/);
  assert.ok(!result.payload.messages.some(m=>m.content==='Old runtime warning'));
  assert.equal(result.payload.messages[0].content,'Current instructions');
});
