'use strict';

const { db } = require('./db.js');
const { normalizeMemoryContent } = require('./memoryNormalization');

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without null characters.`);
  }
  return value;
}

function requireId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Memory ID must be a positive safe integer.');
  }
  return value;
}

function getCoreMemories(currentModelId) {
  requireText(currentModelId, 'currentModelId');
  return db.prepare(`
    SELECT * FROM permanent_memories
    WHERE always_inject = 1 AND is_active = 1 AND superseded_by IS NULL
      AND (scope = 'global' OR scope = ?)
    ORDER BY id
  `).all(currentModelId);
}

function searchPermanentMemories(searchTerm, currentModelId) {
  requireText(currentModelId, 'currentModelId');
  if (typeof searchTerm !== 'string' || searchTerm.includes('\0')) {
    throw new TypeError('searchTerm must be a string without null characters.');
  }
  const term = searchTerm.trim();
  if (!/[\p{L}\p{N}\p{Co}]/u.test(term)) return [];

  // Quote the entire phrase so operators and punctuation remain literal.
  // The trailing wildcard applies to its final token.
  const query = `"${term.replace(/"/g, '""')}"*`;
  return db.prepare(`
    SELECT pm.*
    FROM memory_fts AS fts
    JOIN permanent_memories AS pm ON fts.rowid = pm.id
    WHERE memory_fts MATCH ?
      AND pm.is_active = 1 AND pm.superseded_by IS NULL
      AND (pm.scope = 'global' OR pm.scope = ?)
    ORDER BY bm25(memory_fts), pm.id
    LIMIT 5
  `).all(query, currentModelId);
}

function addPermanentMemory({ category, content, scope = 'global', alwaysInject = false } = {}) {
  requireText(category, 'category');
  content = normalizeMemoryContent(content);
  requireText(scope, 'scope');
  if (![true, false, 0, 1].includes(alwaysInject)) {
    throw new TypeError('alwaysInject must be a boolean or 0/1.');
  }

  return db.transaction(() => {
    const overlaps = searchPermanentMemories(content, scope)
      .filter((memory) => memory.category === category);
    const match = overlaps.find((memory) => memory.content === content && memory.scope === scope);
    if (match) return match.id;

    // Exact lookup also covers punctuation-only content and matches beyond the
    // five FTS results. Distinct scopes retain independent memory records.
    const existing = db.prepare(`
      SELECT id FROM permanent_memories
      WHERE category = ? AND content = ? AND scope = ?
        AND is_active = 1 AND superseded_by IS NULL
      ORDER BY id LIMIT 1
    `).get(category, content, scope);
    if (existing) return existing.id;

    return db.prepare(`
      INSERT INTO permanent_memories(category, content, scope, always_inject)
      VALUES (?, ?, ?, ?)
    `).run(category, content, scope, Number(alwaysInject)).lastInsertRowid;
  }).immediate();
}

function supersedeMemory(oldId, newCategory, newContent, scope = 'global') {
  requireId(oldId);
  requireText(newCategory, 'newCategory');
  newContent = normalizeMemoryContent(newContent);
  requireText(scope, 'scope');

  return db.transaction(() => {
    const oldMemory = db.prepare(`
      SELECT always_inject FROM permanent_memories
      WHERE id = ? AND is_active = 1 AND superseded_by IS NULL
    `).get(oldId);
    if (!oldMemory) throw new Error(`Active memory ${oldId} does not exist.`);

    const { lastInsertRowid: newMemoryId } = db.prepare(`
      INSERT INTO permanent_memories(category, content, scope, always_inject)
      VALUES (?, ?, ?, ?)
    `).run(newCategory, newContent, scope, oldMemory.always_inject);

    db.prepare(`
      UPDATE permanent_memories
      SET is_active = 0, superseded_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newMemoryId, oldId);
    return newMemoryId;
  }).immediate();
}

function getAllActiveMemories() {
  return db.prepare(`
    SELECT * FROM permanent_memories
    WHERE is_active = 1 AND superseded_by IS NULL
    ORDER BY created_at DESC, id DESC
  `).all();
}

function deleteMemory(id) {
  requireId(id);
  const result = db.prepare(`
    UPDATE permanent_memories
    SET is_active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND is_active = 1
  `).run(id);
  return result.changes > 0;
}

module.exports = {
  normalizeMemoryContent,
  getCoreMemories,
  searchPermanentMemories,
  addPermanentMemory,
  supersedeMemory,
  getAllActiveMemories,
  deleteMemory,
};
