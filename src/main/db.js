'use strict';

const { app } = require('electron');
const Database = require('better-sqlite3');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { searchMessages } = require('./messageSearch');
const { searchMemoryDatabase } = require('./memorySearchCore');

let database = null;

const SCHEMA = `
  -- Content-free deletion markers prevent stale renderer requests from reusing an ID.
  CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE IF NOT EXISTS background_commands (command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace TEXT NOT NULL, record TEXT NOT NULL);
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
    enabled_skills TEXT NOT NULL DEFAULT '[]',
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

  CREATE TABLE IF NOT EXISTS project_tool_rules (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    created_by_session TEXT,
    UNIQUE(project_id, rule_key)
  );
  CREATE TRIGGER IF NOT EXISTS project_tool_rules_cap BEFORE INSERT ON project_tool_rules
    WHEN (SELECT COUNT(*) FROM project_tool_rules WHERE project_id = NEW.project_id) >= 200
    BEGIN SELECT RAISE(ABORT, 'Project tool rule limit (200) reached.'); END;
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

  CREATE TRIGGER IF NOT EXISTS sessions_no_resurrection BEFORE INSERT ON sessions
    WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'Conversation was permanently deleted.'); END;
  CREATE TABLE IF NOT EXISTS token_usage (
    turn_id TEXT PRIMARY KEY,
    chat_id TEXT,
    project_id TEXT,
    timestamp TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens >= 0),
    completion_tokens INTEGER NOT NULL CHECK(completion_tokens >= 0),
    -- Nullable cache/derived counters: NULL means the provider did not report
    -- the field. A measured zero is stored as 0 and is distinct from NULL.
    uncached_input_tokens INTEGER CHECK(uncached_input_tokens IS NULL OR uncached_input_tokens >= 0),
    cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    cache_creation_tokens INTEGER CHECK(cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
    reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    visible_output_tokens INTEGER CHECK(visible_output_tokens IS NULL OR visible_output_tokens >= 0),
    input_source TEXT,
    cache_read_source TEXT,
    cache_write_source TEXT,
    cache_read_coverage TEXT,
    cache_write_coverage TEXT,
    usage_coverage TEXT,
    model_id TEXT,
    provider TEXT,
    -- Phase 2.0C-3 cost evidence. Every column is nullable: NULL means the
    -- turn's cost is unknown, never a fabricated zero. cost_completeness
    -- distinguishes a fully measured estimate from a subtotal, an unknown
    -- price, and a local model's "not applicable" (no cloud charge exists).
    cost_total REAL, cost_currency TEXT, cost_status TEXT, cost_completeness TEXT,
    cost_source TEXT, cost_version TEXT, cost_timestamp TEXT,
    cost_uncached_input REAL, cost_cache_read REAL, cost_cache_write REAL,
    cost_cache_write_1h REAL, cost_output REAL, cost_reasoning REAL,
    cost_cache_savings REAL, cost_provider_reported REAL, cost_breakdown TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(timestamp);
  CREATE INDEX IF NOT EXISTS idx_token_usage_project_time ON token_usage(project_id, timestamp);

  -- Sub-agent run history: one row per spawned child, upserted at every
  -- terminal settlement (complete/fail/cancel/interrupt), so resumed turns
  -- update the same row. Observability only: inputs, bounded outputs,
  -- thoughts, tools used, and run metadata. Never read back by inference.
  CREATE TABLE IF NOT EXISTS subagent_runs (
    child_session_id TEXT PRIMARY KEY,
    parent_session_id TEXT,
    parent_tool_call_id TEXT,
    kind TEXT,
    agent_name TEXT,
    model TEXT,
    provider TEXT,
    provider_id TEXT,
    status TEXT NOT NULL,
    stop_reason TEXT,
    cost_total REAL, cost_currency TEXT, cost_status TEXT, cost_completeness TEXT,
    cost_source TEXT, cost_version TEXT, cost_timestamp TEXT,
    cost_uncached_input REAL, cost_cache_read REAL, cost_cache_write REAL,
    cost_cache_write_1h REAL, cost_output REAL, cost_reasoning REAL,
    cost_cache_savings REAL, cost_provider_reported REAL, cost_breakdown TEXT,
    accounting_json TEXT,
    raw_turns_json TEXT,
    context_json TEXT,
    compaction_json TEXT,
    budget_json TEXT,
    continuation_json TEXT,
    attempt_count INTEGER,
    task_text TEXT,
    output_text TEXT,
    error_text TEXT,
    thoughts_text TEXT,
    tools_json TEXT NOT NULL DEFAULT '[]',
    turns_json TEXT NOT NULL DEFAULT '[]',
    total_tokens INTEGER,
    duration_ms INTEGER,
    created_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_session_id);
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);

  CREATE TABLE IF NOT EXISTS chat_folders (
    name TEXT PRIMARY KEY NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    parent_id INTEGER REFERENCES messages(id),
    variant_index INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    stats TEXT,
    tool_calls TEXT,
    thinking_text TEXT,
    thinking_duration REAL,
    model_name TEXT,
    model_id TEXT,
    agent_name TEXT,
    -- Phase 2.1: the main-agent run that produced this reply. Steering rows
    -- share this id, so delivered instructions can be shown with the reply
    -- without ever inserting them into the conversation transcript.
    run_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    is_summarized BOOLEAN NOT NULL DEFAULT 0 CHECK (is_summarized IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Rewinds affect only the prompt assembled for inference. These rows record
  -- when that happened; messages.execution_steps retains every original step.
  CREATE TABLE IF NOT EXISTS context_rewinds (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    start_turn_index INTEGER NOT NULL,
    end_turn_index INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_context_rewinds_session ON context_rewinds(session_id, id);

  -- Phase 2.1 live agent steering: one row per instruction targeting one
  -- active main-agent run. Deliberately separate from the messages table so a
  -- steering instruction can never be mistaken for a new conversation turn,
  -- inserted into the active branch, or replayed by ordinary prompt construction.
  -- claimed is an additive state: the row was selected for a request whose
  -- transport has not confirmed acceptance yet. Startup reconciliation turns
  -- any surviving queued/claimed row into undelivered (ambiguous, never lost).
  CREATE TABLE IF NOT EXISTS run_steering_messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    run_id TEXT NOT NULL,
    content TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'undelivered', 'cancelled')),
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    delivered_at TEXT,
    delivery_request_id TEXT,
    failure_reason TEXT,
    UNIQUE(session_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_steering_session ON run_steering_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_steering_run_state ON run_steering_messages(session_id, run_id, state);

  CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL DEFAULT 0
  );
  -- Covers per-message attachment reads (loadSession, transcript loads);
  -- without it every message pays a full table scan.
  CREATE INDEX IF NOT EXISTS idx_message_attachments_message
    ON message_attachments(message_id, id);

  DROP TABLE IF EXISTS checklist_state;

  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    summary_text TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Workspace task briefs: verbatim copies of Workspace user requirements,
  -- independent of the source message rows and the rolling summary. Rows are
  -- append-only; edits insert a revision row that supersedes (never updates)
  -- the prior row. message_id is SET NULL when the anchor message is deleted
  -- so the requirement text is retained for inspection while no longer
  -- applying to prompt construction (applicability follows the active path).
  CREATE TABLE IF NOT EXISTS workspace_task_briefs (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'instruction' CHECK (kind IN ('original', 'instruction', 'revision')),
    content_text TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    supersedes_id INTEGER REFERENCES workspace_task_briefs(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_task_briefs_session ON workspace_task_briefs(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_task_briefs_message ON workspace_task_briefs(message_id);

  -- C6-B host-authored lifecycle facts; never written by model classification.
  CREATE TABLE IF NOT EXISTS workspace_brief_lifecycle (
    brief_id INTEGER PRIMARY KEY REFERENCES workspace_task_briefs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('active','persistent','completed','superseded')),
    source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    dependencies_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_brief_lifecycle_session ON workspace_brief_lifecycle(session_id);

  -- Workspace turn digests: small deterministic work records built from a
  -- turn's persisted tool events (see src/main/turnDigest.js), attached to
  -- the user request that triggered the turn. digest_json carries the full
  -- versioned structured digest (source of truth; rendered text is derived).
  -- Rows are append-only per turn; rebuilding a turn upserts by
  -- (session_id, assistant_message_id), never duplicating. brief_id may be
  -- null for turns without an applicable brief. Assistant-message deletion
  -- cascades via the messages_digest_cascade trigger below; session
  -- deletion via the sessions trigger.
  CREATE TABLE IF NOT EXISTS workspace_turn_digests (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    assistant_message_id INTEGER NOT NULL REFERENCES messages(id),
    user_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    brief_id INTEGER REFERENCES workspace_task_briefs(id) ON DELETE SET NULL,
    turn_seq INTEGER NOT NULL,
    partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
    digest_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, assistant_message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_turn_digests_session ON workspace_turn_digests(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_turn_digests_brief ON workspace_turn_digests(brief_id);

  -- Workspace checkpoints: versioned, evidence-bound task state for resuming
  -- long coding tasks after compression. One row per compression that
  -- archived Workspace history; only the latest row per session has status
  -- 'current' (prior rows are 'superseded' but retained as audit history).
  -- Each row binds the history snapshot it was built from (active leaf,
  -- archived message ids, evidence fingerprint), the applicable task-brief
  -- identity, and the summary version/content it complements. Staleness is
  -- derived at read time by comparing these bindings to live state.
  CREATE TABLE IF NOT EXISTS workspace_checkpoints (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
    model_id TEXT,
    checkpoint_json TEXT NOT NULL,
    summary_id INTEGER REFERENCES session_summaries(id) ON DELETE SET NULL,
    summary_text TEXT NOT NULL DEFAULT '',
    brief_identity TEXT NOT NULL DEFAULT '',
    active_leaf_id INTEGER,
    archived_ids_json TEXT NOT NULL DEFAULT '[]',
    evidence_fingerprint TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON workspace_checkpoints(session_id, status, id);

  -- Workspace plans: one durable, session-owned plan per Workspace task, with
  -- ordered steps whose ids stay stable for the life of the plan. The plan
  -- records intended work and reported progress only; it is never evidence
  -- that a step succeeded. Every step write is scoped by session_id, so two
  -- tasks can never collide even if a model reuses a local step number.
  -- Compaction reads this state but never writes it.
  CREATE TABLE IF NOT EXISTS workspace_plans (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
    objective TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspace_plan_steps (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    position INTEGER NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_plan_steps_session ON workspace_plan_steps(session_id, position, id);

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
    connection.pragma('synchronous = FULL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    connection.transaction(() => {
      connection.exec(SCHEMA);
      // Remove only the retired chat search index. Message and permanent-memory
      // tables, the permanent-memory FTS index, and all other triggers remain.
      connection.exec(`DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS chat_fts;`);
      for (const column of ['stop_reason', 'accounting_json', 'raw_turns_json', 'context_json', 'compaction_json', 'budget_json', 'continuation_json']) {
        if (!connection.pragma('table_info(subagent_runs)').some(entry => entry.name === column)) {
          connection.exec(`ALTER TABLE subagent_runs ADD COLUMN ${column} TEXT`);
        }
      }
      if (!connection.pragma('table_info(subagent_runs)').some(entry => entry.name === 'attempt_count')) {
        connection.exec('ALTER TABLE subagent_runs ADD COLUMN attempt_count INTEGER');
      }
      // Cache-aware token history (Phase 2.0C-1). Additive only: legacy rows
      // keep NULL cache fields, which the history query labels unavailable
      // instead of backfilling a measured zero. No table rebuild or rewrite.
      const tokenUsageColumns = new Set(connection.pragma('table_info(token_usage)').map(column => column.name));
      for (const [name, type] of Object.entries({
        uncached_input_tokens: 'INTEGER', cache_read_tokens: 'INTEGER', cache_creation_tokens: 'INTEGER',
        reasoning_tokens: 'INTEGER', visible_output_tokens: 'INTEGER',
        input_source: 'TEXT', cache_read_source: 'TEXT', cache_write_source: 'TEXT',
        cache_read_coverage: 'TEXT', cache_write_coverage: 'TEXT', usage_coverage: 'TEXT',
        model_id: 'TEXT', provider: 'TEXT',
      })) {
        if (!tokenUsageColumns.has(name)) connection.exec(`ALTER TABLE token_usage ADD COLUMN ${name} ${type}`);
      }
      connection.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_model_time ON token_usage(model_id, timestamp)');
      // Phase 2.0D dashboard filters: provider/workspace filters are additive
      // read paths over the same table. Indexes only; no rows are rewritten.
      connection.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_provider_time ON token_usage(provider, timestamp)');
      connection.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_chat_time ON token_usage(chat_id, timestamp)');
      // Phase 2.0C-3 cloud cost evidence. Additive only: legacy rows keep NULL
      // cost columns, which the history labels unknown/unavailable instead of a
      // fabricated zero. Existing rows are never rewritten or recalculated.
      for (const [name, type] of Object.entries({
        cost_total: 'REAL', cost_currency: 'TEXT', cost_status: 'TEXT', cost_completeness: 'TEXT',
        cost_source: 'TEXT', cost_version: 'TEXT', cost_timestamp: 'TEXT',
        cost_uncached_input: 'REAL', cost_cache_read: 'REAL', cost_cache_write: 'REAL',
        cost_cache_write_1h: 'REAL', cost_output: 'REAL', cost_reasoning: 'REAL',
        cost_cache_savings: 'REAL', cost_provider_reported: 'REAL', cost_breakdown: 'TEXT',
      })) {
        if (!tokenUsageColumns.has(name)) connection.exec(`ALTER TABLE token_usage ADD COLUMN ${name} ${type}`);
      }
      const subagentColumns = new Set(connection.pragma('table_info(subagent_runs)').map(column => column.name));
      for (const [name, type] of Object.entries({
        provider_id: 'TEXT', cost_total: 'REAL', cost_currency: 'TEXT', cost_status: 'TEXT',
        cost_completeness: 'TEXT', cost_source: 'TEXT', cost_version: 'TEXT', cost_timestamp: 'TEXT',
        cost_uncached_input: 'REAL', cost_cache_read: 'REAL', cost_cache_write: 'REAL',
        cost_cache_write_1h: 'REAL', cost_output: 'REAL', cost_reasoning: 'REAL',
        cost_cache_savings: 'REAL', cost_provider_reported: 'REAL', cost_breakdown: 'TEXT',
      })) {
        if (!subagentColumns.has(name)) connection.exec(`ALTER TABLE subagent_runs ADD COLUMN ${name} ${type}`);
      }
      require('./sessionCosts').install(connection);
      connection.exec('CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_time ON subagent_runs(parent_session_id, completed_at)');
      connection.exec('CREATE INDEX IF NOT EXISTS idx_subagent_runs_completed_at ON subagent_runs(completed_at)');
      if (!connection.pragma('table_info(projects)').some(column => column.name === 'permission_mode')) {
        connection.exec("ALTER TABLE projects ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'workspace_write' CHECK (permission_mode IN ('read_only', 'workspace_write', 'ask_approval', 'full_access'))");
      }
      if (!connection.pragma('table_info(projects)').some(column => column.name === 'enabled_skills')) {
        connection.exec("ALTER TABLE projects ADD COLUMN enabled_skills TEXT NOT NULL DEFAULT '[]'");
      }
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
      if (!messageColumns.has('parent_id')) {
        connection.exec('ALTER TABLE messages ADD COLUMN parent_id INTEGER REFERENCES messages(id)');
        const previous = new Map();
        const link = connection.prepare('UPDATE messages SET parent_id = ? WHERE id = ?');
        for (const row of connection.prepare('SELECT id, session_id FROM messages ORDER BY id').all()) {
          link.run(previous.get(row.session_id) ?? null, row.id);
          previous.set(row.session_id, row.id);
        }
      }
      if (!messageColumns.has('variant_index')) connection.exec('ALTER TABLE messages ADD COLUMN variant_index INTEGER NOT NULL DEFAULT 0');
      if (!connection.pragma('table_info(sessions)').some(column => column.name === 'active_leaf_id'))
        connection.exec('ALTER TABLE sessions ADD COLUMN active_leaf_id INTEGER');
      connection.exec(`UPDATE sessions SET active_leaf_id =
        (SELECT MAX(id) FROM messages WHERE session_id = sessions.id)
        WHERE active_leaf_id IS NULL`);
      connection.exec('CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(session_id, parent_id, id)');
      if (!messageColumns.has('is_summarized')) {
        connection.exec('ALTER TABLE messages ADD COLUMN is_summarized BOOLEAN NOT NULL DEFAULT 0 CHECK (is_summarized IN (0, 1))');
        connection.exec('UPDATE messages SET is_summarized = 1 WHERE archived = 1');
      }
      // A process interruption must not leave a durable background-work lock.
      connection.exec('UPDATE sessions SET is_compressing = 0 WHERE is_compressing = 1');
      // Phase 2.1: no main-agent run survives a process restart. Pending
      // steering is retained for inspection but can never be attached to a
      // later, unrelated run, and an in-flight request is reported as
      // undelivered rather than falsely applied. The reason is intentionally
      // explicit about the ambiguity.
      connection.exec(`UPDATE run_steering_messages
        SET state = 'undelivered',
            failure_reason = 'The application closed before delivery could be confirmed.'
        WHERE state IN ('queued', 'claimed')`);
      for (const [name, type] of Object.entries({ execution_steps: 'TEXT', stats: 'TEXT', tool_calls: 'TEXT', thinking_text: 'TEXT', thinking_duration: 'REAL' })) {
        if (!messageColumns.has(name)) connection.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
      }
      // Additive association for Phase 2.1 follow-up: old replies simply have no
      // run id and therefore no additional-prompts footer.
      if (!messageColumns.has('run_id')) connection.exec('ALTER TABLE messages ADD COLUMN run_id TEXT');
      if (!messageColumns.has('variants')) connection.exec('ALTER TABLE messages ADD COLUMN variants TEXT');
      if (!messageColumns.has('active_variant_index')) connection.exec('ALTER TABLE messages ADD COLUMN active_variant_index INTEGER DEFAULT 0');
      // Legacy origins are unknown; never backfill them from the current model/agent.
      for (const name of ['model_name', 'model_id', 'agent_name', 'display_name']) {
        if (!messageColumns.has(name)) connection.exec(`ALTER TABLE messages ADD COLUMN ${name} TEXT`);
      }
      if (!messageColumns.has('status')) connection.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
      const interruptedIds = connection.prepare("SELECT id FROM messages WHERE status = 'in_progress'").all().map(row => row.id);
      connection.exec(`UPDATE messages SET status = 'interrupted',
        content = content || '\n\n*[Response interrupted by application restart]*'
        WHERE status = 'in_progress'`);
      const { parseVariants, variantFromRow } = require('./messageVariants');
      const migrateVariants = connection.prepare('UPDATE messages SET variants = ?, active_variant_index = ? WHERE id = ?');
      for (const row of connection.prepare('SELECT * FROM messages').all()) {
        const variants = parseVariants(row);
        const index = Number.isSafeInteger(row.active_variant_index) && row.active_variant_index >= 0 && row.active_variant_index < variants.length ? row.active_variant_index : 0;
        if (interruptedIds.includes(row.id)) {
          const steps = require('./executionSteps').readExecutionSteps(row).map(step =>
            step.type === 'tool_call' && ['preparing', 'pending', 'running'].includes(step.status)
              ? { ...step, status: 'error', error: 'Execution interrupted by application restart.' } : step);
          row.execution_steps = JSON.stringify(steps);
          connection.prepare('UPDATE messages SET execution_steps = ? WHERE id = ?').run(row.execution_steps, row.id);
          variants[index] = variantFromRow(row);
        }
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
      // The sessions trigger is rebuilt (not IF-NOT-EXISTS-kept) so existing
      // databases pick up task-brief cleanup on session deletion.
      connection.exec(`DROP TRIGGER IF EXISTS sessions_cascade;`);
      connection.exec(`
        CREATE TRIGGER IF NOT EXISTS sessions_cascade BEFORE DELETE ON sessions BEGIN
          INSERT OR IGNORE INTO deleted_sessions(id) VALUES (OLD.id);
          DELETE FROM background_commands WHERE session_id = OLD.id;
          DELETE FROM subagent_runs WHERE parent_session_id = OLD.id;
          DELETE FROM token_usage WHERE chat_id = OLD.id;
          DELETE FROM messages WHERE session_id = OLD.id;
          DELETE FROM session_summaries WHERE session_id = OLD.id;
          DELETE FROM workspace_task_briefs WHERE session_id = OLD.id;
          DELETE FROM workspace_checkpoints WHERE session_id = OLD.id;
          DELETE FROM workspace_turn_digests WHERE session_id = OLD.id;
          DELETE FROM workspace_plan_steps WHERE session_id = OLD.id;
          DELETE FROM workspace_plans WHERE session_id = OLD.id;
          DELETE FROM run_steering_messages WHERE session_id = OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS background_no_deleted_insert BEFORE INSERT ON background_commands
          WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE id = NEW.session_id)
          BEGIN SELECT RAISE(ABORT, 'Conversation was permanently deleted.'); END;
        CREATE TRIGGER IF NOT EXISTS child_no_deleted_insert BEFORE INSERT ON subagent_runs
          WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE id = NEW.parent_session_id)
          BEGIN SELECT RAISE(ABORT, 'Conversation was permanently deleted.'); END;
        CREATE TRIGGER IF NOT EXISTS child_no_deleted_update BEFORE UPDATE ON subagent_runs
          WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE id = NEW.parent_session_id)
          BEGIN SELECT RAISE(ABORT, 'Conversation was permanently deleted.'); END;
        CREATE TRIGGER IF NOT EXISTS usage_no_deleted_insert BEFORE INSERT ON token_usage
          WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE id = NEW.chat_id)
          BEGIN SELECT RAISE(ABORT, 'Conversation was permanently deleted.'); END;
        CREATE TRIGGER IF NOT EXISTS attachments_cascade BEFORE DELETE ON messages BEGIN
          DELETE FROM message_attachments WHERE message_id = OLD.id;
        END;
        -- Digest rows describe deleted turns: cascade them with the message
        -- so dead history can never inject into later prompts. Created
        -- unconditionally (like the triggers above) so existing databases
        -- pick it up on next open without a table rebuild. Rebuilt (not
        -- IF-NOT-EXISTS-kept) for the same reason as sessions_cascade.
        DROP TRIGGER IF EXISTS messages_digest_cascade;
        CREATE TRIGGER messages_digest_cascade BEFORE DELETE ON messages BEGIN
          DELETE FROM workspace_turn_digests WHERE assistant_message_id = OLD.id;
        END;
        CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_name, last_active_at DESC);
      `);
    })();
    require('./legacyDataMigration').repairLegacyAttachmentPaths(connection, directory);
    require('./workspaceCompactionActivity').install(connection);
    database = connection;
    require('./backgroundCommands').restore(connection);
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
  return searchMessages(db, searchQuery).matches.map(({ id, session_id, role, excerpt }) =>
    ({ id, session_id, role, excerpt }));
}

function searchMemory(query, modelId, target = 'all', projectId = null) {
  return searchMemoryDatabase(db, { query, modelId, target, projectId }).text;
}

function getDatabasePath() {
  return getConnection().name;
}

function recordContextRewind({ sessionId, messageId, startTurnIndex, endTurnIndex, summary }) {
  if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(messageId) ||
      !Number.isInteger(startTurnIndex) || startTurnIndex < 0 ||
      !Number.isInteger(endTurnIndex) || endTurnIndex <= startTurnIndex ||
      typeof summary !== 'string' || !summary.startsWith('[CONTEXT REWOUND]:')) {
    throw new TypeError('Invalid context rewind record.');
  }
  return db.prepare(`INSERT INTO context_rewinds
    (session_id, message_id, start_turn_index, end_turn_index, summary)
    VALUES (?, ?, ?, ?, ?)`).run(sessionId, messageId, startTurnIndex, endTurnIndex, summary).lastInsertRowid;
}

function branchUserMessage({ messageId, newContent }) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || typeof newContent !== 'string' ||
      !newContent.trim() || newContent.includes('\0')) throw new TypeError('Invalid message edit.');
  return db.transaction(() => {
    const target = db.prepare("SELECT * FROM messages WHERE id = ? AND role = 'user'").get(messageId);
    if (!target) throw new Error('User message not found.');
    const session = db.prepare('SELECT id, is_compressing FROM sessions WHERE id = ?').get(target.session_id);
    if (!session) throw new Error('Session not found.');
    if (session.is_compressing) throw new Error('History is being summarized. Please retry shortly.');
    const variantIndex = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = ?
      AND role = 'user' AND parent_id IS ?`).get(target.session_id, target.parent_id).count;
    const result = db.prepare(`INSERT INTO messages
      (session_id, parent_id, role, content, variant_index, estimated_tokens)
      VALUES (?, ?, 'user', ?, ?, ?)`).run(target.session_id, target.parent_id, newContent, variantIndex, Math.ceil(newContent.length / 4));
    const userMessageId = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO message_attachments(message_id, file_path, mime_type, estimated_tokens)
      SELECT ?, file_path, mime_type, estimated_tokens FROM message_attachments WHERE message_id = ?`)
      .run(userMessageId, messageId);
    db.prepare('UPDATE sessions SET active_leaf_id = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(userMessageId, target.session_id);
    // Preserve the correction verbatim alongside the message branch. The
    // prior brief row is retained; the new revision row supersedes it. This
    // runs in the same transaction so message + brief commit atomically.
    // Casual sessions return null and store nothing.
    require('./taskBriefs').captureRevisionBrief(target.session_id, userMessageId, newContent, messageId);
    return { userMessageId, sessionId: target.session_id };
  }).immediate();
}

module.exports = { isInitialized: () => Boolean(database?.open), db, initDatabase, syncSystemDate, closeDatabase, getDatabasePath, searchChatHistory, searchMemory, recordContextRewind, branchUserMessage };
