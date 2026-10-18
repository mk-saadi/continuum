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
function completeRounds(messages) {
  validatePairs(messages);
  const rounds = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const round = [m];
    for (let n = 0; n < (m.tool_calls?.length ?? 0); n++) round.push(messages[++i]);
    rounds.push(round);
  }
  return rounds;
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
  return data ? JSON.stringify({ ...data, content: excerpt, context_trimmed: true, original_result_chars: content.length }) : excerpt;
}

function createChildContextAdapter({ session, messages, engine, state, fetchImpl, signal, commit }) {
  session.rawContext ??= [];
  session.compactionState ??= { owner: session.id ?? randomUUID(), version: 0, summary: null, checkpoint: null, events: [] };
  session.rawMessageIds ??= new WeakMap();
  const meta = session.compactionState;
  let limit = state.budgets.contextLength;
  const identity = JSON.stringify(engine);
  const isDerived = m => m.role === 'system' && (m.content?.startsWith(SUMMARY_MARKER) || m.content?.startsWith(CHILD_CHECKPOINT));
  const record = (message, rawContent = message.content) => {
    const id = session.rawContext.length + 1;
    const raw = structuredClone({ ...message, content: rawContent, id });
    session.rawContext.push(raw); session.rawMessageIds.set(message, id);
    return message;
  };
  // Old in-memory sessions/fixtures can acquire raw identity lazily; no parent
  // history is reachable here. Already recorded rounds are never added twice.
  for (const m of messages) if (!isDerived(m) && !session.rawMessageIds.has(m)) record(m);
  const persist = () => { commit(); require('./persistence').persistChildRun(session); };
  const append = (message, rawContent = message.content) => {
    record(message, rawContent); messages.push(message); return message;
  };
  const wire = rows => rows.map(({ id, ...m }) => m);
  const estimate = text => Math.ceil(String(text ?? '').length / 4);
  const local = !engine.chatTarget && engine.provider !== 'cloud';
  const measureLocal = local ? createPromptMeasurer(fetchImpl ?? require('../localEngineFetch').localEngineFetch) : null;
  const measure = async payload => {
    signal?.throwIfAborted();
    const rough = approximateTokens(payload), reserve = reserveTokens(payload, limit);
    let measured = { tokens: rough, method: 'approximate-full-request', limit };
    // Avoid new network probes for comfortably short tasks. Exact local
    // measurement is used near pressure, and the transport still guards fit.
    if (local && (rough + reserve) / limit >= .6) measured = await measureLocal(`http://127.0.0.1:${engine.port}/v1/chat/completions`, payload, { signal, contextWindowLimit: limit });
    limit = Math.min(limit, measured.limit);
    return { ...measured, limit, reserve: reserveTokens(payload, limit) };
  };
  const generate = async (prompt, data, maxTokens) => {
    // Called outside a held inference slot. No recursive recovery on summary
    // or checkpoint generations; every request uses the same scheduler/model
    // and the same lifetime token/request ledger.
    const payload = budgets.stopBeforeRequest(state, { model: engine.modelId, messages: [
      { role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(data) },
    ], tools: [], tool_choice: 'none', temperature: .1, max_tokens: maxTokens });
    const reply = await scheduler.scheduleInference({ session, engine, payload, signal, fetchImpl, budgetState: state });
    signal?.throwIfAborted();
    if (!reply.ok) { const error = compactionError('provider-error'); error.stopReason = 'provider_error'; throw error; }
    if (state.overrun) throw new budgets.ExecutionBudgetError(state.overrun);
    const message = reply.result?.choices?.[0]?.message;
    if (message?.tool_calls?.length || message?.toolMarkupIncomplete || reply.result?.choices?.[0]?.finish_reason === 'length') throw compactionError('incomplete-summary');
    return message?.content;
  };
  const adapter = {
    record, append, persist, validate: validatePairs, estimate, measure,
    assertGenerationCapacity: () => {
      // Two compaction generations must leave one request for resumed work or
      // the Phase 1 tool-free report. Never consume the last slot drafting a
      // checkpoint that the child cannot subsequently use.
      if (budgets.remaining(state.budgets.maxTurns, budgets.totals(state).turns) < 3) throw new budgets.ExecutionBudgetError('turn_limit');
      if (budgets.remaining(state.budgets.outputBudget, budgets.totals(state).outputTokens) < 512 + 1024 + 256) throw new budgets.ExecutionBudgetError('output_budget');
    },
    snapshot: payload => {
      validatePairs(messages);
      const rounds = completeRounds(messages);
      const eligible = rounds.slice(0, Math.max(0, rounds.length - 2));
      const candidates = eligible.map(round => ({ content: JSON.stringify(round), round,
        estimated_tokens: approximateTokens({ messages: round }), role: 'assistant' }));
      const pinned = messages.filter(m => (m.role === 'system' && !isDerived(m)) || m.role === 'user');
      return { owner: meta.owner, version: meta.version, fingerprint: JSON.stringify(messages), identity,
        candidates, pinned, tail: rounds.slice(eligible.length).flat(), payload,
        oldSummary: meta.summary, checkpoint: meta.checkpoint,
        briefs: pinned.filter(m => m.role === 'user').map(m => ({ id: session.rawMessageIds.get(m), content_text: m.content })),
        rawLength: session.rawContext.length, ledgerBefore: budgets.totals(state) };
    },
    summarize: (prior, candidates) => generate(require('../compactionCore').WORKSPACE_SUMMARY_PROMPT,
      { oldSummary: prior, messages: candidates.map(c => wire(c.round)) }, 512),
    checkpointInput: (snapshot, summary) => {
      // Same newest-evidence-first policy and 12k ceiling as Workspace's
      // renderEvidenceForModel, additionally scaled to the child window.
      const all = adapter.evidence(), evidence = [];
      const cap = Math.min(12000, Math.floor(limit * .3 * 3));
      let used = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        const size = JSON.stringify(all[i]).length + 1;
        if (used + size > cap) continue;
        evidence.unshift(all[i]); used += size;
      }
      return { briefs: snapshot.briefs.map(b => ({ id: b.id, text: b.content_text })),
        priorCheckpoint: snapshot.checkpoint, rollingSummary: summary, evidence,
        evidenceOmitted: all.length - evidence.length,
        omissionNotice: all.length > evidence.length ? 'Older evidence omitted from this request; raw history and validated prior checkpoint remain authoritative.' : null,
        archivedCount: snapshot.candidates.length };
    },
    evidence: () => session.rawContext.filter(m => m.role === 'assistant' && m.tool_calls?.length).flatMap(m => m.tool_calls.map(call => {
      const result = session.rawContext.find(r => r.id > m.id && r.role === 'tool' && r.tool_call_id === call.id);
      let args = {}; try { args = JSON.parse(call.function.arguments); } catch {}
      return { messageId: m.id, stepId: call.id, toolName: call.function.name,
        kind: ['read_project_file', 'search_project_content', 'list_directory', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame'].includes(call.function.name) ? 'file-read' : 'web',
        outcome: !result ? 'unknown' : /^Error:|^\[Tool skipped/.test(result.content) ? 'error' : 'success',
        paths: [args.relative_path, args.url].filter(Boolean), args,
        resultSnippet: typeof result?.content === 'string' ? trimToolResult(result.content, { task: session.inputSummary?.task ?? '', contextLength: 4096, maxCharacters: 800 }) : '' };
    })),
    validationContext: snapshot => ({ sessionId: session.id, briefs: snapshot.briefs,
      index: new Map(adapter.evidence().map(row => [`${row.messageId}:${row.stepId}`, row])),
      messageExists: id => session.rawContext.some(m => m.id === id) }),
    draftCheckpoint: async input => {
      const text = await generate(require('../compactionCore').WORKSPACE_CHECKPOINT_PROMPT, input, 1024);
      try { return JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw compactionError('malformed-checkpoint'); }
    },
    buildPayload: (snapshot, summary, checkpoint, count) => ({ ...snapshot.payload, messages: [
      ...snapshot.pinned,
      ...(summary ? [{ role: 'system', content: `${SUMMARY_MARKER}\n${summary}` }] : []),
      ...(checkpoint ? [{ role: 'system', content: `${CHILD_CHECKPOINT}\n${checkpoint.content}` }] :
        snapshot.checkpoint ? [{ role: 'system', content: `${CHILD_CHECKPOINT}\n${require('../taskCheckpoints').renderCheckpointSection(snapshot.checkpoint, { version: snapshot.version, stale: false })}` }] : []),
      ...snapshot.candidates.slice(count).flatMap(c => c.round), ...snapshot.tail,
    ] }),
    commit: async (snapshot, candidate) => {
      signal?.throwIfAborted();
      if (snapshot.owner !== meta.owner || snapshot.version !== meta.version || snapshot.rawLength !== session.rawContext.length ||
          snapshot.fingerprint !== JSON.stringify(messages) || identity !== JSON.stringify(engine)) throw compactionError('context-changed');
      validatePairs(candidate.payload.messages);
      // Raw messages already exist; persistence keeps them alongside the active
      // projection. No old raw record is changed or replaced by a summary.
      messages.splice(0, messages.length, ...candidate.payload.messages);
      meta.version++; meta.summary = candidate.summary; meta.checkpoint = candidate.checkpoint;
      meta.events.push({ version: meta.version, reason: candidate.force ? 'overflow' : 'pressure',
        archivedMessageIds: snapshot.candidates.slice(0, candidate.selectedCount).flatMap(c => c.round.map(m => session.rawMessageIds.get(m))),
        before: candidate.before, after: candidate.after, ledgerBefore: snapshot.ledgerBefore, ledgerAfter: budgets.totals(state) });
      pushActivity(session, { type: 'compaction', version: meta.version, before: candidate.before.tokens, after: candidate.after.tokens });
      persist();
    },
    prepare: async (payload, force = false, contextWindowLimit = null) => {
      let enabled = true;
      try { enabled = require('../profileSettings').getSessionSettings(null, engine.modelId).effective.compactionEnabled; }
      catch (error) { if (!String(error.message).includes('Call initDatabase()')) throw error; }
      if (!enabled) {
        if (force) throw new ContextBudgetError('child compaction is disabled for the selected model');
        return payload;
      }
      if (contextWindowLimit) limit = Math.min(limit, contextWindowLimit);
      let result;
      try { result = await require('../compressionEngine').checkAndCompressContext({ transcriptAdapter: adapter, payload, force, signal }); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof TypeError) throw compactionError('invalid-summary-or-transcript');
        throw error;
      }
      adapter.lastMeasurement = result.after ?? result.before;
      if (result.compressed) return result.payload;
      if (result.reason?.startsWith('checkpoint-')) throw compactionError(result.reason);
      if (force || (result.before?.tokens + result.before?.reserve > result.before?.limit)) throw new ContextBudgetError(result.reason);
      if (result.reason !== 'below-threshold' && result.reason !== 'protected-context-too-large') throw compactionError(result.reason);
      return payload;
    },
  };
  return adapter;
}
module.exports = { createChildContextAdapter, trimToolResult, validatePairs, compactionError };
