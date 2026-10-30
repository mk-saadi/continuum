'use strict';
const { createHash } = require('node:crypto');
// Disjoint UTF-8 attribution of the exact JSON body. Token estimates are not
// tokenizer measurements; template overhead is only known from the full count.
function requestComposition(payload, measured = {}, { summaryContent } = {}) {
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
      if (summaryContent && text.includes(summaryContent)) {
        const size = bytes(summaryContent) - 2;
        categories.checkpoint += size; categories.systemAndDeveloper -= size;
      }
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

// Tokenizer ablations of complete provider requests. Costs overlap (e.g. a
// file attachment inside a brief) and are never presented as an additive sum.
async function measuredComposition(payload, measure, full, { eligibleToolIds = [], summaryContent } = {}) {
  const lastUser = (payload.messages ?? []).findLastIndex(m => m.role === 'user');
  const patterns = {
    checkpoint: /\[WORKSPACE CHECKPOINT\][^\n]*\n[^\n]*/g,
    taskBriefs: /\[WORKSPACE TASK BRIEF\][\s\S]*?\[END OF WORKSPACE TASK BRIEF\]/g,
    activeBriefs: /\[Brief #\d+ — (?:original request|revised instruction[^\]]*|follow-up instruction)\]:[\s\S]*?\[End of brief #\d+\]/g,
    persistentBriefs: /\[Brief #\d+ — applicable persistent constraint\]:[\s\S]*?\[End of brief #\d+\]/g,
    sourceNavigation: /^(?!\s*\{)[^\n]*(?:source_message_id|source_step_id|source_brief_id|semantic navigation)[^\n]*$/gm,
    historicalBriefs: /\[Brief #\d+ — historical[^\]]*\]:[\s\S]*?\[End of brief #\d+\]/gi,
    worklogs: /\[WORKSPACE WORK LOG\][\s\S]*?\[END OF WORKSPACE WORK LOG\]/g,
    plan: /\[WORKSPACE TASK PLAN\][\s\S]*?\[END OF WORKSPACE TASK PLAN\]/g,
    attachments: /\[Attached File:[^\]]*\][\s\S]*?\[End of Attached File\]/g,
  };
  const reasons = {
    system: 'Mandatory base instructions and session safety/navigation rules.',
    toolSchemas: 'Currently enabled tool contracts; compaction cannot revoke capabilities.',
    currentUser: 'Current authoritative user instruction.',
    taskBriefs: 'Selected active/persistent instructions and unresolved dependencies remain authoritative.',
    activeBriefs: 'Active user requirements remain authoritative.',
    persistentBriefs: 'Applicable persistent constraints cannot be removed for a numeric target.',
    sourceNavigation: 'Retrieval and source navigation instructions preserve access to original evidence.',
    historicalBriefs: 'Only history/dependencies still selected by the C6-E brief policy.',
    checkpoint: 'Validated working state, retained requirements, outcomes and retrieval references.',
    protectedToolRounds: 'Two most recent complete rounds and following runtime events stay verbatim.',
    eligibleToolRounds: 'Older completed rounds can be replaced after source validation.',
    rawToolArguments: 'Arguments belong to protocol pairs; protected calls remain unchanged.',
    toolResults: 'Protected protocol results remain paired; eligible originals stay durable.',
    worklogs: 'Existing bounded turn digest policy; may overlap findings in the checkpoint.',
    plan: 'Current durable plan is the authoritative plan, also referenced by checkpoint state.',
    attachments: 'Current selected briefs/user attachments remain required source material.',
  };
  const eligible = new Set(eligibleToolIds);
  const entries = {};
  for (const key of Object.keys(reasons)) {
    const variant = structuredClone(payload);
    if (key === 'toolSchemas') variant.tools = [];
    else variant.messages = variant.messages.flatMap((m, i) => {
      const toolId = m.tool_call_id ?? m.tool_calls?.[0]?.id;
      if (key === 'system' && ['system','developer'].includes(m.role)) {
        // Remove only base text; named contextual blocks are measured separately.
        if (typeof m.content === 'string') m.content = [summaryContent && m.content.includes(summaryContent) ? summaryContent : '', ...['checkpoint','taskBriefs','worklogs','plan'].flatMap(key => [...m.content.matchAll(patterns[key])].map(match => match[0]))].filter(Boolean).join('\n');
      } else if (key === 'currentUser' && i === lastUser) m.content = '';
      else if (key === 'rawToolArguments') { for (const call of m.tool_calls ?? []) if (call.function) call.function.arguments = '{}'; }
      else if (key === 'toolResults' && m.role === 'tool') m.content = '';
      else if (key === 'attachments' && Array.isArray(m.content)) m.content = m.content.filter(part => !['image_url','image','file','document','input_image','input_file'].includes(part.type));
      else if (key === 'eligibleToolRounds' && toolId && eligible.has(toolId)) return [];
      else if (key === 'protectedToolRounds' && toolId && !eligible.has(toolId)) return [];
      else if (patterns[key] && typeof m.content === 'string') {
        if (key === 'checkpoint' && summaryContent) m.content = m.content.replace(summaryContent, '');
        m.content = m.content.replace(patterns[key], '');
      }
      return [m];
    });
    if (JSON.stringify(variant) === JSON.stringify(payload)) {
      entries[key] = { marginalTokens: 0, reason: reasons[key], present: false }; continue;
    }
    let measured;
    try { measured = await measure(variant); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      entries[key] = { marginalTokens: null, method: 'unavailable', reason: reasons[key], present: true };
      continue;
    }
    entries[key] = { marginalTokens: full.tokens - measured.tokens, method: measured.method,
      reason: reasons[key], present: true };
  }
  return { totalTokens: full.tokens, method: full.method, attribution: 'full-request-ablation; overlapping non-additive costs; includes normalization/template effects', entries };
}
module.exports.measuredComposition = measuredComposition;
