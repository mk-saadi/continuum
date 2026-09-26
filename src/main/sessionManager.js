'use strict';

const { normalizeExecutionSteps, readExecutionSteps } = require('./executionSteps');
const { validateAttachments } = require('./fileUploads');
const { db } = require('./db.js');
const { variantFromRow, parseVariants } = require('./messageVariants');
const { validateSamplingParams, parseSamplingParams, getGlobalSamplingParams } = require('./samplingManager');
const { getCoreMemories } = require('./memoryManager.js');

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without null characters.`);
  }
}

function estimateTokens(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string.');
  }
  return Math.ceil(text.length / 4);
}

function getOrCreateSession(sessionId, modelId) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(modelId, 'modelId');

  return db.transaction(() => {
    const select = db.prepare('SELECT * FROM sessions WHERE id = ?');
    const existing = select.get(sessionId);
    if (existing) return existing;

    db.prepare('INSERT INTO sessions(id, model_id) VALUES (?, ?)')
      .run(sessionId, modelId);
    return select.get(sessionId);
  }).immediate();
}

function saveMessage(sessionId, role, content, attachments = [], stats = null, toolCalls = null, thinking = null, messageId = null, identity = null, executionSteps = null) {
  requireIdentifier(sessionId, 'sessionId');
  if (!['user', 'assistant', 'system'].includes(role)) {
    throw new TypeError('role must be user, assistant, or system.');
  }
  if (messageId !== null && (!Number.isSafeInteger(messageId) || messageId <= 0 || role !== 'assistant')) throw new TypeError('Only an existing assistant message may be updated.');
  const steps = normalizeExecutionSteps(executionSteps);
  if (steps !== null && role !== 'assistant') throw new TypeError('Only assistant messages may have execution steps.');
  const messageStats = normalizeStats(stats);
  const messageTools = normalizeToolCalls(toolCalls);
  const messageThinking = normalizeThinking(thinking);
  if (identity !== null) {
    if (role !== 'assistant' || typeof identity !== 'object' || Array.isArray(identity)) throw new TypeError('Only assistant messages may have model identity metadata.');
    for (const key of ['modelName', 'modelId', 'agentName']) {
      if (identity[key] != null) requireIdentifier(identity[key], key);
    }
  }
  if ((messageTools || messageThinking.text !== null || messageThinking.duration !== null) && role !== 'assistant') throw new TypeError('Only assistant messages may have tool or thinking metadata.');
  if (messageStats && role !== 'assistant') throw new TypeError('Only assistant messages may have generation stats.');
  const estimatedTokens = estimateTokens(content);
  const files = validateAttachments(attachments);
  if (files.length && role !== 'user') throw new TypeError('Only user messages may have attachments.');

  return db.transaction(() => {
    let savedId = messageId;
    if (messageId !== null) {
      const existing = db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = 'assistant'").get(messageId, sessionId);
      if (!existing) throw new Error('Assistant message not found in this session.');
      requireMutableSession(sessionId);
      // Missing/null late metrics cannot erase previously reported values.
      // A new non-null metric (including zero) replaces that metric on this row.
      const previousStats = parseStats(existing.stats);
      const mergedStats = messageStats ? normalizeStats({
        ...previousStats,
        ...Object.fromEntries(Object.entries(messageStats).filter(([, value]) => value !== null)),
      }) : previousStats;
      // Origin is immutable after insertion, even when a late save supplies
      // metadata from a different model/persona. A null agent means no persona.
      db.prepare(`
        UPDATE messages SET content = ?, estimated_tokens = ?, stats = ?,
          tool_calls = ?, thinking_text = ?, thinking_duration = ?
        WHERE id = ? AND session_id = ? AND role = 'assistant'
      `).run(content, estimatedTokens, mergedStats ? JSON.stringify(mergedStats) : null,
        toolCalls == null ? existing.tool_calls : messageTools ? JSON.stringify(messageTools) : null,
        thinking == null ? existing.thinking_text : messageThinking.text,
        thinking == null ? existing.thinking_duration : messageThinking.duration,
        messageId, sessionId);
    } else {
      const result = db.prepare(`
        INSERT INTO messages(session_id, role, content, estimated_tokens, archived, stats, tool_calls, thinking_text, thinking_duration, model_name, model_id, agent_name)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, role, content, estimatedTokens,
        messageStats ? JSON.stringify(messageStats) : null,
        messageTools ? JSON.stringify(messageTools) : null,
        messageThinking.text, messageThinking.duration,
        identity?.modelName ?? identity?.modelId ?? null, identity?.modelId ?? null, identity?.agentName ?? null);
      savedId = result.lastInsertRowid;
    }

    if (steps !== null) db.prepare('UPDATE messages SET execution_steps = ?, tool_calls = NULL, thinking_text = NULL, thinking_duration = NULL WHERE id = ?').run(JSON.stringify(steps), savedId);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(savedId);
    const variants = parseVariants(updated);
    const activeIndex = updated.active_variant_index ?? 0;
    variants[activeIndex] = variantFromRow({ ...updated, created_at: variants[activeIndex]?.created_at ?? updated.created_at });
    db.prepare('UPDATE messages SET variants = ? WHERE id = ?').run(JSON.stringify(variants), savedId);

    const insertAttachment = db.prepare(`
      INSERT INTO message_attachments(message_id, file_path, mime_type) VALUES (?, ?, ?)
    `);
    for (const attachment of files) {
      insertAttachment.run(savedId, attachment.file_path, attachment.mime_type);
    }

    db.prepare(`
      UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(sessionId);

    if (role === 'user') db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL").run(content.slice(0, 80) || 'File attachment', sessionId);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(savedId);
    const savedMessage = withAttachments([row])[0];
    // Preserve the existing token-count alias for callers while returning the full row.
    return { ...savedMessage, estimatedTokens };
  }).immediate();
}

function getActiveMessages(sessionId) {
  requireIdentifier(sessionId, 'sessionId');
  return withAttachments(db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND archived = 0
    ORDER BY id ASC
  `).all(sessionId));
}

function getSessionSummary(sessionId) {
  requireIdentifier(sessionId, 'sessionId');
  const row = db.prepare(`
    SELECT summary_text FROM session_summaries
    WHERE session_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(sessionId);
  return row ? row.summary_text : null;
}

function getContextUsage(sessionId, currentModelId) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(currentModelId, 'currentModelId');

  // Read all context components from the same database snapshot.
  return db.transaction(() => {
    const coreTokens = getCoreMemories(currentModelId)
      .reduce((total, memory) => total + estimateTokens(memory.content), 0);
    const summary = getSessionSummary(sessionId);
    const { messageTokens, messageCount } = db.prepare(`
      SELECT COALESCE(SUM(estimated_tokens), 0) AS messageTokens,
             COUNT(*) AS messageCount
      FROM messages
      WHERE session_id = ? AND archived = 0
    `).get(sessionId);

    return {
      totalTokens: coreTokens + (summary === null ? 0 : estimateTokens(summary)) + messageTokens,
      messageCount,
      hasSummary: summary !== null,
    };
  })();
}

module.exports = {
  estimateTokens,
  getOrCreateSession,
  saveMessage,
  getActiveMessages,
  getSessionSummary,
  getContextUsage,
};

function loadSession(sessionId) {
  requireIdentifier(sessionId, 'sessionId');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found.');
  return { ...session, messages: withAttachments(db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId)) };
}

function getAllSessions() {
  const groups = new Map(db.prepare('SELECT name FROM chat_folders ORDER BY name COLLATE NOCASE').all()
    .map(({ name }) => [name, []]));
  for (const session of db.prepare(`SELECT s.*, COALESCE(t.total_tokens, 0) AS total_tokens
    FROM sessions s LEFT JOIN (
      SELECT session_id, SUM(estimated_tokens) AS total_tokens FROM messages GROUP BY session_id
    ) t ON t.session_id = s.id ORDER BY s.last_active_at DESC, s.id DESC`).all()) {
    if (!groups.has(session.folder_name)) groups.set(session.folder_name, []);
    groups.get(session.folder_name).push(session);
  }
  const unassigned = groups.get('Uncategorized') || [];
  groups.delete('Uncategorized');
  return [...groups].map(([folder_name, sessions]) => ({ folder_name, sessions }))
    .concat({ folder_name: 'Uncategorized', sessions: unassigned });
}

function createFolder(name) {
  requireIdentifier(name, 'Folder name');
  name = name.trim();
  if (name === 'Uncategorized') throw new Error('This name is reserved for unassigned chats.');
  const result = db.prepare('INSERT OR IGNORE INTO chat_folders(name) VALUES (?)').run(name);
  if (!result.changes) throw new Error('A folder with this name already exists.');
  return { folder_name: name };
}

function updateSession(sessionId, field, value) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(value, field);
  if (!['title', 'folder_name'].includes(field)) throw new Error('Invalid session field.');
  return db.transaction(() => {
    const result = db.prepare(`UPDATE sessions SET ${field} = ? WHERE id = ?`).run(value.trim(), sessionId);
    if (!result.changes) throw new Error('Session not found.');
    if (field === 'folder_name' && value.trim() !== 'Uncategorized') {
      db.prepare('INSERT OR IGNORE INTO chat_folders(name) VALUES (?)').run(value.trim());
    }
    return loadSession(sessionId);
  }).immediate();
}

function requireMutableSession(sessionId) {
  const session = loadSession(sessionId);
  if (session.is_compressing) throw new Error('History is being summarized. Please retry shortly.');
}

function deleteSession(sessionId) {
  return db.transaction(() => {
    requireMutableSession(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return { deleted: true };
  }).immediate();
}

function editMessage(messageId, newContent) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TypeError('Invalid messageId.');
  requireIdentifier(newContent, 'newContent');
  return db.transaction(() => {
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!message || message.role !== 'user') throw new Error('User message not found.');
    requireMutableSession(message.session_id);
    db.prepare('UPDATE messages SET content = ?, variants = ?, active_variant_index = 0, estimated_tokens = ? WHERE id = ?')
      .run(newContent, JSON.stringify([variantFromRow({ ...message, content: newContent })]), estimateTokens(newContent), messageId);
    db.prepare('DELETE FROM messages WHERE session_id = ? AND id > ?').run(message.session_id, messageId);
    db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(message.session_id);
    db.prepare('UPDATE messages SET archived = 0 WHERE session_id = ?').run(message.session_id);
    db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(message.session_id);
    return loadSession(message.session_id).messages;
  }).immediate();
}

Object.assign(module.exports, { loadSession, getAllSessions, createFolder, updateSession, deleteSession, editMessage });

function withAttachments(messages) {
  const select = db.prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id');
  return messages.map(({ tool_calls, thinking_text, thinking_duration, execution_steps, ...message }) => ({
    ...message,
    variants: parseVariants({ ...message, tool_calls, thinking_text, thinking_duration, execution_steps }),
    executionSteps: readExecutionSteps({ ...message, tool_calls, thinking_text, thinking_duration, execution_steps }),
    content: parseVariants(message)[message.active_variant_index ?? 0]?.content ?? message.content,
    modelName: message.model_name,
    modelId: message.model_id,
    agentName: message.agent_name,
    stats: parseStats(message.stats),
    ...(execution_steps == null ? { toolCalls: parseToolCalls(tool_calls),
    thinkingText: typeof thinking_text === 'string' ? thinking_text : null,
    thinkingDuration: typeof thinking_duration === 'number' && Number.isFinite(thinking_duration) && thinking_duration >= 0 ? thinking_duration : null } : {}),
    attachments: select.all(message.id),
  }));
}

// Keep nullable metrics when the server did not report token usage.
function normalizeStats(stats) {
  if (stats == null) return null;
  if (typeof stats !== 'object' || Array.isArray(stats)) throw new TypeError('Invalid generation stats.');
  if (Object.keys(stats).length === 0) return null;
  const result = {};
  for (const key of ['startTime', 'endTime', 'time', 'promptTokens', 'completionTokens', 'totalTokens', 'tokensPerSecond']) {
    const value = stats[key] ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      (key.endsWith('Tokens') && !Number.isSafeInteger(value)))) throw new TypeError(`Invalid generation stat: ${key}.`);
    result[key] = value;
  }
  if (stats.generationTime != null) {
    if (typeof stats.generationTime !== 'number' || !Number.isFinite(stats.generationTime) || stats.generationTime < 0) throw new TypeError('Invalid generation time.');
    result.generationTime = stats.generationTime;
  }
  if (Array.isArray(stats.raw)) result.raw = JSON.parse(JSON.stringify(stats.raw));
  if (stats.scope != null) {
    if (!['all', 'final'].includes(stats.scope)) throw new TypeError('Invalid generation stats scope.');
    result.scope = stats.scope;
  }
  return result;
}

function parseStats(value) {
  if (!value) return null;
  try { return normalizeStats(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return null; } // A malformed historical value must not prevent loading the chat.
}

// Preserve complete tool cards (including results/errors) while validating rendered fields.
function normalizeToolCalls(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new TypeError('Tool calls must be an array.');
  if (!value.length) return null;
  for (const call of value) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw new TypeError('Invalid tool call.');
    for (const key of ['id', 'serverName', 'toolName', 'status', 'error']) {
      if (call[key] != null && typeof call[key] !== 'string') throw new TypeError(`Invalid tool call ${key}.`);
    }
  }
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new TypeError('Tool calls must contain JSON-serializable data.'); }
}

function parseToolCalls(value) {
  if (!value) return null;
  try { return normalizeToolCalls(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return null; }
}

function normalizeThinking(thinking) {
  if (thinking == null) return { text: null, duration: null };
  if (typeof thinking !== 'object' || Array.isArray(thinking)) throw new TypeError('Invalid thinking metadata.');
  const text = thinking.text ?? null;
  const duration = thinking.duration ?? null;
  if (text !== null && typeof text !== 'string') throw new TypeError('Thinking text must be a string.');
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) throw new TypeError('Invalid thinking duration.');
  return { text, duration };
}

function deleteMessage(sessionId, messageId) {
  requireIdentifier(sessionId, 'sessionId');
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TypeError('Invalid messageId.');
  return db.transaction(() => {
    requireMutableSession(sessionId);
    const result = db.prepare('DELETE FROM messages WHERE id = ? AND session_id = ?').run(messageId, sessionId);
    if (!result.changes) throw new Error('Message not found in this session.');
    // Summaries may still contain the deleted turn; rebuild context from retained rows.
    db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE messages SET archived = 0 WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
    return loadSession(sessionId).messages;
  }).immediate();
}

function branchChat(sourceSessionId, targetMessageId) {
  requireIdentifier(sourceSessionId, 'sourceSessionId');
  if (!Number.isSafeInteger(targetMessageId) || targetMessageId <= 0) throw new TypeError('Invalid targetMessageId.');
  return db.transaction(() => {
    const source = loadSession(sourceSessionId);
    if (!db.prepare('SELECT id FROM messages WHERE session_id = ? AND id = ?').get(sourceSessionId, targetMessageId)) {
      throw new Error('Message not found in this session.');
    }
    const sessionId = require('node:crypto').randomUUID();
    db.prepare('INSERT INTO sessions(id, model_id, title, folder_name, sampling_params, agent_profile) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, source.model_id, `${source.title || 'Untitled chat'} (branch)`, source.folder_name, source.sampling_params, source.agent_profile);
    // All original turns are retained, including archived turns. Do not copy a
    // summary that could include messages beyond the branch point.
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? AND id <= ? ORDER BY id').all(sourceSessionId, targetMessageId);
    const insert = db.prepare(`INSERT INTO messages
      (session_id, role, content, estimated_tokens, stats, tool_calls, thinking_text, thinking_duration, model_name, model_id, agent_name, archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
    const copyAttachments = db.prepare(`INSERT INTO message_attachments(message_id, file_path, mime_type, estimated_tokens)
      SELECT ?, file_path, mime_type, estimated_tokens FROM message_attachments WHERE message_id = ? ORDER BY id`);
    for (const message of messages) {
      const result = insert.run(sessionId, message.role, message.content, message.estimated_tokens,
        message.stats, message.tool_calls, message.thinking_text, message.thinking_duration,
        message.model_name, message.model_id, message.agent_name, message.created_at);
      db.prepare('UPDATE messages SET variants = ?, active_variant_index = ? WHERE id = ?').run(JSON.stringify(parseVariants(message)), message.active_variant_index ?? 0, result.lastInsertRowid);
      db.prepare('UPDATE messages SET execution_steps = ? WHERE id = ?').run(message.execution_steps, result.lastInsertRowid);
      copyAttachments.run(result.lastInsertRowid, message.id);
    }
    return { sessionId };
  }).immediate();
}

Object.assign(module.exports, { deleteMessage, branchChat });


function getSessionSamplingParams(sessionId) {
  requireIdentifier(sessionId, 'sessionId');
  const row = db.prepare('SELECT sampling_params FROM sessions WHERE id = ?').get(sessionId);
  const overrides = parseSamplingParams(row?.sampling_params);
  const global = getGlobalSamplingParams();
  return { params: { ...global, ...overrides }, global, overrides, exists: !!row };
}
function saveSessionSamplingParams(sessionId, modelId, patch) {
  requireIdentifier(sessionId, 'sessionId');
  const valid = patch === null ? null : validateSamplingParams(patch);
  return db.transaction(() => {
    // New drafts have no session row until the first message or tuning edit.
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) getOrCreateSession(sessionId, modelId);
    const overrides = valid === null ? null : { ...getSessionSamplingParams(sessionId).overrides, ...valid };
    db.prepare('UPDATE sessions SET sampling_params = ? WHERE id = ?').run(overrides === null ? null : JSON.stringify(overrides), sessionId);
    return getSessionSamplingParams(sessionId);
  }).immediate();
}
Object.assign(module.exports, { getSessionSamplingParams, saveSessionSamplingParams });

function getRegenerationTarget(sessionId) {
  requireIdentifier(sessionId, 'sessionId');
  requireMutableSession(sessionId);
  const last = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
  if (!last || last.role !== 'assistant') throw new Error('The last message must be an assistant reply.');
  return last;
}

function setActiveVariant(sessionId, messageId, index) {
  requireIdentifier(sessionId, 'sessionId');
  if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(index)) throw new TypeError('Invalid variant selection.');
  return db.transaction(() => {
    requireMutableSession(sessionId);
    const row = db.prepare("SELECT * FROM messages WHERE session_id = ? AND id = ? AND role = 'assistant'").get(sessionId, messageId);
    if (!row) throw new Error('Assistant message not found.');
    const variants = parseVariants(row);
    if (index < 0 || index >= variants.length) throw new RangeError('Variant index out of range.');
    const variant = variants[index];
    const steps = Object.hasOwn(variant, 'thinking') || Object.hasOwn(variant, 'tool_calls') ? null : normalizeExecutionSteps(variant.executionSteps);
    db.prepare(`UPDATE messages SET content = ?, estimated_tokens = ?, active_variant_index = ?,
      stats = ?, thinking_text = ?, thinking_duration = ?, tool_calls = ?, model_name = ?, model_id = ?, agent_name = ? WHERE id = ?`)
      .run(variant.content, estimateTokens(variant.content), index,
        variant.stats ? JSON.stringify({ ...variant.stats, tokensPerSecond: variant.stats.tokens_per_sec,
          totalTokens: variant.stats.total_tokens, time: variant.stats.duration }) : null,
        variant.thinking ?? null, variant.thinking_duration ?? null, JSON.stringify(variant.tool_calls ?? []),
        variant.model_name ?? null, variant.model_id ?? null, variant.agent_name ?? null, messageId);
    db.prepare('UPDATE messages SET execution_steps = ? WHERE id = ?').run(steps === null ? null : JSON.stringify(steps), messageId);
    // A summary may contain the previously selected reply. Rebuild context from original turns.
    db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE messages SET archived = 0 WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
    return withAttachments([db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)])[0];
  }).immediate();
}

function appendReplyVariant(sessionId, target, variant) {
  if (!variant || typeof variant !== 'object') throw new TypeError('A reply metadata object is required.');
  estimateTokens(variant.content);
  return db.transaction(() => {
    const last = getRegenerationTarget(sessionId);
    if (last.id !== target.id || last.variants !== target.variants || last.content !== target.content) {
      throw new Error('The conversation changed during regeneration. Please try again.');
    }
    const variants = [...parseVariants(last), { ...variant, created_at: variant.created_at ?? new Date().toISOString() }];
    db.prepare('UPDATE messages SET variants = ? WHERE id = ?')
      .run(JSON.stringify(variants), last.id);
    return setActiveVariant(sessionId, last.id, variants.length - 1);
  }).immediate();
}

Object.assign(module.exports, { getRegenerationTarget, setActiveVariant, appendReplyVariant });
