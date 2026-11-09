'use strict';

const { randomUUID } = require('node:crypto');
const { approximateTokens, reserveTokens, createPromptMeasurer, ContextBudgetError } = require('../contextBudget');
const budgets = require('./executionBudget');
const scheduler = require('./inferenceScheduler');
const { pushActivity } = require('./sessionManager');

const SUMMARY_MARKER = '[EARLIER CHILD CONTEXT]';
const CHILD_CHECKPOINT = '[CHILD CHECKPOINT]';

function compactionError(reason) {
  const error = new Error(`Child context compaction stopped: ${reason}`);
  error.stopReason = 'compaction_failed'; error.compactionReason = reason;
  return error;
}
function validatePairs(messages) {
  let pending = new Set();
  for (const m of messages) {
    if (!m || !['system', 'user', 'assistant', 'tool'].includes(m.role)) throw compactionError('malformed-transcript');
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) throw compactionError('unmatched-tool-result');
    } else {
      if (pending.size) throw compactionError('in-flight-tool-round');
      const calls = m.tool_calls ?? [];
      if (calls.length && m.role !== 'assistant') throw compactionError('malformed-tool-round');
      for (const call of calls) {
        if (!call.id || pending.has(call.id)) throw compactionError('duplicate-tool-id');
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw compactionError('in-flight-tool-round');
}
// Keep small outputs untouched. Large JSON file results retain their metadata,
// while the model sees explicit, task-focused head/tail/error/value excerpts.
// The original native result is recorded separately before this projection.
function trimToolResult(content, { task = '', contextLength = 32768, maxCharacters = null } = {}) {
  const slice = (text, start, end = text.length) => {
    start = start < 0 ? Math.max(0, text.length + start) : start;
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
    return text.slice(start, end);
  };
  const cap = maxCharacters ?? Math.min(12000, Math.max(1200, Math.floor(contextLength * .12 * 3)));
  if (typeof content !== 'string' || content.length <= cap) return content;
  // LSP projections must retain cursor, source version and diagnostic freshness as valid JSON.
  try {
    const parsed = JSON.parse(content);
    if (parsed?.untrusted === true && parsed.provenance === 'immutable-query-snapshot' && Array.isArray(parsed.results)) {
      parsed.context_trimmed = true; parsed.incomplete = true;
      const count = parsed.results.length;
      while (parsed.results.length && JSON.stringify(parsed).length > cap - 50) parsed.results.pop();
      parsed.contextOmittedCount = count - parsed.results.length;
      return JSON.stringify(parsed);
    }
  } catch {}
  let data = null;
  try { const parsed = JSON.parse(content); if (parsed && !Array.isArray(parsed) && typeof parsed.content === 'string') data = parsed; } catch {}
  const text = data ? data.content : content;
  const terms = [...new Set(task.toLowerCase().match(/[a-z_][a-z0-9_./-]{3,}/g) ?? [])].slice(0, 30);
  const sections = [slice(text, 0, Math.floor(cap * .25)), slice(text, -Math.floor(cap * .25))];
  const matches = [];
  const re = /[^\n]+/g;
  let line;
  while ((line = re.exec(text))) {
    const value = line[0];
    const critical = /\b(error|failed|exit.?code|ENOENT|permission|warning)\b/i.test(value);
    const hit = terms.find(term => value.toLowerCase().includes(term));
    if (critical || hit) {
      const offset = hit ? value.toLowerCase().indexOf(hit) : 0;
      matches.push(slice(value, Math.max(0, offset - 100), Math.max(0, offset - 100) + 400));
    }
    if (matches.join('\n').length > cap * .4) break;
  }
  const notice = `\n[Context excerpt: ${content.length} original characters; omitted text retained in raw child history.]\n`;
  const excerpt = `${sections[0]}${notice}${slice(matches.join('\n'), 0, Math.floor(cap * .4))}\n${sections[1]}`;
  const projected = data ? JSON.stringify({ ...data, content: excerpt, context_trimmed: true, original_result_chars: content.length }) : excerpt;
  // Metadata can outweigh the source excerpt for a small bounded file page.
  return projected.length < content.length ? projected : content;
}

// Stable identity signature for a transcript message, used ONLY to re-attach a
// restored active projection to the raw records it was projected from after a
// restart. Tool results key on their tool_call_id (their projected content is a
// trimmed view of the raw result); assistant rounds key on their call ids and
// content; system/user messages key on role + content. Signatures are not a
// general-purpose message id — they never leave recovery.
function rawSignature(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.role === 'tool') return `tool:${message.tool_call_id ?? ''}`;
  const calls = Array.isArray(message.tool_calls) && message.tool_calls.length
    ? message.tool_calls.map(call => call?.id ?? '').join('|') : '';
  return `${message.role}:${calls}:${String(message.content ?? '')}`;
}

function buildRawIdIndex(rawContext) {
  const index = new Map();
  for (const raw of Array.isArray(rawContext) ? rawContext : []) {
    const signature = rawSignature(raw);
    if (signature == null || !Number.isSafeInteger(raw?.id)) continue;
    const bucket = index.get(signature) ?? [];
    bucket.push(raw.id);
    index.set(signature, bucket);
  }
  return index;
}

// Consume (shift) one raw id matching this message, in transcript order, so
// repeated signatures pair up deterministically. Returns null when the message
// has no recorded raw predecessor and must be recorded.
function claimRawId(index, message) {
  const signature = rawSignature(message);
  const bucket = signature == null ? null : index.get(signature);
  if (!bucket || !bucket.length) return null;
  const id = bucket.shift();
  return Number.isSafeInteger(id) ? id : null;
}

function createChildContextAdapter({ session, messages, engine, state, fetchImpl, signal, commit, isCurrent = () => true, configurationIdentity = () => null }) {
  session.rawContext ??= [];
  session.compactionState ??= { owner: session.id ?? randomUUID(), version: 0, summary: null, checkpoint: null, events: [] };
  session.rawMessageIds ??= new WeakMap();
  const meta = session.compactionState;
  let limit = state.budgets.contextLength, overflowCeiling = Infinity, lastCapacity = null;
  const refreshCapacity = value => {
    limit = value === lastCapacity ? Math.min(limit, value, overflowCeiling) : Math.min(value, overflowCeiling);
    lastCapacity = value; state.budgets.contextLength = limit;
  };
  const identity = JSON.stringify(engine);
  const isDerived = m => m.compactionContinuation === true || m.role === 'system' && (m.content?.startsWith(SUMMARY_MARKER) || m.content?.startsWith(CHILD_CHECKPOINT) || m.content?.startsWith(require('../conversationCompaction').MARKER));
  const record = (message, rawContent = message.content) => {
    const id = session.rawContext.length + 1;
    const raw = structuredClone({ ...message, content: rawContent, id });
    session.rawContext.push(raw); session.rawMessageIds.set(message, id);
    return message;
  };
  // Old in-memory sessions/fixtures can acquire raw identity lazily; no parent
  // history is reachable here. Already recorded rounds are never added twice.
  //
  // A *restored* (post-restart) session brings back `rawContext` and the active
  // projection as brand-new objects with no WeakMap identity. Re-attach each
  // active message to the raw record it was projected from before recording
  // anything: otherwise recovery would duplicate the child's own raw history,
  // double-count its evidence, and inflate the archive the next compaction
  // computes. Genuinely new messages (a continuation instruction, a fresh
  // round) have no raw match and are recorded normally.
  const retained = new Set(meta.boundary?.retainedRawIds ?? []);
  const rawIndex = buildRawIdIndex(meta.boundary ? session.rawContext.filter(row => row.role === 'system' || retained.has(row.id) || row.id > meta.boundary.rawLength) : session.rawContext);
  for (const m of messages) {
    if (isDerived(m) || session.rawMessageIds.has(m)) continue;
    const claimed = claimRawId(rawIndex, m);
    if (claimed !== null) { session.rawMessageIds.set(m, claimed); continue; }
    record(m);
  }
  const persist = () => { commit(); return require('./persistence').persistChildRun(session); };
  const persistAccounting = () => {
    // Persist accounting against the last committed projection, never a staged summary.
    if (!require('./persistence').persistChildRun(session))
      throw Object.assign(new Error('Could not save child request allowance'), { code: 'persistence-failed' });
  };
  // Restart migration is representation-only and never spends inference. Keep
  // every prior artifact as input to the one summary until the model next
  // consolidates it. Raw records and lifetime counters are untouched.
  if (meta.checkpoint || messages.some(m => m.role === 'system' &&
      (m.content?.startsWith(SUMMARY_MARKER) || m.content?.startsWith(CHILD_CHECKPOINT)))) {
    signal?.throwIfAborted();
    const previous = [...messages], previousMeta = structuredClone(meta);
    const legacy = messages.filter(m => m.role === 'system' && isDerived(m));
    const parts = [meta.summary, ...legacy.map(m => m.content.replace(/^[^\n]*\n?/, '')),
      meta.checkpoint ? JSON.stringify(meta.checkpoint) : null].filter(Boolean);
    meta.summary = [...new Set(parts)].join('\n\n'); meta.checkpoint = null; meta.schemaVersion = 2;
    messages.splice(0, messages.length, ...messages.filter(m => !(m.role === 'system' && isDerived(m))));
    messages.unshift({ role: 'system', content: `${require('../conversationCompaction').MARKER}\n${meta.summary}` });
    meta.boundary ??= { rawLength: session.rawContext.length,
      retainedRawIds: messages.map(m => session.rawMessageIds.get(m)).filter(Boolean) };
    let durable = false;
    try { durable = persist(); } catch {}
    if (!durable) {
      messages.splice(0, messages.length, ...previous);
      for (const key of Object.keys(meta)) delete meta[key];
      Object.assign(meta, previousMeta); session.context = previous.slice();
      throw Object.assign(new Error('Could not save child compaction migration'), { code: 'persistence-failed' });
    }
  }

  const append = (message, rawContent = message.content) => {
    record(message, rawContent); messages.push(message); return message;
  };
  const estimate = text => Math.ceil(String(text ?? '').length / 4);
  const local = !engine.chatTarget && engine.provider !== 'cloud';
  const measureLocal = local ? createPromptMeasurer(fetchImpl ?? require('../localEngineFetch').localEngineFetch) : null;
  const measureCloud = !local && engine.chatTarget ? require('../promptMeasurement').createCloudWorkspaceMeasurer(engine.chatTarget) : null;
  const measure = async payload => {
    signal?.throwIfAborted();
    if (!local) { const capacity = await require('./budgets').resolveEngineContextLength(engine); refreshCapacity(capacity.contextLength); }
    const rough = approximateTokens(payload), reserve = reserveTokens(payload, limit);
    let measured = { tokens: rough, method: 'approximate-full-request', limit };
    // Avoid new network probes for comfortably short tasks. Exact local
    // measurement is used near pressure, and the transport still guards fit.
    if (local && (rough + reserve) / limit >= .6) measured = await measureLocal(`http://127.0.0.1:${engine.port}/v1/chat/completions`, payload, { signal, contextWindowLimit: limit });
    if (measureCloud) {
      try { measured = await measureCloud(payload); }
      catch { signal?.throwIfAborted(); /* Explicit full-request estimate remains available. */ }
    }
    limit = Math.min(limit, measured.limit);
    state.budgets.contextLength = limit;
    return require('../contextBudget').withEffectiveLimit(measured, payload, limit);
  };
  const adapter = {
    record, append, persist, validate: validatePairs, estimate, measure,
    compact: async (payload, force) => {
      const core = require('../conversationCompaction');
      const fingerprint = JSON.stringify(messages), configuration = configurationIdentity();
      const rawLength = session.rawContext.length;
      const runtimeIdentity = () => {
        if (!local) return null;
        const config = require('./modelSelection').currentLocalEngineConfig(engine);
        return config ? JSON.stringify([config.modelPath, config.port, config.runtimeIdentity, require('./modelSelection').effectiveContextLength(config)]) : null;
      };
      const currentRuntime = runtimeIdentity();
      const prior = meta.summary ?? '';
      // Legacy checkpoint data is migration input exactly once, without a model
      // call on open. A successful consolidation replaces both old artifacts.
      const oldSummary = [prior, meta.checkpoint ? JSON.stringify(meta.checkpoint) : ''].filter(Boolean).join('\n\n');
      const clean = { ...payload, messages: payload.messages.filter(m => !isDerived(m)) };
      if (oldSummary) clean.messages.unshift({ role: 'system', content: `${core.MARKER}\n${oldSummary}` });
      return core.compact({ owner: session, payload: clean, oldSummary, force, measure, signal,
        isCurrent: () => isCurrent() && configuration === configurationIdentity() && fingerprint === JSON.stringify(messages) && rawLength === session.rawContext.length && identity === JSON.stringify(engine) && runtimeIdentity() === currentRuntime,
        generate: async (request, { continuationPayload }) => {
          // Every stage must leave a request and output allowance for resuming.
          if (budgets.remaining(state.budgets.maxTurns, budgets.totals(state).turns) < 2) throw new budgets.ExecutionBudgetError('turn_limit');
          if (budgets.remaining(state.budgets.outputBudget, budgets.totals(state).outputTokens) < request.max_tokens + 256) throw new budgets.ExecutionBudgetError('output_budget');
          const policy = require('./budgets');
          const continuationInput = policy.estimatePromptTokens(continuationPayload.messages, continuationPayload.tools) + request.max_tokens;
          const summaryInput = policy.estimatePromptTokens(request.messages, request.tools);
          if (budgets.remaining(state.budgets.inputBudget, budgets.totals(state).inputTokens) < summaryInput + continuationInput)
            throw new budgets.ExecutionBudgetError('input_budget');
          budgets.setBudgetPersistence(state, persistAccounting);
          const prepared = budgets.stopBeforeRequest(state, request);
          const reply = await scheduler.scheduleInference({ session, engine, payload: prepared, signal, fetchImpl, budgetState: state });
          if (!reply.ok) throw compactionError('provider-error');
          if (state.overrun) throw new budgets.ExecutionBudgetError(state.overrun);
          return reply.result;
        },
        save: async candidate => {
          signal?.throwIfAborted();
          const previousMessages = [...messages], previousMeta = structuredClone(meta);
          messages.splice(0, messages.length, ...candidate.payload.messages);
          meta.version++; meta.summary = candidate.summary; meta.checkpoint = null;
          meta.boundary = { rawLength, retainedRawIds: candidate.tail.map(m => session.rawMessageIds.get(m)).filter(Boolean) };
          meta.events.push({ version: meta.version, reason: force ? 'overflow' : 'pressure', before: candidate.before, after: candidate.after,
            generations: candidate.generations, ledgerAfter: budgets.totals(state) });
          let durable = false;
          try { durable = persist(); } catch {}
          if (!durable) {
            messages.splice(0, messages.length, ...previousMessages);
            for (const key of Object.keys(meta)) delete meta[key];
            Object.assign(meta, previousMeta);
            session.context = previousMessages.slice();
            try { commit(); } catch {}
            throw Object.assign(new Error('Child compaction persistence failed'), { code: 'persistence-failed' });
          }
          pushActivity(session, { type: 'compaction', version: meta.version, before: candidate.before.tokens, after: candidate.after.tokens });
        } });
    },
    prepare: async (payload, force = false, contextWindowLimit = null) => {
      validatePairs(messages);
      let enabled = true;
      try { enabled = require('../profileSettings').getSessionSettings(null, engine.modelId).effective.compactionEnabled; }
      catch (error) { if (!String(error.message).includes('Call initDatabase()')) throw error; }
      if (!enabled) {
        if (force) throw new ContextBudgetError('child compaction is disabled for the selected model');
        return payload;
      }
      const capacity = await require('./budgets').resolveEngineContextLength(engine);
      if (contextWindowLimit) overflowCeiling = Math.min(overflowCeiling, contextWindowLimit);
      refreshCapacity(capacity.contextLength); state.contextSource = capacity.source;
      let result;
      try { result = await adapter.compact(payload, force); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof TypeError) throw compactionError('invalid-summary-or-transcript');
        throw error;
      }
      adapter.lastMeasurement = result.after ?? result.before;
      if (result.compressed) return result.payload;
      if (force || (result.before?.tokens + result.before?.reserve > result.before?.limit)) throw new ContextBudgetError(result.reason);
      return payload;
    },
  };
  return adapter;
}
module.exports = { createChildContextAdapter, trimToolResult, validatePairs, compactionError };
