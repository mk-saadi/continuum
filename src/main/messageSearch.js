'use strict';

// Search a bounded number of source rows at a time. The INTEGER PRIMARY KEY
// supports both directions without a second full-text copy of every message.
const BATCH_SIZE = 128;
const MAX_RESULTS = 5;

function searchTerms(query) {
  if (typeof query !== 'string' || query.includes('\0') || query.length > 512)
    throw new TypeError('query must be a string of at most 512 characters without null characters.');
  const terms = [...new Set((query.match(/[\p{L}\p{N}\p{M}\p{Co}_]+/gu) || []).map(word => word.toLowerCase()))];
  if (terms.length > 12) throw new TypeError('Use at most 12 search keywords.');
  return terms;
}

function excerpt(content, terms) {
  const lower = content.toLowerCase();
  const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0));
  const start = Math.max(0, first - 120);
  const end = Math.min(content.length, start + 1000);
  const raw = content.slice(start, end);
  const pattern = new RegExp(terms.slice().sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  return `${start ? '...' : ''}${raw.replace(pattern, match => `[MATCH]${match}[/MATCH]`)}${end < content.length ? '...' : ''}`;
}

function searchMessages(connection, query, options = {}) {
  const terms = searchTerms(query);
  const limit = options.limit ?? MAX_RESULTS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new TypeError('Invalid chat search limit.');
  const order = options.order ?? 'newest';
  if (!['newest', 'oldest'].includes(order)) throw new TypeError('Invalid chat search order.');
  const cursor = options.cursor ?? null;
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) throw new TypeError('Invalid chat search cursor.');
  const deadline = options.deadline ?? Date.now() + 30000;
  const matches = [];
  if (!terms.length) return { matches, cursor: null, partial: false, timedOut: false, searched: 0 };

  const descending = order === 'newest';
  const filters = ['m.id ' + (descending ? '<' : '>') + ' @cursor'];
  const params = { cursor: cursor ?? (descending ? Number.MAX_SAFE_INTEGER : 0), batchSize: BATCH_SIZE };
  if (options.projectId) { filters.push('s.project_id = @projectId'); params.projectId = options.projectId; }
  if (options.sessionId) { filters.push('m.session_id = @sessionId'); params.sessionId = options.sessionId; }
  if (options.role) { filters.push('m.role = @role'); params.role = options.role; }
  if (options.since) { filters.push('m.created_at >= @since'); params.since = options.since; }
  if (options.until) { filters.push('m.created_at <= @until'); params.until = options.until; }
  const statement = connection.prepare(`SELECT m.id, m.session_id, m.role, m.content, m.created_at,
      m.parent_id, m.variant_index, m.archived, m.is_summarized, m.status,
      s.project_id, s.title AS session_title
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE ${filters.join(' AND ')}
    ORDER BY m.id ${descending ? 'DESC' : 'ASC'} LIMIT @batchSize`);
  let lastId = cursor;
  let searched = 0;
  let exhausted = false;
  while (Date.now() < deadline && matches.length < limit) {
    let rowsSeen = 0;
    // iterate() avoids materializing 128 potentially large message bodies.
    for (const row of statement.iterate(params)) {
      rowsSeen++;
      lastId = row.id;
      searched++;
      const lower = row.content.toLowerCase();
      if (terms.every(term => lower.includes(term))) {
        matches.push({ id: row.id, session_id: row.session_id, role: row.role,
          excerpt: excerpt(row.content, terms), created_at: row.created_at,
          project_id: row.project_id, session_title: row.session_title,
          parent_id: row.parent_id, variant_index: row.variant_index,
          archived: row.archived, is_summarized: row.is_summarized, status: row.status });
      }
      if (matches.length >= limit || Date.now() >= deadline) break;
    }
    if (!rowsSeen) { exhausted = true; break; }
    params.cursor = lastId;
    if (rowsSeen < BATCH_SIZE && matches.length < limit && Date.now() < deadline) { exhausted = true; break; }
  }
  const timedOut = Date.now() >= deadline && !exhausted && matches.length < limit;
  return { matches, cursor: exhausted ? null : lastId, partial: !exhausted,
    timedOut, searched };
}

module.exports = { searchMessages, searchTerms };
