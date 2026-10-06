'use strict';

const { chatCompletion } = require('./providers/localProvider');

// Pass-through seam between subagent executions and model generation. Today one
// execution maps to exactly one awaited request against the single local
// provider: no queueing, no concurrency, no model routing, no background runs.
// Future scheduling (inference slots, multi-model selection, parallel children)
// belongs here, without touching the session or execution layers.
async function scheduleInference({ engine, payload, signal, fetchImpl }) {
  return chatCompletion({ engine, payload, signal, fetchImpl });
}

module.exports = { scheduleInference };
