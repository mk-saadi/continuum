'use strict';

const { app } = require('electron');
const Database = require('better-sqlite3');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

let database = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_rules (
    id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS permanent_memories (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    always_inject INTEGER NOT NULL DEFAULT 0 CHECK (always_inject IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    superseded_by INTEGER REFERENCES permanent_memories(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content, category, content='permanent_memories', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON permanent_memories BEGIN
    INSERT INTO memory_fts(rowid, content, category)
    VALUES (new.id, new.content, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON permanent_memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, category)
    VALUES ('delete', old.id, old.content, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON permanent_memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, category)
    VALUES ('delete', old.id, old.content, old.category);
    INSERT INTO memory_fts(rowid, content, category)
    VALUES (new.id, new.content, new.category);
  END;

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    avatar_url TEXT,
    model_id TEXT,
    sampling_params TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    custom_instructions TEXT,
    root_path TEXT UNIQUE,
    is_pinned INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT,
    file_name TEXT,
    content TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT,
    model_id TEXT,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    sampling_params TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_compressing INTEGER NOT NULL DEFAULT 0 CHECK (is_compressing IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    turn_id TEXT PRIMARY KEY,
    chat_id TEXT,
    project_id TEXT,
    timestamp TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens >= 0),
    completion_tokens INTEGER NOT NULL CHECK(completion_tokens >= 0)
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(timestamp);
  CREATE INDEX IF NOT EXISTS idx_token_usage_project_time ON token_usage(project_id, timestamp);

  CREATE TABLE IF NOT EXISTS chat_folders (
    name TEXT PRIMARY KEY NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    stats TEXT,
    tool_calls TEXT,
    thinking_text TEXT,
    thinking_duration REAL,
    model_name TEXT,
    model_id TEXT,
    agent_name TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    is_summarized BOOLEAN NOT NULL DEFAULT 0 CHECK (is_summarized IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    summary_text TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS document_chunks (
    id INTEGER PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(file_path, embedding_model, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS idx_document_chunks_scope ON document_chunks(file_path, embedding_model);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_load_configs (
    model_id TEXT PRIMARY KEY NOT NULL,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS model_configs (
    model_id TEXT PRIMARY KEY NOT NULL,
    context_window INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
    content, content='messages', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO chat_fts(chat_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO chat_fts(chat_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, created_at);
`;

/** Initialize after app.whenReady(); returns the shared database connection. */
function initDatabase(directory = require("./configStore").getConfig().appDataDirectory) {
  if (database?.open) return database;
  if (!app.isReady()) {
    throw new Error('initDatabase() must be called after app.whenReady().');
  }

  mkdirSync(directory, { recursive: true });
  const connection = new Database(path.join(directory, 'memory_palace.db'));

  try {
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    connection.transaction(() => {
      connection.exec(SCHEMA);
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'project_id')) {
        connection.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL');
      }
      connection.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)');
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'agent_profile')) {
        connection.exec('ALTER TABLE sessions ADD COLUMN agent_profile TEXT');
      }
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'memory_settings')) {
        connection.exec('ALTER TABLE sessions ADD COLUMN memory_settings TEXT');
      }
      // Seed once, so edited or deleted built-ins stay edited/deleted after restart.
      if (!connection.prepare("SELECT key FROM app_settings WHERE key = 'agents_seeded'").get()) {
        const insertAgent = connection.prepare('INSERT INTO agents(id, name, description, system_prompt, sampling_params) VALUES (?, ?, ?, ?, ?)');
        for (const agent of require('./agentDefaults')) {
          insertAgent.run(require('node:crypto').randomUUID(), agent.name, agent.description, agent.system_prompt,
            JSON.stringify({ temperature: agent.temperature, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 }));
        }
        connection.prepare("INSERT INTO app_settings(key, value_json) VALUES ('agents_seeded', 'true')").run();
      }
      const messageColumns = new Set(connection.pragma('table_info(messages)').map(column => column.name));
      if (!messageColumns.has('is_summarized')) {
        connection.exec('ALTER TABLE messages ADD COLUMN is_summarized BOOLEAN NOT NULL DEFAULT 0 CHECK (is_summarized IN (0, 1))');
        connection.exec('UPDATE messages SET is_summarized = 1 WHERE archived = 1');
      }
      // A process interruption must not leave a durable background-work lock.
      connection.exec('UPDATE sessions SET is_compressing = 0 WHERE is_compressing = 1');
      for (const [name, type] of Object.entries({ execution_steps: 'TEXT', stats: 'TEXT', tool_calls: 'TEXT', thinking_text: 'TEXT', thinking_duration: 'REAL' })) {
        if (!messageColumns.has(name)) connection.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      if (!messageColumns.has('variants')) connection.exec('ALTER TABLE messages ADD COLUMN variants TEXT');
      if (!messageColumns.has('active_variant_index')) connection.exec('ALTER TABLE messages ADD COLUMN active_variant_index INTEGER DEFAULT 0');
      // Metadata-only updates must not touch FTS (legacy rows may predate its index).
      connection.exec(`DROP TRIGGER IF EXISTS messages_au;
        CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages
        WHEN old.content IS NOT new.content BEGIN
          INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content);
        END;`);
      // Legacy origins are unknown; never backfill them from the current model/agent.
      for (const name of ['model_name', 'model_id', 'agent_name', 'display_name']) {
        if (!messageColumns.has(name)) connection.exec(`ALTER TABLE messages ADD COLUMN ${name} TEXT`);
      }
      const { parseVariants } = require('./messageVariants');
      const migrateVariants = connection.prepare('UPDATE messages SET variants = ?, active_variant_index = ? WHERE id = ?');
      for (const row of connection.prepare('SELECT * FROM messages').all()) {
        const variants = parseVariants(row);
        const index = Number.isSafeInteger(row.active_variant_index) && row.active_variant_index >= 0 && row.active_variant_index < variants.length ? row.active_variant_index : 0;
        const json = JSON.stringify(variants);
        if (json !== row.variants || index !== row.active_variant_index) migrateVariants.run(json, index, row.id);
      }
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'sampling_params')) {
        connection.exec('ALTER TABLE sessions ADD COLUMN sampling_params TEXT');
      }
      if (!connection.pragma('table_info(sessions)').some((column) => column.name === 'folder_name')) {
        connection.exec("ALTER TABLE sessions ADD COLUMN folder_name TEXT NOT NULL DEFAULT 'Uncategorized'");
      }
      connection.exec(`INSERT OR IGNORE INTO chat_folders(name)
        SELECT DISTINCT folder_name FROM sessions WHERE folder_name <> 'Uncategorized'`);
      // Triggers also support existing databases whose foreign keys lack ON DELETE CASCADE.
      connection.exec(`
        CREATE TRIGGER IF NOT EXISTS sessions_cascade BEFORE DELETE ON sessions BEGIN
          DELETE FROM messages WHERE session_id = OLD.id;
          DELETE FROM session_summaries WHERE session_id = OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS attachments_cascade BEFORE DELETE ON messages BEGIN
          DELETE FROM message_attachments WHERE message_id = OLD.id;
        END;
        CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_name, last_active_at DESC);
      `);
    })();
    database = connection;
    return database;
  } catch (error) {
    connection.close();
    throw error;
  }
}

function syncSystemDate(db) {
  const todayStr = `System Date: ${new Date().toISOString().split('T')[0]}`;
  db.prepare(`
    INSERT INTO project_rules (id, category, content, updated_at)
    VALUES ('system_date_anchor', 'temporal', ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
  `).run(todayStr);
}

/** Close even if checkpointing fails; repeated calls are safe. */
function closeDatabase() {
  if (!database?.open) {
    database = null;
    return;
  }

  const connection = database;
  try {
    connection.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    connection.close();
    database = null;
  }
}

// Stable facade supports destructured imports before initialization and reopening.
function getConnection() {
  if (!database?.open) {
    throw new Error('Call initDatabase() before accessing the database.');
  }
  return database;
}

const db = Object.freeze({
  prepare(sql) {
    return getConnection().prepare(sql);
  },
  transaction(callback) {
    return getConnection().transaction(callback);
  },
});

function searchChatHistory(searchQuery) {
  if (typeof searchQuery !== 'string' || searchQuery.includes('\0')) {
    throw new TypeError('query must be a string without null characters.');
  }
  const keywords = [...new Set(searchQuery.split(/\s+/)
    .map(word => word.replace(/[^\p{L}\p{N}\p{M}\p{Co}]/gu, ''))
    .filter(word => /[\p{L}\p{N}\p{Co}]/u.test(word)))];
  if (!keywords.length) return [];

  // Quote each sanitized token so words like OR remain literal, not operators.
  // Prefix matches may occur anywhere in the message, in any order.
  const query = keywords.map(word => `"${word}"*`).join(' AND ');
  return db.prepare(`
    SELECT messages.id, messages.session_id, messages.role,
      snippet(chat_fts, 0, '[MATCH]', '[/MATCH]', '...', 64) AS excerpt
    FROM chat_fts
    JOIN messages ON messages.id = chat_fts.rowid
    WHERE chat_fts MATCH ?
    ORDER BY chat_fts.rank, messages.id
    LIMIT 5
  `).all(query);
}

function searchMemory(query, modelId) {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.includes('\0')) {
    throw new TypeError('modelId must be a non-empty string without null characters.');
  }
  if (typeof query !== 'string' || query.includes('\0')) {
    throw new TypeError('query must be a string without null characters.');
  }
  const term = query.trim();
  const emptyResult = 'Facts found:\nNone.\n\nPast Chat Context found:\nNone.';
  if (!term) return emptyResult;

  return db.transaction(() => {
    // Escape LIKE wildcards so the user's keywords remain literal substrings.
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const facts = db.prepare(`
      SELECT category, content FROM permanent_memories
      WHERE (content LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
        AND is_active = 1 AND superseded_by IS NULL
        AND (scope = 'global' OR scope = ?)
      ORDER BY id
      LIMIT 5
    `).all(pattern, pattern, modelId);
    const chats = searchChatHistory(term);
    const factsText = facts.map(({ category, content }) => `- [${category}]: ${content}`).join('\n');
    const chatsText = chats.map(({ session_id, role, excerpt }) =>
      `[Session: ${session_id}] ${role}:\n${excerpt}`).join('\n\n');
    return `Facts found:\n${factsText || 'None.'}\n\nPast Chat Context found:\n${chatsText || 'None.'}`;
  })();
}

module.exports = { db, initDatabase, syncSystemDate, closeDatabase, searchChatHistory, searchMemory };
