'use strict';

// A compact per-request ledger outlives transcript compaction and usage-history
// retention. Upserts replace cumulative snapshots rather than charging twice.
function install(connection) {
  connection.exec(`CREATE TABLE IF NOT EXISTS session_cost_entries (
    kind TEXT NOT NULL, turn_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    total REAL, billable INTEGER NOT NULL, partial INTEGER NOT NULL,
    PRIMARY KEY(kind, turn_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_cost_chat ON session_cost_entries(chat_id);`);
  for (const [table, kind, id, chat, local] of [
    ['token_usage', 'turn', 'turn_id', 'chat_id', "provider = 'local'"],
    ['subagent_runs', 'child', 'child_session_id', 'parent_session_id', "provider <> 'cloud'"],
  ]) {
    const values = prefix => `'${kind}', ${prefix}${id}, ${prefix}${chat}, ${prefix}cost_total,
      CASE WHEN ${prefix}${local} OR ${prefix}cost_completeness = 'not_applicable' THEN 0 ELSE 1 END,
      CASE WHEN ${prefix}cost_completeness = 'complete' THEN 0 ELSE 1 END`;
    connection.exec(`INSERT OR IGNORE INTO session_cost_entries
      SELECT ${values('')} FROM ${table} WHERE ${chat} IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS session_cost_${kind}_insert AFTER INSERT ON ${table}
      WHEN NEW.${chat} IS NOT NULL BEGIN
        INSERT INTO session_cost_entries VALUES (${values('NEW.')})
        ON CONFLICT(kind, turn_id) DO UPDATE SET total = COALESCE(excluded.total, total),
          billable = excluded.billable, partial = excluded.partial;
      END;
      CREATE TRIGGER IF NOT EXISTS session_cost_${kind}_update AFTER UPDATE ON ${table}
      WHEN NEW.${chat} IS NOT NULL BEGIN
        INSERT INTO session_cost_entries VALUES (${values('NEW.')})
        ON CONFLICT(kind, turn_id) DO UPDATE SET total = COALESCE(excluded.total, total),
          billable = excluded.billable, partial = excluded.partial;
      END;`);
  }
  connection.exec(`CREATE TRIGGER IF NOT EXISTS session_cost_delete AFTER DELETE ON sessions BEGIN
    DELETE FROM session_cost_entries WHERE chat_id = OLD.id;
  END;`);
}

function getSessionCost({ sessionId } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) throw new TypeError('Invalid session ID.');
  const { db } = require('./db');
  const row = db.prepare(`SELECT SUM(CASE WHEN billable = 1 THEN total END) AS total,
    COALESCE(SUM(CASE WHEN billable = 1 AND (total IS NULL OR partial = 1) THEN 1 ELSE 0 END), 0) AS unknownTurns
    FROM session_cost_entries WHERE chat_id = ?`).get(sessionId);
  return { total: row.total ?? (row.unknownTurns ? null : 0), partial: row.unknownTurns > 0, currency: 'USD' };
}

module.exports = { install, getSessionCost };
