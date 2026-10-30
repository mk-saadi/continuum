'use strict';
const { searchTerms } = require('./messageSearch');
function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without null characters.`);
  }
  return value;
}

function searchPermanentPage(connection, searchTerm, currentModelId, { projectId, limit = 5, cursor = null, deadline = Date.now() + 30000 } = {}) {
  requireText(searchTerm, 'searchTerm');
  requireText(currentModelId, 'currentModelId');
  if (projectId != null) requireText(projectId, 'projectId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new TypeError('Invalid memory search limit.');
  if (cursor != null && (!Number.isSafeInteger(cursor) || cursor <= 0)) throw new TypeError('Invalid memory search cursor.');
  const terms = searchTerms(searchTerm);
  if (!terms.length) return { matches: [], cursor: null, partial: false, timedOut: false, searched: 0 };
  const scopes = [...new Set(['global', currentModelId, projectId].filter(Boolean))];
  const placeholders = scopes.map(() => '?').join(', ');
  const statement = connection.prepare(`
    SELECT id, category, content, scope FROM permanent_memories
    WHERE id < ? AND is_active = 1 AND superseded_by IS NULL AND scope IN (${placeholders})
    ORDER BY id DESC
    LIMIT ?
  `);
  const matches = [];
  let lastId = cursor;
  let searched = 0;
  let exhausted = false;
  while (Date.now() < deadline && matches.length < limit) {
    const rows = statement.all(lastId ?? Number.MAX_SAFE_INTEGER, ...scopes, 128);
    if (!rows.length) { exhausted = true; break; }
    for (const row of rows) {
      lastId = row.id;
      searched++;
      const haystack = `${row.category} ${row.content}`.toLowerCase();
      if (terms.every(term => haystack.includes(term))) matches.push(row);
      if (matches.length >= limit || Date.now() >= deadline) break;
    }
    if (rows.length < 128 && matches.length < limit) { exhausted = true; break; }
  }
  const timedOut = Date.now() >= deadline && !exhausted && matches.length < limit;
  return { matches, cursor: exhausted ? null : lastId, partial: !exhausted, timedOut, searched };
}

module.exports = { searchPermanentPage };
