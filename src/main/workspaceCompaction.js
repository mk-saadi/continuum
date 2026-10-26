'use strict';
// Owning-loop safe-point capability. Never accepted from IPC/model arguments.
const { createHash } = require('node:crypto');
const { db } = require('./db');
const w2 = require('./workspaceCompactCandidate');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capabilities = new WeakMap();
const inflight = new Map();
function fail(code) { throw Object.assign(new Error(`Workspace compaction: ${code}. Retry the run after resolving this condition; saved history is preserved.`), { code, recoverable: true }); }
function paired(messages) {
  let pending = new Set();
  const seen = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) return false;
    } else {
      if (pending.size) return false;
      for (const call of message.tool_calls ?? []) {
        if (!call.id || seen.has(call.id)) return false;
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  return !pending.size;
}
function completedPrefix(tail) {
  if (!paired(tail)) fail('incomplete-tool-pair');
  const starts = tail.flatMap((m, i) => m.role === 'assistant' && m.tool_calls?.length ? [i] : []);
  // Keep two recent rounds and all following steering/runtime events verbatim.
  return starts.length > 2 ? starts[starts.length - 2] : 0;
}
function validateSafePoint(token, captured) {
  const value = capabilities.get(token);
  if (!value || value.sessionId !== captured.session.id || !value.owner || captured.owner !== value.owner ||
      value.owner.signal.aborted || value.owner.runId !== value.runId || !value.isCurrent()) fail('invalid-safe-point');
  if (value.owner.toolApprovals?.size || value.owner.pendingQuestions?.size || value.owner.resolveToolLimit || value.owner.resumeLoop) fail('pending-tool-operation');
  if (require('./lspExecutionContext').revision(value.sessionId) !== value.permissionRevision) fail('runtime-state-changed');
  // Independent operations are data references, never authorization grants.
  // Re-read their barrier at every W2/W3 validation point.
  if (hash(operationReferences(captured, value)) !== value.operationIdentity) fail('operation-state-changed');
  if (captured.messages.filter(m => m.id !== value.messageId).some(m => require('./executionSteps').readExecutionSteps(m).some(s => s.type === 'tool_call' && !['complete', 'error'].includes(s.status)))) fail('pending-tool-operation');
  const open = captured.messages.filter(m => m.status === 'in_progress');
  if (open.some(m => m.id !== value.messageId || m.run_id !== value.runId)) fail('unfinished-assistant');
  const row = captured.messages.find(m => m.id === value.messageId);
  const steps = require('./executionSteps').readExecutionSteps(row ?? {});
  if (steps.some(s => s.type === 'tool_call' && !['complete', 'error', 'cancelled'].includes(s.status))) fail('pending-tool-operation');
  if (value.stepIds.some(id => !steps.some(s => s.id === id && s.type === 'tool_call'))) fail('tool-round-not-durable');
  return value;
}
function operationReferences(captured, value) {
  const steps = captured.messages.flatMap(message => require('./executionSteps').readExecutionSteps(message));
  const completed = id => steps.some(step => step.id === id && step.type === 'tool_call' && step.status === 'complete');
  const background = captured.background.map(row => {
    let record;
    try { record = JSON.parse(row.record); } catch { fail('invalid-background-state'); }
    if (record.ended_at && !['starting', 'running'].includes(record.status) && record.notification_state === 'delivered') return null;
    // Require both the durable owner and the live U7 registry. A cited ID
    // alone cannot adopt another command or reconstruct an execution grant.
    let live;
    try { live = require('./backgroundCommands').status(row.command_id, { runId: value.runId, sessionId: value.sessionId, workspace: row.workspace }); }
    catch { fail('pending-background-operation'); }
    if (!live || record.command_id !== row.command_id || record.workspace !== row.workspace || record.session_id !== value.sessionId || record.run_id !== value.runId ||
        live.run_id !== value.runId || live.status !== record.status || live.notification_state !== record.notification_state ||
        live.persistence_error) fail('pending-background-operation');
    return { kind: 'background-command', id: row.command_id, runId: record.run_id, workspace: row.workspace,
      status: record.status, notificationState: record.notification_state, evidence: 'background_commands', authority: 'none' };
  }).filter(Boolean);
  const children = require('./subagents/sessionManager').listChildren(value.sessionId).filter(child =>
    child.activeExecutionId || ['created', 'waiting', 'running', 'queued'].includes(child.status)).map(child => {
    const attempts = require('./subagents/executionStore').listExecutions(child.id);
    const attempt = attempts.at(-1);
    // Only detached children with a completed parent handle may survive this
    // boundary. Foreground delegation remains an unresolved protocol round.
    const durable = db.prepare('SELECT child_session_id FROM subagent_runs WHERE child_session_id = ? AND parent_session_id = ?').get(child.id ?? '', value.sessionId);
    if (!child.id || !durable || child.parentSessionId !== value.sessionId || !completed(child.parentToolCallId) ||
        !attempt?.background || attempt.status !== 'running') fail('pending-child-operation');
    return { kind: 'subagent', id: child.id, executionId: attempt.id, parentToolCallId: child.parentToolCallId,
      status: child.status, evidence: 'subagent_runs', authority: 'none' };
  });
  return [...background, ...children];
}
function candidateMessages(token, captured) {
  const value = validateSafePoint(token, captured);
  return captured.messages.filter(m => m.id !== value.messageId).concat(value.stepIds.length ? [{
    ...captured.messages.find(m => m.id === value.messageId),
    content: value.consumed.filter(m => m.role === 'assistant').map(m => typeof m.content === 'string' ? m.content : '').join('\n'),
    execution_steps: JSON.stringify(require('./executionSteps').readExecutionSteps(captured.messages.find(m => m.id === value.messageId)).filter(s => value.stepIds.includes(s.id))),
  }] : []);
}
const budgetIdentity = result => hash({ ...result.budgetContract, currentInputTokens: null, measurementMethod: null, measurementConfidence: null });
async function compactAtBoundary(options) {
  const { sessionId } = options;
  const existing = inflight.get(sessionId);
  if (existing) {
    if (existing.owner === options.owner && existing.payloadHash === hash(options.payload)) return existing.promise;
    fail('compaction-busy');
  }
  let activity;
  const progress = (status, values) => {
    try {
    if (!activity) activity = require('./workspaceCompactionActivity').create({ sessionId,
      runId: options.owner?.runId, messageId: options.messageId,
      anchorStepId: require('./executionSteps').readExecutionSteps(
        db.prepare('SELECT * FROM messages WHERE id=? AND session_id=?').get(options.messageId ?? -1, sessionId) ?? {}).at(-1)?.id,
      broadcast: options.onActivity });
    activity.update(status, values);
    } catch { /* Observability cannot invalidate a safe runtime operation. */ }
  };
  const promise = perform({ ...options, progress }).then(result => {
    if (activity) {
      const d = result.diagnostics ?? {};
      activity.update(result.compressed ? 'completed' : result.optionalContinued ? 'checking-fit' : 'deferred', {
        code: result.reason, afterTokens: result.compressed ? d.actualTokens : undefined,
        afterMeasurementMethod: result.compressed ? d.actualMeasurementMethod : undefined,
        checkpointId: result.checkpointId, generationStages: d.generation?.staged?.segments?.length != null ? d.generation.staged.segments.length + 1 : 1,
      });
      if (result.optionalContinued) {
        const validate = result.validateDispatch;
        result.validateDispatch = async () => {
          try { return await validate(); } catch (error) {
            activity.update(options.owner?.signal.aborted ? 'cancelled' : 'failed', { code: error.code }); throw error;
          }
        };
      }
      if (result.compressed || result.optionalContinued) result.markContinued = () => activity.update(result.compressed ? 'completed' : 'continued', { continued: true });
    }
    return result;
  }, error => {
    activity?.update(options.owner?.signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed', { code: error.code });
    throw error;
  });
  inflight.set(sessionId, { promise, owner: options.owner, payloadHash: hash(options.payload) });
  try { return await promise; } finally { inflight.delete(sessionId); }
}
async function perform({ sessionId, modelId, owner, messageId, payload, tail, buildRequest, measure, generate,
  isCurrent, mcpToolNames = [], force = false, signal = owner.signal, inject = () => {}, progress = () => {}, softTargetTokens = 17000, reasoningTarget = null, localModel = null }) {
  const started = performance.now();
  const guard = () => { signal.throwIfAborted(); if (!isCurrent()) fail('runtime-state-changed'); };
  guard();
  const before = await measure(payload);
  guard();
  if (!require('./profileSettings').getSessionSettings(sessionId, modelId).effective.compactionEnabled) {
    if (before.tokens > before.budget) fail('compaction-disabled-context-overflow');
    return { compressed: false, reason: 'compaction-disabled' };
  }
  const component = value => value?.length ? Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3) : 0;
  const diagnostics = { beforeComposition: require('./compactionPerformance').requestComposition(payload, before), sessionModelId: modelId, provider: before.budgetContract.provider ?? 'local', modelId: before.budgetContract.modelId ?? modelId, beforeTokens: before.tokens, effectiveCapacityTokens: before.limit, usableInputTokens: before.budget,
    reservedOutputTokens: before.budgetContract.reservedOutputTokens, safetyTokens: before.budgetContract.reservedSafetyTokens,
    nativeSchemaTokens: component(payload.tools?.filter(t => !mcpToolNames.includes(t.function.name))),
    activatedMcpSchemaTokens: component(payload.tools?.filter(t => mcpToolNames.includes(t.function.name))),
    componentMeasurementMethod: 'serialized-utf8-bytes/3-estimate-not-additive',
    triggerTokens: before.budgetContract.autoCompactionTriggerTokens, measurementMethod: before.method };
  if (!force && !require('./contextBudget').atCompactionPressure(before.budgetContract)) return { compressed: false, diagnostics };
  progress('started', { beforeTokens: before.tokens, usableInputTokens: before.budget,
    triggerTokens: diagnostics.triggerTokens, measurementMethod: before.method });
  const cut = completedPrefix(tail);
  const active = require('./sessionManager').getActiveMessages(sessionId);
  const lastUserId = [...active].reverse().find(m => m.role === 'user')?.id;
  if (!cut && !active.some(m => m.id !== messageId && m.id !== lastUserId && m.status !== 'in_progress')) {
    if (before.tokens > before.budget) fail('irreducible-context-overflow');
    return { compressed: false, reason: 'no-reducible-history', diagnostics };
  }
  const captured = w2.snapshot(sessionId);
  const latestUser = [...captured.messages].reverse().find(m => m.role === 'user')?.id;
  const archiveIds = captured.messages.filter(m => !m.archived && m.id !== messageId && m.id !== latestUser && m.status !== 'in_progress').map(m => m.id);
  if (!archiveIds.length && !cut) {
    if (before.tokens > before.budget) fail('irreducible-context-overflow');
    return { compressed: false, reason: 'no-reducible-history', diagnostics };
  }
  const consumed = tail.slice(0, cut), retained = [...consumed.filter(m => !['assistant', 'tool'].includes(m.role)), ...tail.slice(cut)];
  diagnostics.protectedLiveTailTokens = component(retained);
  const prior = require('./taskCheckpoints').getLatestCheckpoint(sessionId)?.checkpoint;
  const priorIds = prior?.projection?.runId === owner.runId ? prior.projection.consumedToolIds : [];
  const stepIds = [...new Set([...priorIds, ...consumed.flatMap(m => (m.tool_calls ?? []).map(c => c.id))])];
  const token = Object.freeze({});
  const capability = { sessionId, owner, runId: owner.runId, messageId, consumed, stepIds, isCurrent,
    permissionRevision: require('./lspExecutionContext').revision(sessionId) };
  // Acquisition failures defer only while the current request still fits.
  capabilities.set(token, capability);
  try {
    capability.operations = operationReferences(captured, capability);
    capability.operationIdentity = hash(capability.operations);
    validateSafePoint(token, captured);
  } catch (error) {
    if (before.tokens <= before.budget && ['pending-background-operation', 'pending-child-operation'].includes(error.code)) {
      capabilities.delete(token);
      return { compressed: false, reason: error.code, deferred: true, diagnostics };
    }
    throw error;
  }
  progress('generating', { sourceVersion: captured.version });
  inject('generation-start');
  const generated = await w2.generateWorkspaceCompactCandidate({ sessionId, modelId, generate, measure,
    reasoningTarget, localModel, capacityTokens: before.limit, provider: before.budgetContract.provider ?? 'local', signal, persist: false, safePoint: token, isCurrent, onProgress: progress });
  if (!generated.ok) {
    // Only candidate-generation/validation failures qualify. A pressure
    // estimate never authorizes dispatch; rebuild and measure independently.
    const eligible = new Set(['invalid-json', 'schema-invalid', 'missing-required-data', 'invalid-reference',
      'missing-task-brief-reference', 'unsupported-completion-claim', 'unsupported-file-claim',
      'output-truncated', 'empty-response', 'incomplete-response', 'provider-error']);
    if (force || !eligible.has(generated.code)) { capabilities.delete(token); fail(generated.code); }
    try {
      const current = () => { guard(); w2.assertCurrent(sessionId, captured, signal); validateSafePoint(token, w2.snapshot(sessionId)); };
      current();
      progress('checking-fit'); inject('optional-fallback-build');
      const original = await buildRequest(null, tail);
      if (!paired(original.messages)) fail('incomplete-tool-pair');
      const verify = async () => {
        current();
        const fit = await measure(original);
        current();
        if (budgetIdentity(before) !== budgetIdentity(fit)) fail('capacity-changed');
        // Cloud adapters currently provide conservative estimates only; they
        // cannot authorize this exceptional fallback.
        if (!Number.isSafeInteger(fit.tokens) || fit.tokens < 0 || !Number.isSafeInteger(fit.budget) || fit.budget < 0 || fit.method !== 'server-template-tokenizer' || fit.budgetContract.capacityMethod !== 'runtime-reported') fail('optional-fallback-measurement-unavailable');
        if (fit.tokens > fit.budget) fail('prospective-context-overflow');
        return fit;
      };
      const fit = await verify();
      Object.assign(diagnostics, { generation: generated.diagnostics, actualTokens: fit.tokens, actualMeasurementMethod: fit.method });
      return { compressed: false, optionalContinued: true, reason: generated.code, payload: original, tail,
        diagnostics, validateDispatch: verify };
    } catch (error) { capabilities.delete(token); throw error; }
  }
  Object.assign(diagnostics, { generation: generated.diagnostics });
  guard();
  // W2 uses the exact pre-generation snapshot, not a subsequently refreshed one.
  if (generated.candidate.lifecycle !== 'validated-candidate' || generated.candidate.sourceVersion !== captured.version) fail('stale-candidate');
  const checkpoint = { ...generated.candidate, lifecycle: 'w3-current',
    pending: { ...generated.candidate.pending, operations: capability.operations },
    projection: { runId: owner.runId, messageId, consumedToolIds: stepIds, sourceVersion: captured.version } };
  const projection = { checkpoint, archiveIds };
  progress('checking-fit');
  inject('prospective-build');
  guard(); w2.assertCurrent(sessionId, captured, signal); validateSafePoint(token, w2.snapshot(sessionId));
  const prospective = await buildRequest(projection, retained);
  if (!paired(prospective.messages)) fail('incomplete-tool-pair');
  const fit = await measure(prospective);
  diagnostics.prospectiveTokens = fit.tokens;
  diagnostics.prospectiveSoftTarget = require('./compactionPerformance').softTarget(fit.tokens, fit.budget, softTargetTokens);
  diagnostics.prospectiveMeasurementMethod = fit.method;
  if (budgetIdentity(before) !== budgetIdentity(fit)) fail('capacity-changed');
  if (fit.tokens > fit.budget) fail('prospective-context-overflow');
  if (fit.tokens >= before.tokens) fail('no-meaningful-reduction');
  guard();
  const previous = db.prepare("SELECT id FROM workspace_checkpoints WHERE session_id = ? AND status = 'current'").all(sessionId);
  let checkpointId;
  progress('committing');
  inject('transaction-start');
  const commitStarted = performance.now();
  db.transaction(() => {
    guard(); w2.assertCurrent(sessionId, captured, signal); validateSafePoint(token, w2.snapshot(sessionId));
    inject('candidate-promotion');
    checkpointId = require('./taskCheckpoints').persistCheckpointRow({ sessionId, modelId, checkpoint,
      briefIdentity: require('./taskBriefs').getBriefIdentity(sessionId), leafId: captured.session.active_leaf_id,
      archivedIds: archiveIds, fingerprint: require('./taskCheckpoints').computeEvidenceFingerprint(captured.messages.filter(m => archiveIds.includes(m.id))) });
    const archive = db.prepare("UPDATE messages SET archived = 1 WHERE id = ? AND session_id = ? AND archived = 0 AND status != 'in_progress'");
    for (const id of archiveIds) if (archive.run(id, sessionId).changes !== 1) fail('archive-conflict');
    inject('message-archival'); inject('transaction-commit');
  }).immediate();
  diagnostics.sqliteCommitMs = performance.now() - commitStarted;
  progress('committing', { checkpointId });
  require('./promptMeasurement').invalidateMeasuredContext(sessionId);
  // A completed SQLite commit cannot roll back itself. Compensate only when
  // the complete committed snapshot is still ours; otherwise stop dispatch.
  const committed = w2.snapshot(sessionId);
  try {
    inject('post-commit-build');
    const actual = await buildRequest(null, retained);
    const measurementStarted = performance.now();
    const actualFit = await measure(actual);
    diagnostics.postCommitMeasurementMs = performance.now() - measurementStarted;
    diagnostics.afterComposition = require('./compactionPerformance').requestComposition(actual, actualFit);
    diagnostics.softTarget = require('./compactionPerformance').softTarget(actualFit.tokens, actualFit.budget, softTargetTokens);
    guard(); w2.assertCurrent(sessionId, committed, signal);
    validateSafePoint(token, committed);
    if (!paired(actual.messages)) fail('incomplete-tool-pair');
    if (hash(actual) !== hash(prospective) || budgetIdentity(actualFit) !== budgetIdentity(fit) || actualFit.tokens > actualFit.budget) fail('post-commit-mismatch');
    diagnostics.commitOutcome = 'committed-and-verified';
    diagnostics.actualBudgetContract = actualFit.budgetContract;
    diagnostics.actualTokens = actualFit.tokens;
    diagnostics.actualMeasurementMethod = actualFit.method;
    diagnostics.reductionTokens = before.tokens - actualFit.tokens;
    diagnostics.durationMs = performance.now() - started;
    return { compressed: true, payload: actual, tail: retained, checkpointId, archivedCount: archiveIds.length, diagnostics,
      validateDispatch: async () => {
        const dispatchFit = await measure(actual);
        if (budgetIdentity(dispatchFit) !== budgetIdentity(fit) || dispatchFit.tokens > dispatchFit.budget) fail('capacity-changed');
        guard(); w2.assertCurrent(sessionId, committed, signal);
        if (hash(operationReferences(w2.snapshot(sessionId), capability)) !== capability.operationIdentity) fail('operation-state-changed'); } };
  } catch (error) {
    try {
      db.transaction(() => {
        // Cancellation invalidates dispatch, but does not prevent safe repair.
        w2.assertCurrent(sessionId, committed);
        db.prepare("UPDATE workspace_checkpoints SET status = 'superseded' WHERE id = ? AND session_id = ?").run(checkpointId, sessionId);
        for (const row of previous) db.prepare("UPDATE workspace_checkpoints SET status = 'current' WHERE id = ? AND session_id = ?").run(row.id, sessionId);
        for (const id of archiveIds) db.prepare('UPDATE messages SET archived = 0 WHERE id = ? AND session_id = ?').run(id, sessionId);
      }).immediate();
      require('./promptMeasurement').invalidateMeasuredContext(sessionId);
    } catch { error.recoveryRequired = true; }
    throw error;
  } finally { capabilities.delete(token); }
}
module.exports = { compactAtBoundary, validateSafePoint, candidateMessages, paired, completedPrefix, operationReferences };
