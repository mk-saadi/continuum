'use strict';
const { readExecutionSteps } = require('./executionSteps');

function parseJson(value, fallback = null) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
}

function variantFromRow(row) {
  const stats = parseJson(row.stats);
  return {
    content: row.content,
    executionSteps: readExecutionSteps(row),
    ...(row.execution_steps == null ? { thinking: row.thinking_text ?? null, thinking_duration: row.thinking_duration ?? null, tool_calls: parseJson(row.tool_calls, []) } : {}),
    model_name: row.model_name ?? null,
    model_id: row.model_id ?? null,
    agent_name: row.agent_name ?? null,
    stats: stats ? { ...stats, tokens_per_sec: stats.tokens_per_sec ?? stats.tokensPerSecond ?? null,
      total_tokens: stats.total_tokens ?? stats.totalTokens ?? null, duration: stats.duration ?? stats.time ?? null } : null,
    created_at: row.created_at ?? null,
  };
}

function parseVariants(row) {
  const variants = parseJson(row.variants);
  if (!Array.isArray(variants) || !variants.length || !variants.every(value =>
    typeof value === 'string' || (value && typeof value.content === 'string'))) return [variantFromRow(row)];
  return variants.map((value, index) => {
    if (typeof value !== 'string') return { ...value, executionSteps: readExecutionSteps(value) };
    // Only the selected legacy reply has reliable row-level metadata.
    return variantFromRow(index === (row.active_variant_index ?? 0)
      ? { ...row, content: value } : { content: value });
  });
}

module.exports = { variantFromRow, parseVariants };
