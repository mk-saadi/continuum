'use strict';

const crypto = require('node:crypto');
const { searchMessages, searchTerms } = require('./messageSearch');

function validateFilter(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0'))
    throw new TypeError(`Invalid ${name}.`);
  return value;
}

function searchMemoryDatabase(connection, { query, modelId, target = 'all', projectId = null,
  cursor = null, order = 'newest', session_id, project_id, role, since, until,
  limit = 5, deadline = Date.now() + 30000 } = {}) {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.includes('\0'))
    throw new TypeError('modelId must be a non-empty string without null characters.');
  if (typeof query !== 'string' || query.includes('\0') || query.length > 512)
    throw new TypeError('query must be a string of at most 512 characters without null characters.');
  if (!['permanent', 'session', 'all'].includes(target)) throw new TypeError('target must be permanent, session, or all.');
  if (!['newest', 'oldest'].includes(order)) throw new TypeError('order must be newest or oldest.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new TypeError('limit must be between 1 and 5.');
  if (role != null && !['user', 'assistant', 'system'].includes(role)) throw new TypeError('Invalid role filter.');
  for (const [name, value] of Object.entries({ session_id, project_id, since, until })) validateFilter(value, name);
  for (const [name, value] of Object.entries({ since, until }))
    if (value != null && !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(value)) throw new TypeError(`Invalid ${name} date filter.`);
  const sinceTimestamp = since && (since.length === 10 ? `${since} 00:00:00` : since);
  const untilTimestamp = until && (until.length === 10 ? `${until} 23:59:59` : until);
  if (sinceTimestamp && untilTimestamp && sinceTimestamp > untilTimestamp) throw new TypeError('since must not be after until.');
  if (!searchTerms(query).length) {
    const sections = [];
    if (target !== 'session') sections.push('Facts found:\nNone.');
    if (target !== 'permanent') sections.push('Past Chat Context found:\nNone.');
    return { text: sections.join('\n\n'), partial: false, nextCursor: null,
      permanentMatches: [], chatMatches: [], timedOut: false };
  }

  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ query, modelId, target, projectId,
    order, session_id, project_id, role, since, until })).digest('hex').slice(0, 16);
  let state = { p: null, c: null, pd: false, cd: false };
  if (cursor != null) {
    if (typeof cursor !== 'string' || cursor.length > 512) throw new TypeError('Invalid search cursor.');
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.v !== 1 || parsed.f !== fingerprint ||
        ![parsed.p, parsed.c].every(id => id === null || Number.isSafeInteger(id) && id > 0) ||
        typeof parsed.pd !== 'boolean' || typeof parsed.cd !== 'boolean') throw new Error();
      state = { p: parsed.p, c: parsed.c, pd: parsed.pd, cd: parsed.cd };
    } catch { throw new TypeError('Invalid search cursor for this query and filters.'); }
  }

  const permanent = target === 'session' || state.pd ? { matches: [], partial: false, timedOut: false, searched: 0, cursor: null }
    : require('./memoryManager').searchPermanentPage(connection, query, modelId, {
      projectId, limit, cursor: state.p,
      deadline: target === 'all' ? Math.min(deadline, Date.now() + 10000) : deadline,
    });
  const chats = target === 'permanent' || state.cd ? { matches: [], partial: false, timedOut: false, searched: 0, cursor: null }
    : searchMessages(connection, query, { limit, cursor: state.c, deadline, order,
      sessionId: session_id, projectId: project_id, role, since: sinceTimestamp, until: untilTimestamp });
  const permanentDone = target === 'session' || state.pd || !permanent.partial;
  const chatDone = target === 'permanent' || state.cd || !chats.partial;
  const partial = !permanentDone || !chatDone;
  const nextCursor = partial ? Buffer.from(JSON.stringify({ v: 1, f: fingerprint,
    p: permanent.cursor, c: chats.cursor, pd: permanentDone, cd: chatDone })).toString('base64url') : null;
  const sections = [];
  if (target !== 'session') sections.push(`Facts found:\n${permanent.matches.map(({ category, content }) =>
    `- [${category}]: ${content}`).join('\n') || 'None.'}`);
  if (target !== 'permanent') sections.push(`Past Chat Context found:\n${chats.matches.map(row =>
    `[Session: ${row.session_id}] ${row.role}:\n${row.excerpt}\n[Message ID: ${row.id}; Timestamp: ${row.created_at}; Project: ${row.project_id ?? 'none'}; Parent: ${row.parent_id ?? 'none'}; Variant: ${row.variant_index}; Archived: ${Boolean(row.archived)}; Summarized: ${Boolean(row.is_summarized)}; Status: ${row.status}]`).join('\n\n') || 'None.'}`);
  if (partial) sections.push(`Search incomplete: checked ${permanent.searched} permanent memories and ${chats.searched} chat messages in this pass.${permanent.timedOut || chats.timedOut ? ' Time budget reached.' : ''}\nNext cursor: ${nextCursor}\nUse the same query and filters with this cursor to continue, or use order: "oldest" for a separate oldest-first search.`);
  return { text: sections.join('\n\n'), partial, nextCursor,
    permanentMatches: permanent.matches, chatMatches: chats.matches,
    timedOut: permanent.timedOut || chats.timedOut };
}

module.exports = { searchMemoryDatabase };
