'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { approve, Ledger, outputCap } = require('../src/main/compactionBudgetPlanner');
const { decision } = require('../src/main/compactionTrigger');
test('seeded worst-case reservations and conservative accounting across context capacities', () => {
  for (const capacity of [8192, 41984, 55000, 131072]) for (let seed = 1; seed <= 500; seed++) {
    let state = seed;
    const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
    const stages = Array.from({ length: 1 + random(30) }, () => {
      const output = 1024 + random(3073);
      const input = { tokens: random(capacity), method: random(10) ? 'server-template-tokenizer' : 'approximate-full-request', limit: capacity };
      return { output, input, correctionInput: { ...input, tokens: input.tokens + random(300) } };
    });
    const plan = approve(stages);
    if (!plan.ok) continue;
    const context = `capacity=${capacity}, seed=${seed}`;
    assert.ok(plan.reserved <= 32768, context);
    const ledger = new Ledger();
    for (const [index, stage] of stages.entries()) for (let attempt = 0; attempt < 2; attempt++) {
      assert.ok(stage.input.tokens + stage.output + 128 <= capacity, context);
      assert.ok(stage.correctionInput.tokens + stage.output + 128 <= capacity, context);
      const id = `${index}:${attempt}`;
      ledger.reserve(id, stage.output);
      ledger.settle(id, random(2) ? stage.output : undefined);
      assert.throws(() => ledger.settle(id, 0), { code: 'generation-reservation-state' });
      assert.throws(() => ledger.reserve(id, 1), { code: 'generation-token-budget' });
      assert.ok(ledger.charged >= 0 && ledger.charged <= ledger.pool, context);
    }
    assert.equal(ledger.charged, plan.reserved, context);
  }
});
test('tiny evidence retains a valid structured output floor; caps respond to complexity', () => {
  assert.equal(outputCap({}, 8192), 1536);
  assert.equal(outputCap('a'.repeat(200000), 131072), 4096);
  assert.equal(approve([{ output: 1536, input: null, correctionInput: null }]).ok, false);
});
test('adaptive trigger uses headroom, growth and meaningful evidence; unchanged boundaries suppress', () => {
  for (const capacity of [8192, 41984, 55000, 131072]) {
    const input = { inputTokens: capacity - 1024, usableInput: capacity, projectedGrowth: 1024, uncoveredOperations: 24 };
    assert.equal(decision(input).trigger, true);
    assert.equal(decision({ ...input, unchanged: true }).trigger, false);
    assert.equal(decision({ ...input, uncoveredOperations: 1 }).trigger, false);
    assert.equal(decision({ ...input, inputTokens: 1024 }).trigger, false);
  }
});
test('activity labels distinguish full, partial and degraded checkpoints', async () => {
  const { activityLabel } = await import('../src/lib/compactionActivity.mjs');
  assert.match(activityLabel({status:'completed',metadata:{checkpointOutcome:'full'}}),/Full checkpoint/);
  assert.match(activityLabel({status:'completed',metadata:{checkpointOutcome:'partial',coverageMessages:10}}),/10 messages/);
  assert.match(activityLabel({status:'completed',metadata:{checkpointOutcome:'degraded'}}),/reduced semantic fidelity/);
});
