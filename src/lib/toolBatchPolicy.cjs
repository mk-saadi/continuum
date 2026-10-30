'use strict';

const MAX_TOOL_CALLS_PER_RESPONSE = 24;
const MAX_AUTOMATIC_READS = 72;
const MAX_AUTOMATIC_OUTPUT_BYTES = 2 * 1024 * 1024;
const TOOL_BATCH_GUIDANCE = `Prefer no more than ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls per response. If more operations are needed, split them into subsequent responses. Continuum may automatically process larger batches only when all operations are verified independent, read-only file operations. Mutating or uncertain oversized batches are rejected for correction.`;

// No argument values are copied into diagnostics. The call ID is the reference
// into the authorized assistant envelope retained in normal execution history.
function manifest(call, index, status, reason) {
  return { position: index + 1, toolName: call.function.name, toolCallId: call.id,
    argumentSummary: 'Arguments retained in original tool call; reference toolCallId.', status, reason };
}

function operationKey(call) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify([call.function.name, canonical(JSON.parse(call.function.arguments || '{}'))]);
}

async function planToolBatch(calls, { allowedNames, preflight, signal, maxAutomaticReads = MAX_AUTOMATIC_READS } = {}) {
  if (calls.length <= MAX_TOOL_CALLS_PER_RESPONSE) return null;
  let safe = calls.length <= Math.min(MAX_AUTOMATIC_READS, maxAutomaticReads) && typeof preflight === 'function';
  const ids = calls.map(call => call.id);
  safe &&= ids.every(id => typeof id === 'string' && id.trim()) && new Set(ids).size === ids.length;
  const malformed = new Set();
  // Validate the entire batch before consulting execution/authorization semantics.
  for (const call of calls) {
    try {
      if (call.argumentError || !allowedNames.has(call.function.name)) throw new Error();
      const args = JSON.parse(call.function.arguments || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    } catch {
      safe = false;
      // Anthropic serializes tool-use arguments as JSON objects. Preserve a
      // valid rejected envelope, never echo malformed/sensitive payload text.
      try { JSON.parse(call.function.arguments || '{}'); } catch { malformed.add(call); call.function.arguments = '{}'; }
    }
  }
  if (safe) {
    for (const call of calls) {
      signal?.throwIfAborted();
      try { if (await preflight(call) !== true) safe = false; }
      catch (error) { signal?.throwIfAborted(); safe = false; }
    }
  }
  signal?.throwIfAborted();
  return { safe, skipped: calls.map((call, index) => safe ? null :
    { ...manifest(call, index, 'rejected',
      `Whole batch not executed: authorization, read-only semantics or independence could not be established. Split into dependency-aware batches of ${MAX_TOOL_CALLS_PER_RESPONSE} or fewer.`), ...(malformed.has(call) ? { argumentSummary: 'Malformed JSON arguments omitted; not executed.' } : {}) }) };
}

// Revalidate the complete next slice before starting any operation in it.
async function checkReadBatch(calls, { preflight, checkState, signal, outputBytes = 0 }) {
  signal?.throwIfAborted();
  if (outputBytes >= MAX_AUTOMATIC_OUTPUT_BYTES) return 'aggregate output limit';
  const state = await checkState?.();
  if (state?.canContinue === false) return 'permissions changed';
  for (const call of calls) {
    signal?.throwIfAborted();
    try { if (await preflight(call) !== true) return 'read safety or authorization changed'; }
    catch (error) { signal?.throwIfAborted(); return 'read safety or authorization changed'; }
  }
  return null;
}
module.exports = { MAX_AUTOMATIC_READS, MAX_AUTOMATIC_OUTPUT_BYTES, checkReadBatch, manifest, MAX_TOOL_CALLS_PER_RESPONSE, TOOL_BATCH_GUIDANCE, planToolBatch, operationKey };
