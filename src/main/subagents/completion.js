'use strict';

// Phase 1.5 — the single, backend-aware completion classifier.
//
// A model turn is only a *complete* answer when the provider says the turn
// ended normally AND the transport delivered a finished stream. Every other
// terminal shape is an incomplete turn and must never be reported as a
// successful completion:
//
//   stop / end_turn / stop_sequence / eos / eos_token            -> complete
//   length / max_tokens / max_output_tokens / token_limit / …    -> truncated
//   content_filter / safety / blocked / prohibited_content       -> filtered
//   a stream that ended with neither [DONE] nor a finish reason  -> interrupted
//
// The finish-reason vocabulary is deliberately a superset of the backends this
// app talks to (llama.cpp / OpenAI-compatible, Anthropic, Responses-style), so
// a provider that spells "ran out of room" differently still classifies as
// truncated instead of silently as a normal stop. This module is pure: it has
// no runtime state, no I/O, and no dependency on the loop, so the child agent
// loop and the one-shot executions share exactly one decision.
//
// Phase 1.5 fix: before this existed, only the literal finish reason `length`
// was treated as truncated. A provider that reported `max_tokens` (or a
// filtered/`content_filter` turn) with visible content was reported as a
// *completed* child, and an SSE stream that simply stopped early was reported
// as completed too. Both are false successes; both now classify as incomplete.

const COMPLETION = Object.freeze({
  COMPLETE: 'complete',
  TRUNCATED: 'truncated',
  FILTERED: 'filtered',
  INTERRUPTED: 'interrupted',
});

// Normal turns: the provider explicitly ended the generation.
const CLEAN_FINISH_REASONS = new Set([
  'stop', 'end_turn', 'stop_sequence', 'eos', 'eos_token', 'completed', 'complete',
]);
// The response hit its token/length ceiling: a truncated, incomplete answer.
const TRUNCATED_FINISH_REASONS = new Set([
  'length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens',
  'token_limit', 'length_limit', 'truncated',
]);
// The provider refused or removed the content: never a normal completion.
const FILTERED_FINISH_REASONS = new Set([
  'content_filter', 'content-filter', 'safety', 'blocked', 'prohibited_content',
]);

function normalizeFinishReason(reason) {
  return typeof reason === 'string' ? reason.trim().toLowerCase() : null;
}

/**
 * Coarse class of a finish reason, independent of content or transport.
 * `unknown` means the backend sent a reason this app does not recognize (or
 * none at all in a non-streaming body, which local servers commonly omit).
 */
function finishReasonClass(reason) {
  const value = normalizeFinishReason(reason);
  if (!value) return 'unknown';
  if (TRUNCATED_FINISH_REASONS.has(value)) return 'truncated';
  if (FILTERED_FINISH_REASONS.has(value)) return 'filtered';
  if (CLEAN_FINISH_REASONS.has(value)) return 'clean';
  if (value === 'tool_calls' || value === 'function_call') return 'tools';
  return 'unknown';
}

/**
 * The one completion classification a caller needs. `streamInterrupted` wins
 * over every finish reason: a stream that ended without a terminal marker is
 * never trusted, even if a stray finish reason was observed earlier.
 *
 * An unrecognized (or absent) finish reason is treated as complete: several
 * supported local servers omit `finish_reason` on ordinary JSON completions,
 * and inventing an incomplete verdict there would break valid answers. The
 * transport-level interruption flag is what covers the streaming case where
 * "no finish reason" actually means "the stream was cut".
 */
function classifyCompletion({ finishReason = null, streamInterrupted = false } = {}) {
  if (streamInterrupted === true) return COMPLETION.INTERRUPTED;
  const kind = finishReasonClass(finishReason);
  if (kind === 'truncated') return COMPLETION.TRUNCATED;
  if (kind === 'filtered') return COMPLETION.FILTERED;
  return COMPLETION.COMPLETE;
}

// Every non-complete class maps to the existing, non-renewable-by-default
// `incomplete_response` stop reason. No new terminal reason is introduced.
const INCOMPLETE_STOP_REASON = 'incomplete_response';

function stopReasonFor(completion) {
  return completion === COMPLETION.COMPLETE ? 'completed' : INCOMPLETE_STOP_REASON;
}

module.exports = {
  COMPLETION,
  INCOMPLETE_STOP_REASON,
  CLEAN_FINISH_REASONS,
  TRUNCATED_FINISH_REASONS,
  FILTERED_FINISH_REASONS,
  finishReasonClass,
  classifyCompletion,
  stopReasonFor,
};
