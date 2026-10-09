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

function releaseCompressionLock(sessionId) {
  db.transaction(() => {
    db.prepare('UPDATE sessions SET is_compressing = 0 WHERE id = ?').run(sessionId);
  }).immediate();
}

function checkAndCompressContext(options) {
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
}) {
  validateOptions(sessionId, modelId, contextWindowLimit, llmSummarizeCallback);

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

    return {
      totalTokens: usage.totalTokens,
      messages: getActiveMessages(sessionId),
      oldSummary: getSessionSummary(sessionId),
    };
  }).immediate();

  if (!snapshot) return { compressed: false, archivedCount: 0 };

  try {
    const candidates = snapshot.messages.slice(
      0, Math.max(0, snapshot.messages.length - PROTECTED_MESSAGES),
    );
    if (candidates.length === 0) return { compressed: false, archivedCount: 0 };

    const target = Math.floor(0.65 * contextWindowLimit);
    const oldSummaryTokens = estimateTokens(snapshot.oldSummary ?? '');
    let remainingTokens = snapshot.totalTokens;
    let selectedCount = 0;
    let newSummary;

    // Start with the existing summary's size as an estimate. If the generated
    // summary is larger, include more eligible messages and summarize again.
    do {
      signal?.throwIfAborted();
      do {
        remainingTokens -= candidates[selectedCount].estimated_tokens;
        selectedCount += 1;
      } while ((force || remainingTokens > target) && selectedCount < candidates.length);

      newSummary = await llmSummarizeCallback(
        snapshot.oldSummary,
        candidates.slice(0, selectedCount).map((message) => ({ ...message,
          ...(force ? { content: require('./promptBuilder').messageForModel(message).content } : {}) })),
      );
      signal?.throwIfAborted();
      if (typeof newSummary !== 'string' || !newSummary.trim() || newSummary.includes('\0')) {
        throw new TypeError('The summarizer must return a non-empty summary string.');
      }

      const selectedTokens = candidates.slice(0, selectedCount)
        .reduce((total, message) => total + message.estimated_tokens, 0);
      remainingTokens = snapshot.totalTokens - oldSummaryTokens
        - selectedTokens + estimateTokens(newSummary);
    } while (remainingTokens > target && selectedCount < candidates.length);

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

    const archivedCount = db.transaction(() => {
      if (!require('./profileSettings').getSessionSettings(sessionId, modelId).effective.compactionEnabled) return 0;
      if (getSessionSummary(sessionId) !== snapshot.oldSummary) {
        throw new Error('Session summary changed during compression; retry later.');
      }

      const archive = db.prepare(`
        UPDATE messages SET archived = 1, is_summarized = 1
        WHERE id = ? AND session_id = ? AND archived = 0 AND is_summarized = 0
          AND role = ? AND content = ? AND estimated_tokens = ?
      `);
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
      if (latest) {
        db.prepare(`
          UPDATE session_summaries
          SET summary_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(newSummary, latest.id);
      } else {
        db.prepare(`
          INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)
        `).run(sessionId, newSummary);
      }

      return selectedCount;
    }).immediate();

    if (!archivedCount) return { compressed: false, archivedCount: 0 };
    return { compressed: true, archivedCount, summarizedMessageIds: candidates.slice(0, selectedCount).map(message => message.id) };
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

function scheduleIdleCompression(sessionId, modelId, contextWindowLimit, llmSummarizeCallback, onComplete = () => {}) {
  validateOptions(sessionId, modelId, contextWindowLimit, llmSummarizeCallback);
  const previous = idleTimers.get(sessionId);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    if (require('./dataAccess').isMigrating()) {
      scheduleIdleCompression(sessionId, modelId, contextWindowLimit, llmSummarizeCallback, onComplete);
      return;
    }
    let retry = false;
    void checkAndCompressContext({
      sessionId, modelId, contextWindowLimit, llmSummarizeCallback,
    }).then((result) => {
      retry = result.retry === true;
      if (result.compressed) onComplete({ sessionId, ...result });
    }).catch((error) => {
      console.error('Idle context compression failed:', error);
    }).finally(() => {
      // Keep a newer typing/streaming debounce if one has already been set.
      if ((retry || pendingUnlocks.has(sessionId)) && !idleTimers.has(sessionId)) {
        scheduleIdleCompression(sessionId, modelId, contextWindowLimit, llmSummarizeCallback, onComplete);
      }
    });
  }, IDLE_DELAY_MS);

  timer.unref?.();
  idleTimers.set(sessionId, timer);
}

module.exports = { checkAndCompressContext, scheduleIdleCompression, recoverContextOverflow };
