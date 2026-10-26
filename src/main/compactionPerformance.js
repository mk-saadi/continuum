'use strict';
const { createHash } = require('node:crypto');
// Disjoint UTF-8 attribution of the exact JSON body. Token estimates are not
// tokenizer measurements; template overhead is only known from the full count.
function requestComposition(payload, measured = {}) {
  const json = JSON.stringify(payload);
  const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const categories = Object.fromEntries(['systemAndDeveloper', 'toolSchemas', 'taskBriefsAndConstraints', 'recentTurns', 'protectedToolRounds', 'checkpoint', 'workLogAndTaskState', 'subagentState'].map(key => [key, 0]));
  const checkpointDetails = [];
  const add = (key, value) => { categories[key] = (categories[key] ?? 0) + bytes(value); };
  if (payload.tools) add('toolSchemas', payload.tools);
  for (const message of payload.messages ?? []) {
    const text = typeof message.content === 'string' ? message.content : '';
    if (['system', 'developer'].includes(message.role)) {
      add('systemAndDeveloper', message);
      // memoryChat coalesces system sections; attribute complete bounded blocks
      // instead of classifying the whole merged instruction as a checkpoint.
      const blocks = [
        ['taskBriefsAndConstraints', /\[WORKSPACE TASK BRIEF\][\s\S]*?\[END OF WORKSPACE TASK BRIEF\]/g],
        ['workLogAndTaskState', /\[WORKSPACE WORK LOG\][\s\S]*?\[END OF WORKSPACE WORK LOG\]/g],
        ['checkpoint', /\[WORKSPACE CHECKPOINT\][^\n]*\n[^\n]*/g],
      ];
      for (const [key, pattern] of blocks) for (const match of text.matchAll(pattern)) {
        const size = bytes(match[0]) - 2;
        categories[key] += size; categories.systemAndDeveloper -= size;
        if (key === 'checkpoint') try {
          const state = JSON.parse(match[0].slice(match[0].indexOf('\n') + 1));
          checkpointDetails.push(Object.fromEntries(['evidence', 'taskReferences', 'plan', 'pending', 'research', 'outstandingRequirements'].map(field => [field, { bytes: bytes(state[field] ?? null), estimatedTokens: Math.ceil(bytes(state[field] ?? null) / 3) }])));
        } catch { /* Legacy prose is not structured JSON. */ }
      }
    } else add(message.role === 'tool' || message.tool_calls?.length ? 'protectedToolRounds' : 'recentTurns', message);
  }
  const serializedBytes = Buffer.byteLength(json, 'utf8');
  categories.otherJsonOverhead = serializedBytes - Object.values(categories).reduce((a,b) => a+b, 0);
  return { payloadHash: createHash('sha256').update(json).digest('hex'), serializedBytes,
    checkpointDetails, checkpointDetailMethod: 'nested-unescaped-json-estimates-not-additive-to-body-categories',
    inputTokens: measured.tokens ?? null, measurementMethod: measured.method ?? 'unavailable',
    attributionMethod: 'disjoint-json-utf8-bytes; per-category tokens estimated at bytes/3; template overhead unattributed',
    categories: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, { bytes: value, estimatedTokens: Math.ceil(value / 3) }])) };
}
function softTarget(tokens, budget, requested = 17000) {
  const target = Number.isSafeInteger(requested) && requested > 0 ? requested : 17000;
  return { targetTokens: Math.min(target, budget), preferredRange: [15000, 17000],
    status: tokens <= Math.min(target, budget) ? 'within-soft-target' : 'retained-state-exceeds-soft-target',
    hardLimitTokens: budget, additionalGenerationRequested: false };
}
module.exports = { requestComposition, softTarget };
