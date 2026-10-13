'use strict';

// Durable sub-agent run history (SQLite `subagent_runs`, one row per child).
// The in-memory runtime stays authoritative while the app runs; this module
// mirrors terminal state to the database so past runs remain inspectable
// after restarts. Observability only: nothing here is ever read back by
// inference, search, or recall — the modal may read it later, nothing else.
//
// Writes happen exclusively from the session lifecycle settlements
// (complete/fail/cancel/interrupt in ./sessionManager.js), which every path —
// first runs, background runs, resumed continuation turns — funnels through.
// Persistence failures are swallowed (with one console error) so a database
// problem can never break or alter an execution.
const { listExecutions } = require('./executionStore');

const TURNS_CAP = 60;
const TURN_TEXT_CAP = 3000;

function previewTurnText(value) {
  const text = typeof value === 'string' ? value
    : value == null ? '' : JSON.stringify(value);
  if (text.length <= TURN_TEXT_CAP) return { text, truncated: false };
  return { text: text.slice(0, TURN_TEXT_CAP), truncated: true };
}

// Bounded turn shapes shared with the live transcript view (see ./index.js
// getChildTranscript): same caps, same fields, no duplication.
function mapContextTurns(context) {
  if (!Array.isArray(context)) return [];
  const turns = [];
  for (const message of context.slice(-TURNS_CAP)) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role !== 'assistant' && role !== 'tool' && role !== 'user' && role !== 'system') continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(call => {
      let args = call?.function?.arguments;
      if (typeof args !== 'string') {
        try { args = JSON.stringify(args ?? {}); } catch { args = '{}'; }
      }
      return { name: call?.function?.name ?? 'tool', arguments: previewTurnText(args) };
    }) : [];
    turns.push({ role, text: previewTurnText(message.content), toolCalls: calls });
  }
  return turns;
}

// Tools actually used, in first-use order with counts, from committed turns
// plus the live activity feed (one-shot runs commit no context but record
// file/fetch activity). No fabrication: unknown shapes become 'tool'.
function summarizeToolsUsed(session) {
  if (session?.budgetState?.toolsUsed) return [...session.budgetState.toolsUsed].map(([name, calls]) => ({ name, calls }));
  const counts = new Map();
  const note = (name) => {
    const key = typeof name === 'string' && name ? name : 'tool';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const turn of mapContextTurns(session?.context)) {
    for (const call of turn.toolCalls) note(call.name);
  }
  for (const event of Array.isArray(session?.activity) ? session.activity : []) {
    if (event?.type === 'tool') note(event.name);
    else if (event?.type === 'file') note(typeof event.path === 'string' && event.path ? `read:${event.path}` : 'read');
    else if (event?.type === 'fetch') note(typeof event.url === 'string' && event.url ? `fetch:${event.url}` : 'fetch');
  }
  return [...counts].map(([name, calls]) => ({ name, calls }));
}

// Compact input summary captured at spawn (see runInSession/startInBackground
// in ./index.js). Full task text is kept; the persist step falls back to the
// committed user turn when no summary was recorded (e.g. resumed sessions
// created before this field existed).
function summarizeRunInput(kind, options = {}) {
  if (kind === 'file-analysis') {
    const files = Array.isArray(options.target_files) ? options.target_files : [];
    return { task: typeof options.task_description === 'string' ? options.task_description : '',
      detail: files.length ? `target_files: ${files.join(', ')}` : '' };
  }
  if (kind === 'web-extraction') {
    return { task: typeof options.query === 'string' ? options.query : '',
      detail: typeof options.url === 'string' ? `url: ${options.url}` : '' };
  }
  return { task: typeof options.task === 'string' ? options.task : '', detail: '' };
}

function thoughtsText(session) {
  if (!Array.isArray(session?.activity)) return '';
  return session.activity
    .filter(event => event?.type === 'thought' && typeof event.text === 'string' && event.text.trim())
    .map(event => event.text)
    .join('\n\n');
}

function resolveAgentName(parentSessionId) {
  if (typeof parentSessionId !== 'string' || !parentSessionId) return null;
  try {
    return require('../agentManager').getSessionAgent(parentSessionId)?.name ?? null;
  } catch {
    return null;
  }
}

function persistChildRun(session) {
  try {
    if (!session || typeof session.id !== 'string' || !session.id) return false;
    const { db } = require('../db');
    const attempts = listExecutions(session.id);
    const latest = attempts[attempts.length - 1] ?? null;
    const summary = session.inputSummary != null && typeof session.inputSummary === 'object' ? session.inputSummary : {};
    let task = typeof summary.task === 'string' && summary.task ? summary.task : '';
    if (!task && Array.isArray(session.context)) {
      const firstUser = session.context.find(message => message?.role === 'user');
      task = typeof firstUser?.content === 'string' ? firstUser.content : '';
    }
    const detail = typeof summary.detail === 'string' && summary.detail ? `\n${summary.detail}` : '';
    const taskText = task + detail;
    const usage = session.usage != null && typeof session.usage === 'object' ? session.usage : null;
    const total = (!session.accounting || (session.accounting.inputCoverage === 'measured' && session.accounting.outputCoverage === 'measured'))
      && usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)
      ? usage.prompt_tokens + usage.completion_tokens : null;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO subagent_runs(child_session_id, parent_session_id, parent_tool_call_id, kind, agent_name,
        model, provider, status, task_text, output_text, error_text, thoughts_text, tools_json, turns_json,
        total_tokens, duration_ms, created_at, started_at, completed_at, updated_at, stop_reason, accounting_json, raw_turns_json, context_json, compaction_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(child_session_id) DO UPDATE SET
        status = excluded.status, output_text = excluded.output_text, error_text = excluded.error_text,
        thoughts_text = excluded.thoughts_text,
        tools_json = excluded.tools_json, turns_json = excluded.turns_json, total_tokens = excluded.total_tokens,
        duration_ms = excluded.duration_ms, completed_at = excluded.completed_at, updated_at = excluded.updated_at,
        stop_reason = excluded.stop_reason, accounting_json = excluded.accounting_json, raw_turns_json = excluded.raw_turns_json,
        context_json = excluded.context_json, compaction_json = excluded.compaction_json
    `).run(
      session.id,
      typeof session.parentSessionId === 'string' ? session.parentSessionId : null,
      typeof session.parentToolCallId === 'string' ? session.parentToolCallId : null,
      latest?.kind ?? null,
      resolveAgentName(session.parentSessionId),
      typeof session.model === 'string' ? session.model : null,
      typeof session.provider === 'string' ? session.provider : null,
      typeof session.status === 'string' ? session.status : 'unknown',
      taskText,
      typeof session.result === 'string' ? session.result : null,
      typeof session.error === 'string' ? session.error : null,
      thoughtsText(session),
      JSON.stringify(summarizeToolsUsed(session)),
      JSON.stringify(mapContextTurns(session.rawContext ?? session.context)),
      total,
      Number.isFinite(session.durationMs) ? session.durationMs : null,
      typeof session.createdAt === 'string' ? session.createdAt : null,
      typeof session.startedAt === 'string' ? session.startedAt : null,
      typeof session.completedAt === 'string' ? session.completedAt : null,
      now, session.stopReason ?? null, session.accounting ? JSON.stringify(session.accounting) : null,
      session.rawContext ? JSON.stringify(session.rawContext) : null,
      session.context ? JSON.stringify(session.context) : null,
      session.compactionState ? JSON.stringify(session.compactionState) : null,
    );
    return true;
  } catch (error) {
    // No initialized database (headless/test environments) means there is
    // nowhere to persist: skip silently. Genuine write failures are logged.
    if (String(error?.message ?? '').includes('Call initDatabase()')) return false;
    console.error('[subagents] persisting child run failed:', error?.message ?? error);
    return false;
  }
}

function readPersistedTranscript(childSessionId) {
  const { db } = require('../db');
  const row = db.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(childSessionId);
  if (!row) return { found: false };
  const parseArray = value => {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  };
  const turns = parseArray(row.turns_json);
  return {
    found: true, persisted: true, childSessionId: row.child_session_id,
    parentSessionId: row.parent_session_id, kind: row.kind, status: row.status,
    model: row.model, provider: row.provider, task: row.task_text,
    stopReason: row.stop_reason ?? null, accounting: row.accounting_json ? JSON.parse(row.accounting_json) : null,
    usage: null, totalTokens: row.total_tokens, durationMs: row.duration_ms,
    result: typeof row.output_text === 'string' ? previewTurnText(row.output_text) : null,
    activeTurns: mapContextTurns(parseArray(row.context_json)),
    compactions: row.compaction_json ? JSON.parse(row.compaction_json).events ?? [] : [],
    rawTurnCount: row.raw_turns_json ? parseArray(row.raw_turns_json).length : null,
    error: row.error_text, turns, turnCount: turns.filter(turn => turn.role === 'assistant').length,
    liveProgress: null, elapsedMs: row.duration_ms,
    activity: row.thoughts_text ? [{ type: 'thought', text: row.thoughts_text, t: row.completed_at ?? row.updated_at }] : [],
    toolsUsed: parseArray(row.tools_json),
  };
}

module.exports = { readPersistedTranscript, persistChildRun, summarizeRunInput, summarizeToolsUsed, mapContextTurns };
