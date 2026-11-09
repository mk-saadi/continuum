'use strict';
const { db } = require('./db');
const core = require('./conversationCompaction');
const manager = () => require('./sessionManager');
const sourceIdentity = rows => core.fingerprint(rows);
const sourceRows = sessionId => manager().withAttachments(manager().activePath(sessionId));
const sources = new WeakMap();
function bindSource(owner, sessionId, openId = null) {
  sources.set(owner, { sessionId, fingerprint: sourceIdentity(sourceRows(sessionId).filter(row => row.id !== openId)) });
}
function read(sessionId) {
  const row = db.prepare('SELECT state_json FROM conversation_compactions WHERE session_id=?').get(sessionId);
  return row ? JSON.parse(row.state_json) : null;
}
function write(sessionId, state) {
  db.prepare('INSERT INTO conversation_compactions(session_id,state_json) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET state_json=excluded.state_json')
    .run(sessionId, JSON.stringify(state));
}
function basis(rows, openId = null) {
  return rows.map(m => ({ id: m.id, parent: m.parent_id, variant: m.active_variant_index, content: m.id === openId ? null : core.fingerprint([m.content, m.executionSteps, m.active_variant_index, m.attachments]) }));
}
function applicable(state, rows) {
  if (!state) return false;
  const now = basis(rows, state.openId);
  return state.basis.every((entry, i) => JSON.stringify(entry) === JSON.stringify(now[i]));
}
function stateFor(sessionId) {
  const rows = sourceRows(sessionId);
  let state = read(sessionId);
  if (state) return applicable(state, rows) ? state : null;
  // Migration is atomic, idempotent, and requires no inference. Preserve all
  // legacy context as input for the next consolidation. Original rows remain.
  const summary = manager().getSessionSummary(sessionId);
  let checkpoint = db.prepare("SELECT * FROM workspace_checkpoints WHERE session_id=? AND status='current' ORDER BY id DESC LIMIT 1").get(sessionId);
  if (checkpoint) {
    const ids = new Set(rows.map(row => row.id));
    let covered;
    try { covered = JSON.parse(checkpoint.archived_ids_json ?? '[]'); } catch { covered = null; }
    if (!Array.isArray(covered) || covered.some(id => !ids.has(id)) ||
        (checkpoint.active_leaf_id != null && !ids.has(checkpoint.active_leaf_id))) checkpoint = null;
  }
  const prior = [summary, checkpoint?.summary_text, checkpoint?.checkpoint_json].filter(Boolean);
  if (!prior.length) return null;
  const first = rows.findIndex(m => !m.archived && !m.is_summarized);
  const end = first < 0 ? rows.length : first;
  state = { version: 1, summary: [...new Set(prior)].join('\n\n'), basis: basis(rows.slice(0, end)), retained: [], openId: null, migrated: true };
  write(sessionId, state);
  return state;
}
function context(sessionId, exclude = []) {
  const rows = sourceRows(sessionId);
  const candidate = stateFor(sessionId);
  const state = candidate && !candidate.basis.some(row => exclude.includes(row.id)) ? candidate : null;
  const remaining = state ? rows.slice(state.basis.length) : rows;
  const messages = remaining.filter(m => !exclude.includes(m.id))
    .map(require('./promptBuilder').messageForModel);
  // A partial live row was represented by complete wire rounds at commit.
  // Its later final prose remains available after restart without replaying tools.
  const open = state?.openId && rows.find(m => m.id === state.openId);
  const prefixMatches = !open || !state.openContentDigest || core.fingerprint(open.content.slice(0, state.openContentLength ?? 0)) === state.openContentDigest;
  const suffix = open && !exclude.includes(open.id) ? (prefixMatches ? open.content.slice(state.openContentLength ?? 0) : open.content) : '';
  const allSteps = open && !exclude.includes(open.id) ? require('./executionSteps').readExecutionSteps(open) : [];
  const changed = new Map(allSteps.filter(step => state.openStepDigests?.[step.id] &&
    state.openStepDigests[step.id] !== core.fingerprint([step.status, step.result, step.error]))
    .map(step => [step.id, step]));
  const stepContent = step => typeof step.result === 'string' ? step.result : JSON.stringify(step.result ?? { error: step.error ?? step.status });
  const retained = (state?.retained ?? []).map(message => message.role === 'tool' && changed.has(message.tool_call_id)
    ? { ...message, content: stepContent(changed.get(message.tool_call_id)) } : message);
  const updates = [...changed.values()].filter(step => !retained.some(message => message.tool_call_id === step.id))
    .map(step => ({ role: 'user', content: `[Updated stored observation for completed tool ${step.id}; do not replay the operation]\n${stepContent(step)}` }));
  const settled = open && !exclude.includes(open.id) ? allSteps
    .filter(step => step.type === 'tool_call' && !(state.openStepIds ?? []).includes(step.id) && ['complete', 'error', 'cancelled'].includes(step.status))
    .flatMap(step => [{ role: 'assistant', content: null, tool_calls: [{ id: step.id, type: 'function',
      function: { name: step.toolName, arguments: JSON.stringify(step.args ?? {}) } }] },
    { role: 'tool', tool_call_id: step.id, content: typeof step.result === 'string' ? step.result : JSON.stringify(step.result ?? { error: step.error ?? step.status }) }]) : [];
  return { summary: state?.summary ?? null,
    messages: [...retained, ...updates, ...settled, ...(suffix ? [{ role: 'assistant', content: suffix }] : []), ...messages] };
}
async function performBoundary(options) {
  const { sessionId, modelId, owner, payload, signal, measure, generate, isCurrent = () => true, messageId } = options;
  signal?.throwIfAborted();
  if (!require('./profileSettings').getSessionSettings(sessionId, modelId).effective.compactionEnabled)
    return { compressed: false, reason: 'disabled' };
  const rows = sourceRows(sessionId);
  if (!sources.has(owner)) bindSource(owner, sessionId, messageId);
  const source = sources.get(owner);
  const branchCurrent = () => source.sessionId === sessionId && source.fingerprint === sourceIdentity(sourceRows(sessionId).filter(row => row.id !== messageId));
  if (!branchCurrent()) throw Object.assign(new Error('Conversation branch changed during this run'), { code: 'source-changed' });
  const identity = sourceIdentity(rows), prior = stateFor(sessionId);
  const current = () => isCurrent() && branchCurrent() && identity === sourceIdentity(sourceRows(sessionId));
  const modelPayload = { ...payload, messages: options.conversationMessages ?? payload.messages };
  const measured = async request => {
    const actual = options.preparePayload ? options.preparePayload(request) : request;
    const result = await measure(actual);
    return require('./contextBudget').withEffectiveLimit(result, actual, options.contextWindowLimit);
  };
  const generateSummary = async (request, controls) => {
    const id = require('node:crypto').randomUUID();
    const input = require('./contextBudget').approximateTokens(options.preparePayload ? options.preparePayload(request) : request);
    db.prepare('INSERT INTO compaction_generations(id,session_id,status,estimated_input_tokens,reserved_output_tokens) VALUES (?,?,?,?,?)')
      .run(id, sessionId, 'dispatched', input, request.max_tokens);
    let reply;
    try {
      reply = await generate(request, controls);
      db.prepare('UPDATE compaction_generations SET status=?,usage_json=? WHERE id=?').run('returned', JSON.stringify(reply?.usage ?? null), id);
      const usage = reply?.usage;
      if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) {
        require('./tokenUsage').logTokenUsage({ turnId: `compaction:${id}`, chatId: sessionId,
          projectId: db.prepare('SELECT project_id FROM sessions WHERE id=?').get(sessionId)?.project_id ?? null,
          promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
          modelId, provider: options.providerId ?? 'local', usageCoverage: 'measured' });
      }
      return reply;
    } catch (failure) {
      db.prepare('UPDATE compaction_generations SET status=? WHERE id=?').run(signal?.aborted ? 'cancelled' : 'failed', id);
      throw failure;
    }
  };
  let activity;
  const priorInRequest = prior && modelPayload.messages.some(message => message.role === 'system' && message.content === `${core.MARKER}\n${prior.summary}`);
  const result = await core.compact({ owner, payload: modelPayload, oldSummary: priorInRequest ? prior.summary : '', signal, measure: measured, generate: generateSummary,
    force: options.force, isCurrent: current,
    onStatus: (status, details) => {
      activity ??= require('./workspaceCompactionActivity').create({ sessionId, runId: owner?.runId, messageId,
        broadcast: options.onActivity });
      activity.update(status, { code: details.reason, beforeTokens: details.before?.tokens, afterTokens: details.after?.tokens,
        measurementMethod: details.before?.method, afterMeasurementMethod: details.after?.method, generationStages: details.generations });
      options.onStatus?.(status, details);
    },
    save: async candidate => {
      signal?.throwIfAborted();
      if (!current()) throw Object.assign(new Error('Conversation changed during compaction'), { code: 'source-changed' });
      try {
        db.transaction(() => {
          signal?.throwIfAborted();
          if (!current()) throw Object.assign(new Error('Conversation changed during compaction'), { code: 'source-changed' });
          const open = rows.find(m => m.id === messageId && m.status === 'in_progress');
          write(sessionId, { version: (prior?.version ?? 0) + 1, summary: candidate.summary, status: 'completed',
            basis: basis(rows, open?.id), retained: candidate.tail, openId: open?.id ?? null,
            openStepDigests: Object.fromEntries((open ? require('./executionSteps').readExecutionSteps(open) : []).filter(step => step.type === 'tool_call')
              .map(step => [step.id, core.fingerprint([step.status, step.result, step.error])])),
            openContentDigest: open ? core.fingerprint(open.content) : null,
            openContentLength: open?.content.length ?? 0, openStepIds: open ? require('./executionSteps').readExecutionSteps(open).map(step => step.id) : [], before: candidate.before, after: candidate.after });
        }).immediate();
      } catch (cause) { throw Object.assign(new Error('Could not save compaction; original history preserved', { cause }), { code: 'persistence-failed' }); }
    } });
  if (result.compressed) {
    require('./promptMeasurement').invalidateMeasuredContext(sessionId);
    result.history = result.payload.messages;
    if (options.preparePayload) result.payload = options.preparePayload(result.payload);
  }
  return result;
}
const pending = new Map();
function compactAtBoundary(options) {
  if (pending.has(options.sessionId)) return Promise.reject(Object.assign(new Error('Compaction is already running'), { code: 'compaction-busy' }));
  const promise = performBoundary({ ...options, signal: options.signal ?? options.owner?.signal })
    .finally(() => pending.delete(options.sessionId));
  pending.set(options.sessionId, { promise, owner: options.owner });
  return promise;
}
async function cancelSessionCompression(sessionId) {
  const running = pending.get(sessionId);
  running?.owner?.abort?.();
  if (running) await running.promise.catch(() => {});
}
async function shutdownCompression() { await Promise.all([...pending.keys()].map(cancelSessionCompression)); }
module.exports = { read, stateFor, context, bindSource, compactAtBoundary, applicable, cancelSessionCompression, shutdownCompression };
