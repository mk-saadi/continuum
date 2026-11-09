'use strict';
// Candidate-local accounting. Unknown usage remains fully charged; refunds are
// deliberately disabled. Completion of an approved plan never needs a refund.
const POOL = 32768;
const SAFETY = 128;
const error = code => Object.assign(new Error(code), { code });
function outputCap(value, capacity) {
  const complexity = JSON.stringify(value).length;
  return Math.min(4096, Math.floor(capacity * .3), Math.max(1536, 1024 + Math.ceil(complexity / 32)));
}
function approve(stages, { pool = POOL, hardCeiling = 64 } = {}) {
  if (!Array.isArray(stages) || !stages.length || stages.length > hardCeiling) return { ok: false, reason: 'generation-plan-stage-ceiling' };
  let reserved = 0;
  for (const stage of stages) {
    if (!Number.isSafeInteger(stage.output) || stage.output < 1) return { ok: false, reason: 'generation-plan-invalid' };
    // Each stage owns its primary request and one guaranteed correction.
    reserved += stage.output * 2;
    for (const measurement of [stage.input, stage.correctionInput]) {
      if (measurement?.method !== 'server-template-tokenizer' || !Number.isSafeInteger(measurement.tokens) || measurement.tokens < 0)
        return { ok: false, reason: 'generation-measurement-unavailable' };
      if (!Number.isSafeInteger(measurement.limit) || measurement.tokens + stage.output + SAFETY > measurement.limit)
        return { ok: false, reason: 'generation-plan-context-overflow' };
    }
  }
  return reserved <= pool ? { ok: true, reserved, correctionReserve: reserved / 2, stages: stages.length, pool }
    : { ok: false, reason: 'generation-plan-token-budget', reserved, pool };
}
class Ledger {
  constructor(pool = POOL) { this.pool = pool; this.charged = 0; this.entries = new Map(); }
  reserve(id, output) {
    if (this.entries.has(id) || !Number.isSafeInteger(output) || output < 1 || output > this.pool - this.charged)
      throw error('generation-token-budget');
    this.entries.set(id, { reserved: output, actual: null }); this.charged += output;
  }
  settle(id, usage) {
    const entry = this.entries.get(id);
    if (!entry || entry.settled) throw error('generation-reservation-state');
    entry.settled = true;
    entry.actual = Number.isSafeInteger(usage) && usage >= 0 ? usage : null;
    // Provider errors/truncation/unknown usage retain the full charge too.
  }
}
module.exports = { POOL, SAFETY, approve, outputCap, Ledger };
