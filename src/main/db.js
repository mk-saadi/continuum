'use strict';

const { app } = require('electron');
const Database = require('better-sqlite3');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

let database = null;

const SCHEMA = `
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

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT,
    model_id TEXT,
    sampling_params TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_compressing INTEGER NOT NULL DEFAULT 0 CHECK (is_compressing IN (0, 1))
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
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
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
function initDatabase() {
  if (database?.open) return database;
  if (!app.isReady()) {
    throw new Error('initDatabase() must be called after app.whenReady().');
  }

  const directory = app.getPath('userData');
  mkdirSync(directory, { recursive: true });
  const connection = new Database(path.join(directory, 'memory_palace.db'));

  try {
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    connection.transaction(() => {
      connection.exec(SCHEMA);
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'agent_profile')) {
        connection.exec('ALTER TABLE sessions ADD COLUMN agent_profile TEXT');
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
      for (const [name, type] of Object.entries({ stats: 'TEXT', tool_calls: 'TEXT', thinking_text: 'TEXT', thinking_duration: 'REAL' })) {
        if (!messageColumns.has(name)) connection.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'sampling_params')) {
        connection.exec('ALTER TABLE sessions ADD COLUMN sampling_params TEXT');
      }
      if (!connection.pragma('table_info(sessions)').some((column) => column.name === 'folder_name')) {
        connection.exec("ALTER TABLE sessions ADD COLUMN folder_name TEXT NOT NULL DEFAULT 'Uncategorized'");
      }
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

module.exports = { db, initDatabase, closeDatabase };
