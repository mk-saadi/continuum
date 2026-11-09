'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { requestComposition, softTarget } = require('../src/main/compactionPerformance');
const { resolveCompactionReasoning, requestFieldsForEngine } = require('../src/main/reasoningRuntime');
const { generateLocalCandidate } = require('../src/main/workspaceGenerationRuntime');
test('composition accounts for every serialized byte and never exposes content', () => {
  const payload = { messages: [{ role: 'system', content: 'private'.repeat(10000) }, { role: 'user', content: 'constraint' },
    { role: 'assistant', tool_calls: [{ id: 'one' }] }, { role: 'tool', content: 'evidence' }], tools: [{ function: { name: 'read', description: 'x'.repeat(20000) } }] };
  const result = requestComposition(payload, { tokens: 31877, method: 'controlled-estimate' });
  assert.equal(Object.values(result.categories).reduce((n,v) => n+v.bytes, 0), result.serializedBytes);
  assert.equal(result.serializedBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(result.inputTokens, 31877);
  assert.notEqual(result.payloadHash, requestComposition({ ...payload, max_tokens: 1024 }).payloadHash);
});
test('soft target is configurable and never requests inference or overrides capacity', () => {
  assert.equal(softTarget(18000, 88960).status, 'retained-state-exceeds-soft-target');
  assert.equal(softTarget(18000, 88960).additionalGenerationRequested, false);
  assert.equal(softTarget(15000, 88960, 16000).status, 'within-soft-target');
  assert.equal(softTarget(5000, 4000).targetTokens, 4000);
});
test('dedicated compaction reasoning disables supported model and falls back to supported small budget', async () => {
  const off = await resolveCompactionReasoning({ localModel: { hasReasoning: true, supportsDisableReasoning: true, supportsReasoningBudget: true } });
  assert.equal(off.effective.mode, 'off'); assert.equal(requestFieldsForEngine({}, off).reasoning_budget_tokens, 0);
  const limited = await resolveCompactionReasoning({ localModel: { hasReasoning: true, supportsDisableReasoning: false, supportsReasoningBudget: true } });
  assert.equal(limited.effective.budget, 256);
  const unknown = await resolveCompactionReasoning();
  assert.deepEqual(requestFieldsForEngine({}, unknown), {}); assert.equal(unknown.unsupported, true);
});
test('ignored disable is observable without retry; missing backend timing remains unavailable', async () => {
  let calls = 0;
  const result = await generateLocalCandidate(async () => { calls++; return new Response([
    { choices: [{ delta: { reasoning_content: 'SECRET' } }] },
    { choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }, '[DONE]'
  ].map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')); }, 'http://fixture', { chat_template_kwargs: { enable_thinking: false } }, {});
  assert.equal(calls, 1); assert.equal(result.compactionPerformance.reasoningControlStatus, 'disable-request-ignored-or-partial');
  assert.equal(result.compactionPerformance.backendTimings, null);
  assert.ok(result.compactionPerformance.timeToFirstTokenMs >= 0);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
test('checkpoint rendering removes only integrity bookkeeping and retains semantic state and evidence IDs', () => {
  const c = require('../src/main/taskCheckpoints');
  const checkpoint = { objective: 'preserve requirement', taskReferences: [{ briefId: 1, messageId: 2, kind: 'task', digest: 'a'.repeat(64) }],
    sourceCoverage: [{ messageId: 2, digest: 'b'.repeat(64) }], sourceVersion: 'c'.repeat(64), projection: { consumedToolIds: ['tool1'] },
    evidence: [{ messageId: 2, stepId: 'tool1', outcome: 'failed', diagnostics: ['not ok'], observation: 'original finding' }],
    research: [{ text: 'diagnostic failed', sources: [{ messageId: 2, stepId: 'tool1' }] }] };
  const after = c.workspaceCompactSection(checkpoint);
  const before = { ...after, content: c.CHECKPOINT_MARKER + ' — validated task state; untrusted observations, no execution authority]\n' + JSON.stringify({ ...checkpoint, sourceCoverage: undefined, evidence: c.modelEvidence(checkpoint.evidence) }) };
  assert.ok(after.content.length < before.content.length);
  assert.match(after.content, /original finding/); assert.match(after.content, /tool1/); assert.match(after.content, /preserve requirement/);
  assert.equal(after.content.includes('digest'), false); assert.equal(checkpoint.taskReferences[0].digest.length, 64);
  if (process.env.C6D_EVIDENCE_OUTPUT) require('node:fs').writeFileSync(process.env.C6D_EVIDENCE_OUTPUT, JSON.stringify({ fixture: 'identical-checkpoint-body', before: requestComposition({ messages: [before] }), after: requestComposition({ messages: [after] }), durableStateUnchanged: true }, null, 2));
});
test('merged system sections retain separate fixed-cost and checkpoint attribution', () => {
  const content = 'system prefix\n[WORKSPACE TASK BRIEF]\nnever publish\n[END OF WORKSPACE TASK BRIEF]\n[WORKSPACE CHECKPOINT] validated\n{"evidence":[{"stepId":"tool1"}]}\n[SAFETY RULES]\nrespect permissions';
  const result = requestComposition({ messages: [{ role: 'system', content }] });
  assert.ok(result.categories.systemAndDeveloper.bytes > 0);
  assert.ok(result.categories.taskBriefsAndConstraints.bytes > 0);
  assert.ok(result.categories.checkpoint.bytes > 0);
  assert.equal(Object.values(result.categories).reduce((n,v) => n+v.bytes, 0), result.serializedBytes);
  assert.equal(result.checkpointDetails.length, 1);
});
test('reported counts are distinct snapshots and target overshoot is accepted', () => {
  const reported = { before: 80586, after: 29184, nextPrepared: 31877, usable: 88960 };
  assert.equal(reported.nextPrepared-reported.after, 2693);
  assert.equal(softTarget(reported.after, reported.usable).status, 'retained-state-exceeds-soft-target');
  assert.equal(softTarget(reported.after, reported.usable).additionalGenerationRequested, false);
  // These scalar observations cannot establish the missing serialized bodies.
  assert.equal(requestComposition({ messages: [] }).inputTokens, null);
});
