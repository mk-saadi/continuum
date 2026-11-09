'use strict';
// Confidential, bounded activity data. Never send to console/notifications.
const { randomUUID } = require('node:crypto');
const MAX_RECORDS = 24, MAX_TEXT = 512;
function redact(value) {
  return String(value ?? '').replace(/\b(?:api[_-]?key|access[_-]?token|approval[_-]?token|password|secret|authorization)\s*[:=]\s*[^\s,;]+|\bbearer\s+[^\s,;]+|\bsk-[a-zA-Z0-9_-]+|-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/gi, '[REDACTED]').slice(0, MAX_TEXT);
}
function capture(error, draft, evidence) {
  const f = error.feedback ?? {}, entry = draft?.[f.category]?.[f.entryIndex];
  const refs = (Array.isArray(entry?.sources) ? entry.sources : entry?.stepRef ? [entry.stepRef] : []).filter(ref => ref && typeof ref === 'object').slice(0, 16);
  return { schemaVersion: 1, candidateId: randomUUID(), timestamp: new Date().toISOString(),
    failureCode: error.code, failureCategory: f.category ?? 'structure',
    fieldPath: f.category != null && Number.isInteger(f.entryIndex) ? `${f.category}[${f.entryIndex}]` : null,
    claim: entry ? redact(entry.text ?? entry.path) : null, evidenceQuote: entry?.evidenceQuote == null ? null : redact(entry.evidenceQuote),
    requiredEvidence: f.requiredEvidence ?? null,
    sources: refs.map(ref => { const parts = evidence.filter(e => e.messageId === ref.messageId && e.stepId === ref.stepId);
      return { messageId: Number.isSafeInteger(ref.messageId) ? ref.messageId : null, stepId: redact(ref.stepId), exists: parts.length > 0,
        partial: parts.length ? parts.some(e => e.observationPartial === true) : null,
        outcomes: [...new Set(parts.map(e => e.outcome))].slice(0, 4) }; }) };
}
function record(diagnostics, error, context) {
  const rows = diagnostics.rejections ??= [];
  if (rows.length >= MAX_RECORDS) return;
  const captured = error.rejectionDiagnostic ?? capture(error, null, []);
  for (const previous of rows) if (previous.correctedCandidateId === rowsIdentity(diagnostics, context.generationStage, context.batchIndex, context.correctionAttempt))
    previous.claimChanged = previous.claim == null || captured.claim == null ? null : previous.claim !== captured.claim;
  rows.push({ ...captured, ...context, candidateId: rowsIdentity(diagnostics, context.generationStage, context.batchIndex, context.correctionAttempt) });
}
function rowsIdentity(diagnostics, stage, batch, attempt) {
  const key = `${stage}:${batch}:${attempt}`;
  const identities = diagnostics.rejectionCandidateIdentities ??= {};
  return identities[key] ??= randomUUID();
}
function outcome(diagnostics, stage, batchIndex, attempt, code = null, draft = null) {
  for (const row of diagnostics.rejections ?? []) if (row.generationStage === stage && row.batchIndex === batchIndex) {
    if (attempt > row.correctionAttempt) { row.correctionAttempted = true; row.correctionOutcome = code ? 'rejected' : 'validated'; row.correctionRejectionCode = code;
      row.correctedCandidateId = rowsIdentity(diagnostics, stage, batchIndex, attempt);
      const match = /^(\w+)\[(\d+)\]$/.exec(row.fieldPath ?? '');
      const entry = match && draft?.[match[1]]?.[Number(match[2])];
      row.claimChanged = entry ? redact(entry.text ?? entry.path) !== row.claim : null;
    }
  }
}
module.exports = { capture, record, outcome, redact, MAX_RECORDS, MAX_TEXT };
