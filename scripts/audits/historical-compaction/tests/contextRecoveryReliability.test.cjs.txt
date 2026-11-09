'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reserveTokens, isContextOverflow } = require('../src/main/contextBudget');
const { compactTranscript } = require('../src/main/compactionCore');
const { backend } = require('./fixtures/contextBackend.cjs');
const url = 'http://localhost/v1/chat/completions';
const payload = { messages: [{ role: 'system', content: 'Protected permission rules' }, { role: 'user', content: 'Current objective' }], max_tokens: 1024, tools: [] };
const send = (b, body, limit, extra = {}) => b.fetch(url, { method: 'POST', body: JSON.stringify(body), contextWindowLimit: limit, ...extra });

for (const limit of [32768, 50000, 100000]) {
  test(`${limit} local window admits the exact usable boundary and rejects one token above`, async () => {
    const budget = limit - reserveTokens(payload, limit);
    for (const offset of [-1, 0, 1]) {
      const b = backend({ context: limit, tokens: budget + offset });
      if (offset > 0) await assert.rejects(send(b, payload, limit), { code: 'CONTEXT_BUDGET_EXCEEDED' });
      else assert.equal((await send(b, payload, limit)).status, 200);
      assert.equal(b.calls.length, offset > 0 ? 0 : 1);
    }
  });
}

test('dynamic schema expansion and removal use the next request, independent of cached/cumulative usage', async () => {
  const b = backend({ context: 32768, tokens: text => Math.ceil(text.length / 3), infer: () => Response.json({ usage: {
    prompt_tokens: 2000000, prompt_tokens_details: { cached_tokens: 1900000 }, completion_tokens: 10,
  } }) });
  await send(b, payload, 32768);
  const tools = [{ type: 'function', function: { name: 'activated_tool', description: 'New MCP tool', parameters: {
    type: 'object', properties: { options: { type: 'string', enum: ['x'.repeat(100000)] } },
  } } }];
  await assert.rejects(send(b, { ...payload, tools }, 32768), /cannot fit/);
  assert.equal(b.calls.length, 1);
  await send(b, payload, 32768);
  assert.equal(b.calls.length, 2);
  assert.deepEqual(b.calls[1].tools, []);
});

test('oversized result recovers once, retains tool pairs and does not replay the completed operation', async () => {
  let recoveries = 0;
  const messages = [...payload.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: 'RESULT'.repeat(20000) }];
  const b = backend({ context: 32768, tokens: text => Math.ceil(text.length / 3) });
  await send(b, { ...payload, messages }, 32768, { contextRecovery: async ({ payload: current }) => {
    recoveries++;
    return { ...current, messages: current.messages.map(m => m.role === 'tool' ? { ...m, content: 'Explicit excerpt; raw result remains stored.' } : m) };
  } });
  assert.equal(recoveries, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].messages.at(-1).tool_call_id, 'read-1');
  assert.equal(b.calls[0].messages.at(-2).tool_calls[0].id, 'read-1');
});

test('reasoning is within output reservation and never discounted by cache hits', () => {
  assert.equal(reserveTokens({ max_tokens: 4096, reasoning_budget_tokens: 2048, cache_prompt: true }, 32768), 4224);
  assert.equal(reserveTokens({ max_tokens: 1024, reasoning_budget_tokens: 4096 }, 32768), 4224);
});

for (const [method, fraction] of [['approximate-full-request', .75], ['server-template-tokenizer', .78]]) {
  for (const delta of [-1, 0, 1]) test(`${method} compaction threshold ${delta < 0 ? 'below' : delta ? 'above' : 'exactly at'}`, async () => {
    const limit = 10000, reserve = 1000, tokens = fraction * limit - reserve + delta;
    const adapter = { snapshot: () => ({ candidates: [] }), measure: async () => ({ limit, reserve, tokens, method }) };
    const result = await compactTranscript({ adapter, payload });
    assert.equal(result.reason, delta < 0 ? 'below-threshold' : 'protected-context-too-large');
  });
}

test('provider overflow classification distinguishes Anthropic, OpenRouter, local and unrelated failures', () => {
  for (const error of [
    { type: 'invalid_request_error', message: 'prompt is too long: 100001 tokens > 100000 maximum' },
    { code: 'context_length_exceeded' }, { code: 'prompt_too_long' },
    { type: 'exceed_context_size_error', n_prompt_tokens: 33000, n_ctx: 32768 },
  ]) assert.equal(isContextOverflow({ status: 400, responseBody: JSON.stringify({ error }) }), true);
  for (const error of [{ status: 429 }, { status: 500 }, { name: 'AbortError', code: 'CONTEXT_BUDGET_EXCEEDED' },
    { status: 400, responseBody: JSON.stringify({ error: { type: 'invalid_request_error', message: 'invalid tool schema' } }) }]) {
    assert.equal(isContextOverflow(error), false);
  }
});

test('shared-core workspace simulation: 660 mock tool calls retain plan, files, steering and retrieval across compactions', async () => {
  // This exercises the production shared compaction core with a controlled
  // transcript adapter. The real child loop is covered separately by the
  // long-horizon benchmark; this is not a desktop IPC end-to-end claim.
  const { validatePairs } = require('../src/main/subagents/contextRecovery');
  const { approximateTokens } = require('../src/main/contextBudget');
  const runId = 'deterministic-workspace-run';
  const objective = 'Create every requested file; retain EARLY_VALUE=17 and finish the plan.';
  let messages = [{ role: 'system', content: 'Workspace identity: pagoda fixture. Preserve permission rules.' },
    { role: 'user', content: objective }];
  const raw = [], files = new Map(), writes = new Set(), events = [];
  const plan = { objective, completed: 0, total: 220 };
  let summary = null, checkpoint = null, version = 0, generations = 0, requests = 0;
  const limit = 4096;
  const estimate = text => Math.ceil(String(text ?? '').length / 3);
  const measure = async value => ({ tokens: approximateTokens(value), reserve: reserveTokens(value, limit), limit, method: 'approximate-full-request' });
  const adapter = {
    estimate, measure, validate: validatePairs,
    snapshot: value => {
      validatePairs(messages);
      const rounds = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'assistant') continue;
        const round = [messages[i]];
        const count = messages[i].tool_calls.length;
        for (let n = 0; n < count; n++) round.push(messages[++i]);
        rounds.push(round);
      }
      const eligible = rounds.slice(0, -2);
      return { version, oldSummary: summary, checkpoint, payload: value,
        pinned: messages.filter(m => m.role === 'user' || (m.role === 'system' && !m.derived)),
        candidates: eligible.map(round => ({ round, content: JSON.stringify(round), estimated_tokens: approximateTokens({ messages: round }) })),
        tail: rounds.slice(eligible.length).flat() };
    },
    summarize: async (old, rows) => {
      generations++;
      assert.ok(rows.length);
      assert.match(`${old ?? ''}${JSON.stringify(rows)}`, /EARLY_VALUE=17/);
      return 'EARLY_VALUE=17. Created files remain in the workspace; retrieve earlier results from the raw work log. Continue the saved plan.';
    },
    checkpointInput: () => ({ objective }),
    draftCheckpoint: async () => { generations++; return { objective, nextActions: ['Continue saved plan; honor latest steering.'] }; },
    validationContext: () => ({ briefs: [{ id: 1, content_text: objective }], index: new Map() }),
    buildPayload: (snapshot, nextSummary, section, count) => ({ ...snapshot.payload, messages: [
      ...snapshot.pinned,
      ...(nextSummary ? [{ role: 'system', derived: true, content: nextSummary }] : []),
      ...(section ? [{ ...section, derived: true }] : []),
      ...snapshot.candidates.slice(count).flatMap(row => row.round), ...snapshot.tail,
    ] }),
    commit: async (_snapshot, candidate) => {
      validatePairs(candidate.payload.messages);
      messages = candidate.payload.messages; summary = candidate.summary; checkpoint = candidate.checkpoint;
      version++;
      events.push({ runId, before: candidate.before.tokens, after: candidate.after.tokens, reserve: candidate.after.reserve, limit });
    },
  };
  for (let turn = 0; turn <= 220; turn++) {
    if (turn === 75) messages.push({ role: 'user', content: 'LIVE STEERING: use blue roofs for all remaining files.' });
    let next = { messages, tools: [], max_tokens: 256 };
    const compacted = await compactTranscript({ adapter, payload: next });
    next = compacted.payload ?? next;
    const usage = await measure(next);
    assert.ok(usage.tokens + usage.reserve <= limit);
    validatePairs(next.messages); requests++;
    if (turn >= 75) assert.equal(next.messages.filter(m => String(m.content).includes('LIVE STEERING:')).length, 1);
    if (turn === 220) break;
    const names = ['read_project_file', 'write_project_file', 'update_plan'];
    const calls = names.map((name, n) => ({ id: `${turn}-${n}`, type: 'function', function: { name, arguments: JSON.stringify({ path: `file-${turn}` }) } }));
    const round = [{ role: 'assistant', content: null, tool_calls: calls }];
    for (const [n, call] of calls.entries()) {
      let content;
      if (n === 0) content = 'EARLY_VALUE=17\n' + 'Large file read evidence. '.repeat(24);
      else if (n === 1) {
        assert.equal(writes.has(turn), false); writes.add(turn);
        files.set(`file-${turn}`, turn >= 75 ? 'blue roof' : 'original roof'); content = 'Write completed exactly once.';
      } else { plan.completed++; content = JSON.stringify(plan); }
      round.push({ role: 'tool', tool_call_id: call.id, content });
    }
    messages.push(...round); raw.push(...structuredClone(round));
  }
  assert.ok(version >= 3); assert.equal(plan.completed, plan.total);
  assert.equal(writes.size, 220); assert.equal(files.size, 220);
  assert.equal(raw.filter(m => m.role === 'tool').length, 660);
  assert.match(raw.find(m => m.tool_call_id === '0-0').content, /EARLY_VALUE=17/);
  assert.equal(files.get('file-219'), 'blue roof');
  assert.equal(checkpoint.objective, objective);
  assert.equal(checkpoint.outstandingRequirements[0].text, objective);
  assert.ok(summary.length < 200);
  assert.ok(events.every(event => event.runId === runId && event.after < event.before));
  validatePairs(messages);
  console.error('[workspace core simulation] ' + JSON.stringify({ toolCalls: 660, writes: writes.size, requests,
    generations, compactions: version, first: events[0], last: events.at(-1), outcome: 'completed' }));
});
