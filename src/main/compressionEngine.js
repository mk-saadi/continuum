'use strict';

const { db } = require('./db.js');
const {
  estimateTokens,
  getContextUsage,
  getActiveMessages,
  getSessionSummary,
} = require('./sessionManager.js');

const idleTimers = new Map();
const pendingUnlocks = new Set();
const inFlight = new Map();
const PROTECTED_MESSAGES = 10;
const IDLE_DELAY_MS = 10_000;

function validateOptions(sessionId, modelId, contextWindowLimit, callback) {
  for (const [name, value] of [['sessionId', sessionId], ['modelId', modelId]]) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new TypeError(`${name} must be a non-empty string without null characters.`);
    }
  }
  if (!Number.isSafeInteger(contextWindowLimit) || contextWindowLimit <= 0) {
    throw new TypeError('contextWindowLimit must be a positive safe integer.');
  }
  if (typeof callback !== 'function') {
    throw new TypeError('llmSummarizeCallback must be a function.');
  }
}

function isTemporaryLock(error) {
  return /^SQLITE_(BUSY|LOCKED)(_|$)/.test(error?.code ?? '');
}

// Token estimate for one wire message's content. Strings use the engine's
// len/4 estimator; multimodal arrays count text parts the same way and apply
// the documented image allowance from contextBudget.approximateTokens (exact
// patch counts are unknown). Anything else falls back to its JSON length.
function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (part?.type === 'text' && typeof part.text === 'string') return total + estimateTokens(part.text);
      if (part?.type === 'image_url') return total + 4096;
      return total + estimateTokens(JSON.stringify(part ?? null));
    }, 0);
  }
  return estimateTokens(JSON.stringify(content ?? ''));
}

// Lower-bound projection of the forced-recovery prompt floor: brief section +
// summary + session/base system block + protected tail + tool schemas +
// output reserve. Force mode always archives every candidate, so the tail is
// exactly the last PROTECTED_MESSAGES rows. Built only from existing
// builders; deliberately conservative (no skill injection, no delegation
// protocol, uncapped output reserve, caller tools only when provided), so a
// refusal here means no real request could fit. Anything admitted is still
// verified exactly by the context guard after rebuild.
function projectForcedFloor({ sessionId, modelId, summaryText, briefSection, checkpointSection, tailMessages, tools }) {
  const { buildSessionSystemPrompt } = require('./promptBuilder');
  const { prependBaseSystemPrompt } = require('./baseSystemPrompt');
  const effective = require('./profileSettings').getSessionSettings(sessionId, modelId).effective;
  const richLevel = require('./profileSettings').resolveRichLevel(sessionId, modelId);
  const projected = prependBaseSystemPrompt([
    ...(briefSection ? [briefSection] : []),
    ...(checkpointSection ? [checkpointSection] : []),
    ...(summaryText ? [{ role: 'system', content: `[EARLIER CONVERSATION SUMMARY]:\n${summaryText}` }] : []),
    buildSessionSystemPrompt({ sessionId, modelId, delegationAvailable: false, userText: '' }),
  ], effective.memoryEnabled, null, richLevel);
  const breakdown = { systemTokens: 0, summaryTokens: 0, briefTokens: 0, checkpointTokens: 0, tailTokens: 0, toolTokens: 0 };
  for (const message of projected) {
    const tokens = estimateContentTokens(message.content);
    if (message.taskBrief) breakdown.briefTokens += tokens;
    else if (message.taskCheckpoint) breakdown.checkpointTokens += tokens;
    else if (typeof message.content === 'string' && message.content.startsWith('[EARLIER CONVERSATION SUMMARY]:')) breakdown.summaryTokens += tokens;
    else breakdown.systemTokens += tokens;
  }
  for (const message of tailMessages) {
    try {
      breakdown.tailTokens += estimateContentTokens(require('./promptBuilder').messageForModel(message).content);
    } catch {
      // An unreadable attachment must not break the projection; fall back to
      // the stored estimate (a lower bound, keeping refusals sound).
      breakdown.tailTokens += message.estimated_tokens;
    }
  }
  // Same estimator as promptBuilder.getToolContext; absent when the caller
  // cannot provide schemas (lower bound, documented).
  if (Array.isArray(tools) && tools.length) breakdown.toolTokens = Math.ceil(JSON.stringify(tools).length / 4);
  return breakdown;
}

function checkForcedFloor({ breakdown, contextWindowLimit, maxTokens = null, thinkingBudget = null }) {
  const { reserveTokens } = require('./contextBudget');
  // Configured output caps when the caller knows them (production recovery);
  // otherwise the uncapped-request reserve. Runs with explicit caps resolve
  // larger reserves later, which the guard verifies exactly. Lower reserve
  // keeps this a sound refuse-only gate.
  const reserve = reserveTokens({
    max_tokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : -1,
    thinking_budget: Number.isSafeInteger(thinkingBudget) ? thinkingBudget : -1,
  }, contextWindowLimit);
  const budget = contextWindowLimit - reserve;
  const floor = breakdown.systemTokens + breakdown.summaryTokens + breakdown.briefTokens
    + breakdown.checkpointTokens + breakdown.tailTokens + breakdown.toolTokens;
  return { fits: !(floor > budget), floor, budget, reserve };
}

// Prospective post-archival prompt for exact pre-commit verification. Mirrors
// rebuildChatMessages for the state the commit would produce: every candidate
// archived, protected tail retained, in-flight rows excluded. RAG excerpts are
// not projected (spliced after recovery; the guard re-measures then).
function buildProspectivePrompt({ sessionId, modelId, summaryText, briefSection, checkpointSection, tailMessages,
  tools, delegationAvailable, userText, excludeMessageIds }) {
  const { buildSessionSystemPrompt, messageForModel } = require('./promptBuilder');
  const { prependBaseSystemPrompt } = require('./baseSystemPrompt');
  const effective = require('./profileSettings').getSessionSettings(sessionId, modelId).effective;
  const richLevel = require('./profileSettings').resolveRichLevel(sessionId, modelId);
  const excluded = new Set(excludeMessageIds ?? []);
  const retained = tailMessages.filter(message => !excluded.has(message.id)).map(message => {
    try {
      return messageForModel(message);
    } catch {
      // An unreadable attachment must not break the projection; the real
      // rebuild fails the same way, and the guard reports that failure.
      return { role: message.role, content: message.content };
    }
  });
  const messages = prependBaseSystemPrompt([
    ...(briefSection ? [briefSection] : []),
    ...(checkpointSection ? [checkpointSection] : []),
    ...(summaryText ? [{ role: 'system', content: `[EARLIER CONVERSATION SUMMARY]:\n${summaryText}` }] : []),
    buildSessionSystemPrompt({ sessionId, modelId, delegationAvailable, userText }),
    ...retained,
  ], effective.memoryEnabled, null, richLevel);
  return { messages, tools: Array.isArray(tools) ? tools : [] };
}

function releaseCompressionLock(sessionId) {
  db.transaction(() => {
    db.prepare('UPDATE sessions SET is_compressing = 0 WHERE id = ?').run(sessionId);
  }).immediate();
}

function checkAndCompressContext(options) {
  if (options.transcriptAdapter) return require('./compactionCore').compactTranscript({
    adapter: options.transcriptAdapter, payload: options.payload, force: options.force, signal: options.signal });
  const current = inFlight.get(options.sessionId);
  if (current) return current;
  const promise = require('./dataAccess').withDataAccess(() => checkAndCompressWithAccess(options));
  inFlight.set(options.sessionId, promise);
  promise.finally(() => { if (inFlight.get(options.sessionId) === promise) inFlight.delete(options.sessionId); }).catch(() => {});
  return promise;
}
async function recoverContextOverflow(options) {
  const timer = idleTimers.get(options.sessionId);
  if (timer) clearTimeout(timer);
  idleTimers.delete(options.sessionId);
  options.signal?.throwIfAborted();
  // Await the actual operation, never the scheduling acknowledgement.
  const current = inFlight.get(options.sessionId);
  if (current) await new Promise((resolve, reject) => {
    const abort = () => reject(options.signal.reason ?? Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    options.signal?.addEventListener('abort', abort, { once: true });
    current.then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', abort)).catch(() => {});
    if (options.signal?.aborted) abort();
  });
  options.signal?.throwIfAborted();
  const result = await checkAndCompressContext({ ...options, force: true });
  options.signal?.throwIfAborted();
  if (result.retry) throw new Error('Context recovery is waiting for the database. Retry after it becomes available.');
  return result;
}
async function checkAndCompressWithAccess(options) {
  const { sessionId, modelId, contextWindowLimit, llmSummarizeCallback } = options;
  validateOptions(sessionId, modelId, contextWindowLimit, llmSummarizeCallback);
  try {
    // A previous attempt may have committed successfully but been unable to
    // clear its flag while another connection held the write lock.
    if (pendingUnlocks.has(sessionId)) {
      releaseCompressionLock(sessionId);
      pendingUnlocks.delete(sessionId);
    }
    const result = await compressContext(options);
    return pendingUnlocks.has(sessionId) ? { ...result, retry: true } : result;
  } catch (error) {
    if (!isTemporaryLock(error)) throw error;
    console.warn('Context compression deferred: SQLite is busy; retrying on the next idle interval.');
    return { compressed: false, archivedCount: 0, retry: true };
  }
}

async function compressContext({
  sessionId,
  modelId,
  contextWindowLimit,
  llmSummarizeCallback,
  force = false, signal,
  // Schemas for the run being recovered, when the caller knows them
  // (forced recovery from engine:chat). Absent on the idle path and direct
  // calls; the floor projection then omits tools (documented lower bound).
  tools = null,
  // Exact pre-commit verification of the prospective prompt. The production
  // caller supplies a measurer over the existing server-template/tokenizer
  // path; direct calls and tests may omit it (floor gates only) or stub it.
  // Async: ({ messages, tools, limit, signal }) => ({ tokens, method, budget }).
  measurePrompt = null,
  // Fidelity inputs for the prospective prompt; mirror rebuildChatMessages.
  delegationAvailable = true,
  userText = '',
  // In-flight rows excluded from the rebuilt prompt (this generation's
  // persistence row). Excluded from projection and tail checks alike.
  excludeMessageIds = [],
  // Structured checkpoint drafting for Workspace sessions. The production
  // caller supplies it; without it a Workspace compression that requires a
  // checkpoint fails closed. Async: (input, modelId, { signal, maxTokens }) =>
  // parsed checkpoint object (transport-level JSON extraction only; the
  // engine validates structure and evidence before persistence).
  llmCheckpointCallback = null,
  // Configured output caps for reserve fidelity (production recovery reads
  // them from session sampling settings). Nulls keep uncapped defaults.
  maxTokens = null,
  thinkingBudget = null,
}) {
  validateOptions(sessionId, modelId, contextWindowLimit, llmSummarizeCallback);
  if (tools !== null && !Array.isArray(tools)) throw new TypeError('tools must be an array when provided.');
  if (measurePrompt !== null && typeof measurePrompt !== 'function') throw new TypeError('measurePrompt must be a function when provided.');
  if (!Array.isArray(excludeMessageIds)) throw new TypeError('excludeMessageIds must be an array.');
  if (llmCheckpointCallback !== null && typeof llmCheckpointCallback !== 'function') throw new TypeError('llmCheckpointCallback must be a function when provided.');

  // Acquire the lock and capture context atomically; never hold a transaction
  // open while waiting for the LLM.
  const snapshot = db.transaction(() => {
    if (!require('./profileSettings').getSessionSettings(sessionId, modelId).effective.compactionEnabled) return null;
    const usage = getContextUsage(sessionId, modelId);
    if (!force && usage.totalTokens <= 0.75 * contextWindowLimit) return null;

    const lock = db.prepare(`
      UPDATE sessions SET is_compressing = 1
      WHERE id = ? AND is_compressing = 0
    `).run(sessionId);
    if (lock.changes !== 1) return null;

    // Brief identity is part of the snapshot: a concurrent instruction,
    // revision, or branch switch must abort archival, like a summary change.
    // Token math stays DB-only here (no file reads inside the transaction).
    // The leaf pointer anchors the tail/leaf revalidation at commit time.
    // Workspace sessions additionally snapshot the evidence fingerprint so
    // execution-step mutations invalidate the checkpoint candidate.
    const applicableBriefs = require('./taskBriefs').getApplicableBriefs(sessionId);
    const activeMessages = getActiveMessages(sessionId);
    return {
      totalTokens: usage.totalTokens,
      messages: activeMessages,
      oldSummary: getSessionSummary(sessionId),
      briefIdentity: applicableBriefs.map(brief => brief.id).join(','),
      briefTokens: require('./taskBriefs').estimateBriefTokens(applicableBriefs),
      leafId: db.prepare('SELECT active_leaf_id FROM sessions WHERE id = ?').get(sessionId)?.active_leaf_id ?? null,
      isWorkspace: require('./taskBriefs').isWorkspaceSession(sessionId),
      evidenceFingerprint: require('./taskCheckpoints').computeEvidenceFingerprint(activeMessages),
    };
  }).immediate();

  if (!snapshot) return { compressed: false, archivedCount: 0 };

  try {
    const candidates = snapshot.messages.slice(
      0, Math.max(0, snapshot.messages.length - PROTECTED_MESSAGES),
    );
    if (candidates.length === 0) return { compressed: false, archivedCount: 0 };

    // Forced recovery archives every candidate, so the post-recovery floor is
    // already known: brief + checkpoint + old summary + system block +
    // protected tail + tools + reserve. If that floor exceeds the usable
    // budget, no summary can make the request fit: refuse before the model
    // call and without archiving, instead of eroding history across repeated
    // attempts. Idle compression keeps its existing threshold behavior.
    let briefSection = null;
    let currentCheckpointSection = null;
    const tailMessages = snapshot.messages.slice(candidates.length);
    const refuse = (breakdown, budget, reserve) => ({ compressed: false, archivedCount: 0,
      reason: 'non-compressible-context-too-large',
      floorTokens: breakdown.systemTokens + breakdown.summaryTokens + breakdown.briefTokens
        + breakdown.checkpointTokens + breakdown.tailTokens + breakdown.toolTokens,
      budget, reserve, floorBreakdown: breakdown });
    if (force) {
      briefSection = require('./taskBriefs').buildTaskBriefSection(sessionId);
      // Estimate with the current checkpoint section; the candidate section
      // (same cap, same shape) replaces it in the post-generation gates.
      currentCheckpointSection = snapshot.isWorkspace
        ? require('./taskCheckpoints').buildCheckpointSection(sessionId) : null;
      const breakdown = projectForcedFloor({ sessionId, modelId,
        summaryText: snapshot.oldSummary, briefSection, checkpointSection: currentCheckpointSection,
        tailMessages, tools });
      const { fits, budget, reserve } = checkForcedFloor({ breakdown, contextWindowLimit, maxTokens, thinkingBudget });
      if (!fits) return refuse(breakdown, budget, reserve);
    }

    const { newSummary, selectedCount, remainingTokens, oldSummaryTokens } = await require('./compactionCore').summarizeCandidates({
      candidates, oldSummary: snapshot.oldSummary, totalTokens: snapshot.totalTokens,
      contextWindowLimit, force, signal, estimate: estimateTokens, summarize: llmSummarizeCallback,
      modelMessage: message => ({ ...message,
        ...(force ? { content: require('./promptBuilder').messageForModel(message).content } : {}) }),
    });

    // Core memories and the ten protected messages can make 65% unattainable.
    // Do not replace context with a summary that saves no tokens.
    const selectedSourceTokens = force ? candidates.slice(0, selectedCount).reduce((total, message) => {
      const content = require('./promptBuilder').messageForModel(message).content;
      return total + estimateTokens(typeof content === 'string' ? content : JSON.stringify(content));
    }, 0) : 0;
    // Include expanded attachment text for forced recovery. Refuse a summary
    // that makes the recoverable source larger, even though its DB estimate
    // may have counted only a tiny user caption.
    if ((!force && remainingTokens >= snapshot.totalTokens) ||
        (force && estimateTokens(newSummary) >= oldSummaryTokens + selectedSourceTokens)) {
      return { compressed: false, archivedCount: 0 };
    }

    // The preserved brief must survive compression, but it also consumes
    // context on every rebuild. If it alone exceeds the window, archiving
    // more history cannot help: fail closed without touching history. The
    // rows stay in durable storage for inspection and fresh-session reuse.
    if (snapshot.briefTokens > contextWindowLimit) {
      return { compressed: false, archivedCount: 0, reason: 'task-brief-too-large' };
    }

    // Re-project with the grown summary before committing: a summary larger
    // than estimated can break fit even when the pre-call floor passed.
    // Refusal here archives nothing and writes no summary.
    let postBreakdown = null;
    if (force) {
      postBreakdown = projectForcedFloor({ sessionId, modelId,
        summaryText: newSummary, briefSection, checkpointSection: currentCheckpointSection,
        tailMessages, tools });
      const { fits, budget, reserve } = checkForcedFloor({ breakdown: postBreakdown, contextWindowLimit, maxTokens, thinkingBudget });
      if (!fits) return refuse(postBreakdown, budget, reserve);
    }

    // Workspace checkpoint: draft from briefs + evidence + prior checkpoint,
    // validate structure and evidence in this process, and fail the candidate
    // (no archival, no summary write) when generation or validation fails.
    // Casual sessions skip this entirely.
    let candidateCheckpoint = null;
    let candidateSection = null;
    if (snapshot.isWorkspace) {
      if (typeof llmCheckpointCallback !== 'function') {
        return { compressed: false, archivedCount: 0, reason: 'checkpoint-unavailable' };
      }
      signal?.throwIfAborted();
      const checkpoints = require('./taskCheckpoints');
      const selected = candidates.slice(0, selectedCount);
      let generated;
      try {
        generated = await require('./compactionCore').generateCheckpoint({
          input: checkpoints.buildCheckpointInput({ sessionId, candidates: selected, newSummary }),
          draft: input => llmCheckpointCallback(input, modelId, { signal, maxTokens: checkpoints.CHECKPOINT_LLM_MAX_TOKENS }),
          validationContext: { sessionId, briefs: require('./taskBriefs').getApplicableBriefs(sessionId),
            index: checkpoints.evidenceIndex(checkpoints.collectEvidence(selected)) },
          version: (checkpoints.getLatestCheckpoint(sessionId)?.id ?? 0) + 1, signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        return { compressed: false, archivedCount: 0, reason: 'checkpoint-generation-failed' };
      }
      if (!generated.ok) return { compressed: false, archivedCount: 0, reason: generated.reason };
      candidateCheckpoint = generated.checkpoint;
      candidateSection = generated.section;
      candidateSection.checkpointTokens = estimateTokens(candidateSection.content);
    }

    // Exact pre-commit verification with the existing tokenizer path. The
    // prospective prompt reflects the candidate result (new summary, brief,
    // retained tail, system/project context, schemas, reserve) without
    // archiving or replacing the persisted summary first. An exact
    // over-budget measurement refuses the candidate; an unavailable or
    // approximate measurement falls back to the floor-gate outcome above and
    // is recorded as such, never as proof of fit.
    let measuredMethod = force ? 'unverified' : undefined;
    if (force && typeof measurePrompt === 'function') {
      const prospective = buildProspectivePrompt({ sessionId, modelId, summaryText: newSummary,
        briefSection, checkpointSection: candidateSection, tailMessages, tools,
        delegationAvailable, userText, excludeMessageIds });
      let measured = null;
      try {
        measured = await measurePrompt({ messages: prospective.messages, tools: prospective.tools,
          limit: contextWindowLimit, signal });
      } catch (error) {
        signal?.throwIfAborted();
        measured = null;
      }
      signal?.throwIfAborted();
      if (measured && typeof measured === 'object') {
        measuredMethod = typeof measured.method === 'string' ? measured.method : 'unavailable';
        if (measured.method === 'server-template-tokenizer'
          && Number.isSafeInteger(measured.tokens) && Number.isSafeInteger(measured.budget)
          && measured.tokens > measured.budget) {
          return { compressed: false, archivedCount: 0, reason: 'prospective-prompt-exceeds-budget',
            measuredTokens: measured.tokens, budget: measured.budget, measuredMethod,
            floorBreakdown: postBreakdown };
        }
      }
    }

    const commit = db.transaction(() => {
      if (!require('./profileSettings').getSessionSettings(sessionId, modelId).effective.compactionEnabled) return { count: 0, checkpointId: null };
      let checkpointId = null;
      if (getSessionSummary(sessionId) !== snapshot.oldSummary) {
        throw new Error('Session summary changed during compression; retry later.');
      }
      if (require('./taskBriefs').getBriefIdentity(sessionId) !== snapshot.briefIdentity) {
        throw new Error('Task brief changed during compression; retry later.');
      }
      if (force) {
        // The measured candidate must be the committed candidate: a moved
        // leaf (appended message, branch switch) or a rewritten tail row
        // invalidates the projection. In-flight rows excluded from the
        // rebuilt prompt are excluded here alike; their parked content is
        // covered by the candidate predicates when archived, never as tail.
        // Idle compression keeps its existing predicates only.
        const leafId = db.prepare('SELECT active_leaf_id FROM sessions WHERE id = ?').get(sessionId)?.active_leaf_id ?? null;
        if (leafId !== snapshot.leafId) {
          throw new Error('Session history changed during compression; retry later.');
        }
        const excluded = new Set(excludeMessageIds ?? []);
        const checkTail = db.prepare('SELECT content, estimated_tokens FROM messages WHERE id = ? AND session_id = ?');
        for (const message of tailMessages) {
          if (excluded.has(message.id)) continue;
          const current = checkTail.get(message.id, sessionId);
          if (!current || current.content !== message.content || current.estimated_tokens !== message.estimated_tokens) {
            throw new Error('Session history changed during compression; retry later.');
          }
        }
      }

      const archive = db.prepare(`
        UPDATE messages SET archived = 1, is_summarized = 1
        WHERE id = ? AND session_id = ? AND archived = 0 AND is_summarized = 0
          AND role = ? AND content = ? AND estimated_tokens = ?
      `);
      // Workspace evidence check BEFORE archival mutates the active set:
      // execution-step mutations bypass the message predicates, so compare
      // the live fingerprint to the snapshot while the sets still align.
      // The archived-subset fingerprint below is what read-time staleness
      // compares against (the full-set snapshot fingerprint cannot be
      // reconstructed after archival).
      let archivedFingerprint = snapshot.evidenceFingerprint;
      if (snapshot.isWorkspace) {
        if (!candidateCheckpoint) throw new Error('Workspace compression requires a validated checkpoint.');
        const checkpoints = require('./taskCheckpoints');
        if (checkpoints.computeEvidenceFingerprint(getActiveMessages(sessionId)) !== snapshot.evidenceFingerprint) {
          throw new Error('Task evidence changed during compression; retry later.');
        }
        archivedFingerprint = checkpoints.computeEvidenceFingerprint(candidates.slice(0, selectedCount));
      }
      for (const message of candidates.slice(0, selectedCount)) {
        const result = archive.run(
          message.id, sessionId, message.role, message.content, message.estimated_tokens,
        );
        if (result.changes !== 1) {
          throw new Error('Messages changed during compression; retry later.');
        }
      }

      const latest = db.prepare(`
        SELECT id FROM session_summaries WHERE session_id = ?
        ORDER BY updated_at DESC, id DESC LIMIT 1
      `).get(sessionId);
      let summaryId = latest ? latest.id : null;
      if (latest) {
        db.prepare(`
          UPDATE session_summaries
          SET summary_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(newSummary, latest.id);
      } else {
        summaryId = Number(db.prepare(`
          INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)
        `).run(sessionId, newSummary).lastInsertRowid);
      }

      // Checkpoint persistence is atomic with the archival above; the
      // evidence fingerprint was re-verified before archival just above.
      if (snapshot.isWorkspace) {
        const checkpoints = require('./taskCheckpoints');
        checkpointId = checkpoints.persistCheckpointRow({
          sessionId, modelId, checkpoint: candidateCheckpoint,
          summaryId, summaryText: newSummary,
          briefIdentity: require('./taskBriefs').getBriefIdentity(sessionId),
          leafId: db.prepare('SELECT active_leaf_id FROM sessions WHERE id = ?').get(sessionId)?.active_leaf_id ?? null,
          archivedIds: candidates.slice(0, selectedCount).map(message => message.id),
          fingerprint: archivedFingerprint,
        });
      }

      return { count: selectedCount, checkpointId };
    }).immediate();
    const archivedCount = commit.count;
    const checkpointId = commit.checkpointId;

    if (!archivedCount) return { compressed: false, archivedCount: 0 };
    const completed = { compressed: true, archivedCount, summarizedMessageIds: candidates.slice(0, selectedCount).map(message => message.id) };
    if (measuredMethod !== undefined) completed.measuredMethod = measuredMethod;
    if (checkpointId !== null && checkpointId !== undefined) completed.checkpointId = checkpointId;
    return completed;
  } finally {
    try {
      releaseCompressionLock(sessionId);
    } catch (error) {
      if (!isTemporaryLock(error)) throw error;
      pendingUnlocks.add(sessionId);
      console.warn('Compression flag cleanup deferred: SQLite is busy; retrying on the next idle interval.');
    }
  }
}

function scheduleIdleCompression(sessionId, modelId, contextWindowLimit, llmSummarizeCallback, onComplete = () => {}, llmCheckpointCallback = null) {
  validateOptions(sessionId, modelId, contextWindowLimit, llmSummarizeCallback);
  if (llmCheckpointCallback !== null && typeof llmCheckpointCallback !== 'function') throw new TypeError('llmCheckpointCallback must be a function when provided.');
  const previous = idleTimers.get(sessionId);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    if (require('./dataAccess').isMigrating()) {
      scheduleIdleCompression(sessionId, modelId, contextWindowLimit, llmSummarizeCallback, onComplete, llmCheckpointCallback);
      return;
    }
    let retry = false;
    void checkAndCompressContext({
      sessionId, modelId, contextWindowLimit, llmSummarizeCallback, llmCheckpointCallback,
    }).then((result) => {
      retry = result.retry === true;
      if (result.compressed) onComplete({ sessionId, ...result });
      else if (result.reason) onComplete({ sessionId, ...result });
    }).catch((error) => {
      console.error('Idle context compression failed:', error);
      // Surface the failure to the inspection panel through the existing
      // completion channel. Existing listeners ignore non-compressed
      // results (empty id sets); the panel renders the error explicitly.
      onComplete({ sessionId, compressed: false, error: error?.message ?? String(error) });
    }).finally(() => {
      // Keep a newer typing/streaming debounce if one has already been set.
      if ((retry || pendingUnlocks.has(sessionId)) && !idleTimers.has(sessionId)) {
        scheduleIdleCompression(sessionId, modelId, contextWindowLimit, llmSummarizeCallback, onComplete, llmCheckpointCallback);
      }
    });
  }, IDLE_DELAY_MS);

  timer.unref?.();
  idleTimers.set(sessionId, timer);
}

module.exports = { checkAndCompressContext, scheduleIdleCompression, recoverContextOverflow };
