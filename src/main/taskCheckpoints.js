'use strict';

// Durable, versioned Workspace checkpoints: structured task state that lets an
// agent resume a long coding task after compression without relying on the
// rolling prose summary to remember progress.
//
// One row per Workspace compression that archived history; only the latest
// row per session is 'current' (prior rows are 'superseded' but retained).
// Each row binds the snapshot it was built from (active leaf, archived ids,
// evidence fingerprint), the applicable task-brief identity, and the summary
// version/content it complements. Staleness is DERIVED at read time by
// comparing those bindings to live state, so edits, branch switches, new
// instructions, deletions, and restarted runs all surface as stale rather
// than as unquestionably current.
//
// Evidence model: every verified completion claim must resolve to durable
// persisted execution_steps (see src/main/executionSteps.js). The outcome
// classifiers below mirror src/lib/executionEvents.mjs (which main-process
// CJS cannot require); verified outcomes, parsed output, inferred status,
// and unknowns are kept explicitly distinct. Running or interrupted
// operations are never reported as successfully completed. Nothing
// synthesizes timestamps, diffs, exit codes, test results, or subagent
// detail beyond what is durably recorded; the parent-side subagent result is
// used as-is.

const crypto = require('node:crypto');
const { db } = require('./db');
const { readExecutionSteps } = require('./executionSteps');
const briefs = require('./taskBriefs');

const CHECKPOINT_MARKER = '[WORKSPACE CHECKPOINT]';
const CHECKPOINT_END = '[END OF WORKSPACE CHECKPOINT]';
const CHECKPOINT_BYTE_CAP = 8000;
const CHECKPOINT_LLM_MAX_TOKENS = 2048;

const RUNNING_STATUSES = ['preparing', 'pending', 'running'];
const CANCELLED_RE = /(?:tool execution cancelled|execution interrupted|question cancelled|aborted|interrupt)/i;
const INTERRUPTED_RE = /interrupt/i;
const BLOCKED_RE = /(?:execution blocked|approval denied|permission denied|requires a project|read only mode|ask for approval|full access)/i;

const FILE_EDIT_TOOLS = new Set(['str_replace_editor', 'write_project_file', 'edit_project_files', 'apply_patch', 'move_project_file']);
const FILE_READ_TOOLS = new Set(['read_project_file', 'list_directory', 'search_project_content']);
const COMMAND_TOOLS = new Set(['execute_command']);
const SUBAGENT_TOOLS = new Set(['spawn_sub_agent', 'delegate_task', 'extract_web_page_data']);

const ARRAY_KEYS = ['outstandingRequirements', 'decisions', 'completedWork', 'inProgress',
  'filesChanged', 'commands', 'tests', 'blockers', 'risks', 'unknowns', 'nextActions'];
const ARRAY_CAPS = {
  outstandingRequirements: 50, decisions: 12, completedWork: 15, inProgress: 12,
  filesChanged: 20, commands: 20, tests: 20, blockers: 10, risks: 10, unknowns: 20, nextActions: 12,
};
// Model-invented metadata keys are stripped, never trusted.
const UNTRUSTED_KEYS = ['timestamp', 'timestamps', 'createdAt', 'startedAt', 'endedAt',
  'durationMs', 'duration', 'elapsed', 'elapsedMs', 'diff', 'diffText', 'patch'];

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) {
    throw new TypeError('sessionId must be a non-empty string without null characters.');
  }
}

function isWorkspaceSession(sessionId) {
  return briefs.isWorkspaceSession(sessionId);
}

function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

function truncateText(text, limit) {
  if (typeof text !== 'string') return '';
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

// --- Evidence classification (mirror of executionEvents.mjs rules) ---

function stepErrorText(step) {
  if (!step || typeof step !== 'object') return '';
  const direct = typeof step.error === 'string' ? step.error : '';
  const nested = step.result && typeof step.result === 'object' && !Array.isArray(step.result)
    && typeof step.result.error === 'string' ? step.result.error : '';
  return direct || nested;
}

function resultIndicatesFailure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.isError === true || result.success === false) return true;
  if (typeof result.error === 'string' && result.error.trim()) return true;
  return false;
}

// Outcome of one persisted tool step: success | failed | blocked | cancelled
// (includes interrupted) | running. Anything unrecognized is failed-safe
// (never success).
function classifyStepOutcome(step) {
  if (!step || step.type !== 'tool_call') return 'unknown';
  if (RUNNING_STATUSES.includes(step.status)) return 'running';
  const errText = stepErrorText(step);
  if (CANCELLED_RE.test(errText)) return 'cancelled';
  if (BLOCKED_RE.test(errText)) return 'blocked';
  if (step.status === 'error' || resultIndicatesFailure(step.result)) return 'failed';
  if (step.status === 'complete') {
    // A nonzero shell exit is an outcome failure even when the tool call
    // itself completed (mirrors engineManager.failedToolReason).
    const result = step.result;
    if (result && typeof result === 'object' && !Array.isArray(result)
      && typeof result.exitCode === 'number' && result.exitCode !== 0) return 'failed';
    return 'success';
  }
  return 'failed';
}

function argPaths(args) {
  if (!args || typeof args !== 'object') return [];
  const candidates = [args.relative_path, args.path, args.file_path, args.filePath, args.cwd];
  const files = Array.isArray(args.target_files) ? args.target_files.filter(file => typeof file === 'string') : [];
  return [...candidates.filter(value => typeof value === 'string' && value), ...files].slice(0, 4);
}

function commandOutcomeOf(step) {
  const result = step?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const out = {};
  if (typeof result.exitCode === 'number') out.exitCode = result.exitCode;
  if (typeof result.stdout === 'string') out.stdout = result.stdout;
  if (typeof result.stderr === 'string') out.stderr = result.stderr;
  return Object.keys(out).length ? out : null;
}

// Best-effort test counts parsed from recorded command output. Null when
// nothing recognizable is present; callers must label counts as parsed.
function parseTestCounts(text) {
  if (typeof text !== 'string' || !text) return null;
  const passed = /(\d+)\s+passed\b/i.exec(text);
  const failed = /(\d+)\s+failed\b/i.exec(text);
  const total = /(\d+)\s+tests?\b/i.exec(text);
  if (!passed && !failed && !total) return null;
  return {
    passed: passed ? Number(passed[1]) : null,
    failed: failed ? Number(failed[1]) : null,
    total: total ? Number(total[1]) : null,
  };
}

function stepKind(toolName) {
  if (FILE_EDIT_TOOLS.has(toolName)) return 'file-edit';
  if (FILE_READ_TOOLS.has(toolName)) return 'file-read';
  if (COMMAND_TOOLS.has(toolName)) return 'command';
  if (SUBAGENT_TOOLS.has(toolName)) return 'subagent';
  if (toolName === 'ask_user') return 'question';
  if (toolName === 'propose_skill') return 'skill';
  return 'other';
}

function outputTextOf(step) {
  const outcome = commandOutcomeOf(step);
  if (outcome) return [outcome.stdout, outcome.stderr].filter(s => typeof s === 'string').join('\n');
  if (typeof step.result === 'string') return step.result;
  try {
    const json = JSON.stringify(step.result ?? null);
    return json && json !== 'null' ? json : '';
  } catch {
    return '';
  }
}

// Deterministic evidence records for a set of messages (normally the
// archival candidates). No prose is generated here; the model drafts text
// and the validator binds every verified claim back to these records.
function collectEvidence(messages) {
  const records = [];
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    let steps = [];
    try {
      steps = readExecutionSteps(message) || [];
    } catch {
      steps = [];
    }
    for (const step of steps) {
      if (!step || step.type !== 'tool_call') continue;
      const toolName = typeof step.toolName === 'string' && step.toolName ? step.toolName : 'Tool';
      const outcome = classifyStepOutcome(step);
      const record = {
        messageId: message.id,
        stepId: step.id ?? null,
        toolName,
        kind: stepKind(toolName),
        outcome,
        paths: argPaths(step.args),
      };
      if (record.kind === 'command') {
        const outcomeData = commandOutcomeOf(step);
        record.exitCode = outcomeData && typeof outcomeData.exitCode === 'number' ? outcomeData.exitCode : null;
        record.outputText = truncateText(outputTextOf(step), 2000);
      } else if (record.kind === 'subagent' || record.kind === 'question' || record.kind === 'skill') {
        record.resultSnippet = truncateText(outputTextOf(step), 500);
      } else if (outcome !== 'success') {
        record.errorText = truncateText(stepErrorText(step), 300);
      }
      records.push(record);
    }
  }
  return records;
}

function evidenceIndex(records) {
  const map = new Map();
  for (const record of records) {
    if (record.stepId == null) continue;
    map.set(`${record.messageId}:${record.stepId}`, record);
  }
  return map;
}

// Fingerprint binding the exact execution evidence a checkpoint was built
// from. Any insert, delete, token-count change, or step mutation changes it;
// the commit compares snapshot vs live values. (Same-length content rewrites
// of archived rows are a negligible blind spot: every real mutation path
// moves the leaf, clears the summary, changes briefs, or alters tokens.)
function computeEvidenceFingerprint(messages) {
  const normalized = (messages ?? []).map(message => {
    let steps = [];
    try {
      steps = readExecutionSteps(message) || [];
    } catch {
      steps = [];
    }
    return { id: message.id, estimated_tokens: message.estimated_tokens ?? null, steps };
  });
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// --- Checkpoint input rendering for the model (deterministic, capped) ---

function renderEvidenceForModel(messages, charCap = 12000) {
  const proseBlocks = [];
  const stepLines = [];
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      proseBlocks.push({ id: message.id, text: `user msg ${message.id}: ${truncateText(message.content, 400)}` });
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (message.content && String(message.content).trim()) {
      proseBlocks.push({ id: message.id, text: `assistant msg ${message.id}: ${truncateText(String(message.content), 400)}` });
    }
    let steps = [];
    try {
      steps = readExecutionSteps(message) || [];
    } catch {
      steps = [];
    }
    for (const step of steps) {
      if (!step || step.type !== 'tool_call') continue;
      const toolName = step.toolName || 'Tool';
      const outcome = classifyStepOutcome(step);
      let detail = '';
      if (stepKind(toolName) === 'command') {
        const outcomeData = commandOutcomeOf(step);
        detail = outcomeData && typeof outcomeData.exitCode === 'number' ? `exit=${outcomeData.exitCode}` : 'exit=?';
        const paths = argPaths(step.args);
        if (paths.length) detail += ` ${paths.join(',')}`;
        if (typeof step.args?.command === 'string') detail += ` $ ${truncateText(step.args.command, 100)}`;
      } else {
        const paths = argPaths(step.args);
        detail = paths.length ? paths.join(',') : truncateText(outputTextOf(step), 120);
      }
      stepLines.push({ id: message.id, text: `msg ${message.id} step ${step.id ?? '?'} ${toolName} ${outcome}${detail ? ` ${detail}` : ''}`.slice(0, 220) });
    }
  }
  // Newest evidence first; drop oldest prose, then oldest step lines, with an
  // explicit omission note (never silent).
  const lines = [];
  let used = 0;
  let stepOmitted = 0;
  for (let i = stepLines.length - 1; i >= 0; i--) {
    const text = stepLines[i].text;
    if (used + text.length + 1 > charCap) {
      stepOmitted++;
      continue;
    }
    lines.unshift(text);
    used += text.length + 1;
  }
  if (stepOmitted > 0) {
    lines.unshift(`[…${stepOmitted} older step(s) omitted for size; full history retained in storage…]`);
  }
  let proseOmitted = 0;
  for (let i = proseBlocks.length - 1; i >= 0; i--) {
    const text = proseBlocks[i].text;
    if (used + text.length + 1 > charCap) {
      proseOmitted++;
      continue;
    }
    lines.push(text);
    used += text.length + 1;
  }
  if (proseOmitted > 0) lines.push(`[…${proseOmitted} older message(s) omitted for size; see rolling summary…]`);
  return lines.join('\n');
}

function renderPriorCheckpointForModel(row) {
  if (!row) return 'none yet';
  let parsed = null;
  try {
    parsed = JSON.parse(row.checkpoint_json);
  } catch {
    return `v${row.id} (unparseable; do not rely on it)`;
  }
  const keep = {};
  for (const key of ['objective', 'outstandingRequirements', 'decisions', 'completedWork', 'inProgress',
    'filesChanged', 'commands', 'tests', 'blockers', 'nextActions']) {
    if (parsed[key] !== undefined) keep[key] = parsed[key];
  }
  return `v${row.id}:\n${truncateText(JSON.stringify(keep), 4000)}`;
}

function buildCheckpointInput({ sessionId, candidates, newSummary }) {
  requireSessionId(sessionId);
  const applicable = briefs.getApplicableBriefs(sessionId);
  const prior = getLatestCheckpoint(sessionId);
  return {
    briefs: applicable.map(brief => ({ id: brief.id, kind: brief.kind, text: brief.content_text })),
    priorCheckpoint: prior ? renderPriorCheckpointForModel(prior) : 'none yet',
    rollingSummary: newSummary ?? null,
    evidence: renderEvidenceForModel(candidates),
    archivedCount: candidates.length,
  };
}

// --- Validation (main process, before persistence) ---

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, limit) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function stripUntrusted(entry, repaired, label) {
  if (!isPlainObject(entry)) return entry;
  for (const key of UNTRUSTED_KEYS) {
    if (entry[key] !== undefined) {
      delete entry[key];
      repaired.push(`${label}: dropped untrusted '${key}'`);
    }
  }
  return entry;
}

function messageExists(sessionId, messageId) {
  if (!Number.isSafeInteger(messageId)) return false;
  return !!db.prepare('SELECT id FROM messages WHERE id = ? AND session_id = ?').get(messageId, sessionId);
}

function coerceStatus(value) {
  return value === 'open' || value === 'done' || value === 'unknown' ? value : 'open';
}

// Validate a model-drafted checkpoint. Repairable problems (unresolvable
// sources, oversized text, missing brief coverage) are repaired with notes;
// structural failures return ok:false and the candidate must not commit.
// ctx: { sessionId, briefs, index (evidence Map), byteCap }.
function validateCheckpoint(draft, ctx) {
  const errors = [];
  const repaired = [];
  const briefsList = ctx?.briefs ?? [];
  const index = ctx?.index ?? new Map();
  const byteCap = ctx?.byteCap ?? CHECKPOINT_BYTE_CAP;
  if (!isPlainObject(draft)) return { ok: false, checkpoint: null, errors: ['checkpoint must be a JSON object'], repaired };

  const out = {};
  for (const key of ARRAY_KEYS) {
    if (draft[key] === undefined) {
      out[key] = [];
      continue;
    }
    if (!Array.isArray(draft[key])) {
      errors.push(`'${key}' must be an array`);
      return { ok: false, checkpoint: null, errors, repaired };
    }
    out[key] = draft[key];
  }

  const objective = cleanString(draft.objective, 1000);
  if (!objective) {
    errors.push('objective must be a non-empty string');
    return { ok: false, checkpoint: null, errors, repaired };
  }
  out.objective = objective;

  // Outstanding requirements: every applicable brief id must be present, with
  // its full text. Missing briefs are appended as open (repair, never loss).
  const covered = new Set();
  out.outstandingRequirements = out.outstandingRequirements.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`outstandingRequirements[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `outstandingRequirements[${i}]`);
    const briefId = Number.isSafeInteger(entry.briefId) ? entry.briefId : null;
    // Known briefs are quoted verbatim and in full: the brief record is
    // authoritative and requirement detail must never be truncated away.
    // Only free-text entries (no brief anchor) take the length cap.
    const brief = briefId != null ? briefsList.find(item => item.id === briefId) : null;
    const briefText = brief && typeof brief.content_text === 'string' && brief.content_text ? brief.content_text : null;
    let text = null;
    if (briefText) {
      text = briefText;
      if (typeof entry.text === 'string' && entry.text.trim() && entry.text !== briefText) {
        repaired.push(`outstandingRequirements[${i}]: replaced paraphrase with verbatim brief #${briefId}`);
      }
    } else {
      text = cleanString(entry.text, 4000);
    }
    if (!text) {
      repaired.push(`outstandingRequirements[${i}]: dropped empty entry`);
      return [];
    }
    if (briefId != null) covered.add(briefId);
    return [{ text, briefId, status: coerceStatus(entry.status) }];
  });
  for (const brief of briefsList) {
    if (!covered.has(brief.id)) {
      out.outstandingRequirements.push({ text: brief.content_text, briefId: brief.id, status: 'open' });
      repaired.push(`outstandingRequirements: appended missing brief #${brief.id} as open`);
    }
  }

  const resolveStep = (source) => {
    if (!isPlainObject(source) || !Number.isSafeInteger(source.messageId)) return null;
    if (source.stepId == null) return null;
    return index.get(`${source.messageId}:${source.stepId}`) ?? null;
  };
  const demote = (text, reason) => {
    out.unknowns.push(`${text} (unverified: ${reason})`);
    repaired.push(`demoted to unknowns: ${reason}`);
  };

  out.decisions = out.decisions.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`decisions[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `decisions[${i}]`);
    const text = cleanString(entry.text, 500);
    if (!text) {
      repaired.push(`decisions[${i}]: dropped empty entry`);
      return [];
    }
    const rationale = cleanString(entry.rationale, 500);
    let verified = entry.verified === true;
    const sources = [];
    for (const source of Array.isArray(entry.sources) ? entry.sources : []) {
      if (resolveStep(source)) sources.push({ messageId: source.messageId, stepId: source.stepId });
      else if (isPlainObject(source) && Number.isSafeInteger(source.messageId) && source.stepId == null
        && (ctx.messageExists ? ctx.messageExists(source.messageId) : messageExists(ctx.sessionId, source.messageId))) {
        sources.push({ messageId: source.messageId, stepId: null });
      } else {
        repaired.push(`decisions[${i}]: dropped unresolvable source`);
      }
    }
    if (verified && sources.length === 0) {
      verified = false;
      repaired.push(`decisions[${i}]: marked unverified (no resolvable source)`);
    }
    return [{ text, rationale, verified, sources }];
  });

  // Completed work is always verified: entries without a resolvable
  // successful step are demoted to unknowns, never kept as verified.
  out.completedWork = out.completedWork.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`completedWork[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `completedWork[${i}]`);
    const text = cleanString(entry.text, 500);
    if (!text) {
      repaired.push(`completedWork[${i}]: dropped empty entry`);
      return [];
    }
    const sources = [];
    for (const source of Array.isArray(entry.sources) ? entry.sources : []) {
      const record = resolveStep(source);
      if (record && record.outcome === 'success') sources.push({ messageId: source.messageId, stepId: source.stepId });
      else repaired.push(`completedWork[${i}]: dropped source without successful evidence`);
    }
    if (!sources.length) {
      demote(text, 'completedWork claim without resolvable successful evidence');
      return [];
    }
    return [{ text, sources }];
  });

  out.inProgress = out.inProgress.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`inProgress[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `inProgress[${i}]`);
    const text = cleanString(entry.text, 500);
    if (!text) {
      repaired.push(`inProgress[${i}]: dropped empty entry`);
      return [];
    }
    const status = typeof entry.status === 'string' && /^(running|interrupted|cancelled|blocked|paused|unknown)$/.test(entry.status)
      ? entry.status : 'unknown';
    let stepRef = null;
    if (isPlainObject(entry.stepRef) && Number.isSafeInteger(entry.stepRef.messageId) && entry.stepRef.stepId != null) {
      const record = index.get(`${entry.stepRef.messageId}:${entry.stepRef.stepId}`);
      if (record) {
        if (record.outcome === 'success') {
          repaired.push(`inProgress[${i}]: dropped stepRef to a completed step`);
        } else {
          stepRef = { messageId: entry.stepRef.messageId, stepId: entry.stepRef.stepId };
        }
      } else {
        repaired.push(`inProgress[${i}]: dropped unresolvable stepRef`);
      }
    }
    return [{ text, status, stepRef }];
  });

  const pathInArgs = (record, entryPath) => {
    if (typeof entryPath !== 'string' || !entryPath) return false;
    const argsJson = (() => {
      try {
        return JSON.stringify(record.args ?? null);
      } catch {
        return '';
      }
    })();
    return record.paths.includes(entryPath) || (argsJson && argsJson.includes(entryPath));
  };

  out.filesChanged = out.filesChanged.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`filesChanged[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `filesChanged[${i}]`);
    const entryPath = cleanString(entry.path, 500);
    if (!entryPath) {
      repaired.push(`filesChanged[${i}]: dropped entry without path`);
      return [];
    }
    const nature = entry.nature === 'created' || entry.nature === 'edited' || entry.nature === 'deleted' || entry.nature === 'read'
      ? entry.nature : null;
    let verified = false;
    let stepRef = null;
    if (isPlainObject(entry.stepRef) && entry.stepRef.stepId != null) {
      const record = index.get(`${entry.stepRef.messageId}:${entry.stepRef.stepId}`);
      if (record && record.outcome === 'success'
        && (record.kind === 'file-edit' || record.kind === 'file-read')
        && pathInArgs(record, entryPath)) {
        verified = true;
        stepRef = { messageId: entry.stepRef.messageId, stepId: entry.stepRef.stepId };
      } else {
        repaired.push(`filesChanged[${i}]: marked unverified (no matching successful file step)`);
      }
    } else if (entry.verified === true) {
      repaired.push(`filesChanged[${i}]: marked unverified (no step reference)`);
    }
    return [{ path: entryPath, nature, verified, stepRef }];
  });

  out.commands = out.commands.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`commands[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `commands[${i}]`);
    const command = cleanString(entry.command, 500);
    if (!command) {
      repaired.push(`commands[${i}]: dropped entry without command`);
      return [];
    }
    // Exit codes come from durable evidence only; model numbers are ignored.
    let exitCode = null;
    let verified = false;
    let stepRef = null;
    if (isPlainObject(entry.stepRef) && entry.stepRef.stepId != null) {
      const record = index.get(`${entry.stepRef.messageId}:${entry.stepRef.stepId}`);
      if (record && record.kind === 'command') {
        stepRef = { messageId: entry.stepRef.messageId, stepId: entry.stepRef.stepId };
        if (record.outcome === 'success' && typeof record.exitCode === 'number') {
          exitCode = record.exitCode;
          verified = true;
        } else if (typeof record.exitCode === 'number') {
          exitCode = record.exitCode;
          repaired.push(`commands[${i}]: recorded failing exit code ${exitCode}, not verified as success`);
        } else {
          repaired.push(`commands[${i}]: no recorded exit code, not verified`);
        }
      } else {
        repaired.push(`commands[${i}]: stepRef does not resolve to a command step`);
      }
    } else {
      repaired.push(`commands[${i}]: no step reference, not verified`);
    }
    return [{ command, exitCode, verified, stepRef }];
  });

  out.tests = out.tests.flatMap((entry, i) => {
    if (!isPlainObject(entry)) {
      repaired.push(`tests[${i}]: dropped non-object entry`);
      return [];
    }
    stripUntrusted(entry, repaired, `tests[${i}]`);
    const command = cleanString(entry.command, 500);
    let stepRef = null;
    let record = null;
    if (isPlainObject(entry.stepRef) && entry.stepRef.stepId != null) {
      const candidate = index.get(`${entry.stepRef.messageId}:${entry.stepRef.stepId}`);
      if (candidate && candidate.kind === 'command') {
        record = candidate;
        stepRef = { messageId: entry.stepRef.messageId, stepId: entry.stepRef.stepId };
      } else {
        repaired.push(`tests[${i}]: stepRef does not resolve to a command step`);
      }
    }
    if (!command && !record) {
      repaired.push(`tests[${i}]: dropped entry without command or evidence`);
      return [];
    }
    // Counts are recomputed from recorded output; model numbers are only
    // kept when they agree exactly, and always labeled as parsed.
    const parsed = record ? parseTestCounts(record.outputText ?? '') : null;
    let passed = null;
    let failed = null;
    let total = null;
    let parsedAs = null;
    if (parsed) {
      passed = parsed.passed;
      failed = parsed.failed;
      total = parsed.total;
      parsedAs = 'regex';
      const matches = (key) => entry[key] === undefined || entry[key] === null || entry[key] === parsed[key];
      if (!matches('passed') || !matches('failed') || !matches('total')) {
        repaired.push(`tests[${i}]: replaced model counts with parsed output`);
      }
    } else if (entry.passed != null || entry.failed != null || entry.total != null) {
      repaired.push(`tests[${i}]: dropped model counts without parseable output`);
    }
    const exitCode = record && typeof record.exitCode === 'number' ? record.exitCode : null;
    const verified = exitCode !== null && record.outcome === 'success';
    return [{ command, exitCode, passed, failed, total, parsedAs, verified, stepRef }];
  });

  for (const key of ['blockers', 'risks', 'unknowns', 'nextActions']) {
    out[key] = out[key].flatMap((entry, i) => {
      const text = cleanString(entry, 500);
      if (!text) {
        repaired.push(`${key}[${i}]: dropped empty entry`);
        return [];
      }
      return [text];
    });
  }

  // Bounded growth: trim from the end (model is asked recent-first), never
  // touching objective or outstanding requirements.
  for (const [key, cap] of Object.entries(ARRAY_CAPS)) {
    if (out[key].length > cap) {
      out[key] = out[key].slice(0, cap);
      repaired.push(`${key}: trimmed to ${cap} entries`);
    }
  }

  const checkpoint = { objective: out.objective };
  for (const key of ARRAY_KEYS) checkpoint[key] = out[key];
  if (JSON.stringify(checkpoint).length > byteCap) {
    // Second pass: drop lower-priority detail in order. Outstanding
    // requirements and the objective are never reduced.
    for (const key of ['unknowns', 'risks', 'nextActions', 'decisions']) {
      if (JSON.stringify(checkpoint).length <= byteCap) break;
      if (checkpoint[key].length) {
        checkpoint[key] = [];
        repaired.push(`${key}: cleared to fit size cap`);
      }
    }
  }
  if (JSON.stringify(checkpoint).length > byteCap) {
    errors.push(`checkpoint exceeds size cap (${JSON.stringify(checkpoint).length} > ${byteCap} chars) even after trimming`);
    return { ok: false, checkpoint: null, errors, repaired };
  }
  return { ok: true, checkpoint, errors, repaired };
}

// --- Rendering for prompts ---

function renderCheckpointSection(checkpoint, { version, stale, reasons = [] }) {
  const lines = [CHECKPOINT_MARKER];
  lines.push(stale
    ? `[WORKSPACE CHECKPOINT v${version} — STALE (${reasons.join('; ') || 'history changed since checkpoint'}). Verify against current history before acting.]`
    : `[WORKSPACE CHECKPOINT v${version} — current]`);
  lines.push(`Objective: ${checkpoint.objective}`);
  const reqLines = checkpoint.outstandingRequirements.map(req =>
    `- [${req.status}]${req.briefId != null ? ` (brief #${req.briefId})` : ''} ${truncateText(req.text, 200)}`);
  lines.push(`Outstanding requirements (${reqLines.length}):${reqLines.length ? `\n${reqLines.join('\n')}` : ' none recorded'}`);
  const pushList = (title, items, format) => {
    if (!items.length) return;
    lines.push(`${title} (${items.length}):\n${items.map(format).join('\n')}`);
  };
  pushList('Decisions', checkpoint.decisions, decision =>
    `- ${decision.text}${decision.rationale ? ` (why: ${truncateText(decision.rationale, 160)})` : ''} [${decision.verified ? 'verified' : 'unverified'}]`);
  pushList('Completed work', checkpoint.completedWork, item => `- ${item.text}`);
  pushList('In progress', checkpoint.inProgress, item => `- ${item.text} (${item.status})`);
  pushList('Files changed', checkpoint.filesChanged, file =>
    `- ${file.path}${file.nature ? ` (${file.nature})` : ''} [${file.verified ? 'verified' : 'unverified'}]`);
  pushList('Commands', checkpoint.commands, command =>
    `- ${truncateText(command.command, 160)} → exit ${command.exitCode == null ? '?' : command.exitCode} [${command.verified ? 'verified' : 'unverified'}]`);
  pushList('Tests', checkpoint.tests, test => {
    const counts = test.parsedAs === 'regex'
      ? `passed ${test.passed ?? '?'} / failed ${test.failed ?? '?'}${test.total != null ? ` / ${test.total} total` : ''} (parsed output)`
      : 'no parseable counts';
    return `- ${test.command ? `${truncateText(test.command, 120)} → ` : ''}exit ${test.exitCode == null ? '?' : test.exitCode}, ${counts} [${test.verified ? 'verified' : 'unverified'}]`;
  });
  const pushStrings = (title, items) => {
    if (items.length) lines.push(`${title} (${items.length}):\n${items.map(item => `- ${item}`).join('\n')}`);
  };
  pushStrings('Blockers', checkpoint.blockers);
  pushStrings('Next actions', checkpoint.nextActions);
  pushStrings('Risks', checkpoint.risks);
  pushStrings('Unknowns', checkpoint.unknowns);
  lines.push(CHECKPOINT_END);
  return lines.join('\n');
}

// --- Persistence and lookup (Workspace only; Casual returns null/[]) ---

function rowToCheckpoint(row) {
  if (!row) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(row.checkpoint_json);
  } catch {
    return { ...row, checkpoint: null, corrupt: true };
  }
  return { ...row, checkpoint: parsed };
}

function getLatestCheckpoint(sessionId) {
  requireSessionId(sessionId);
  if (!isWorkspaceSession(sessionId)) return null;
  const row = db.prepare(`SELECT * FROM workspace_checkpoints
    WHERE session_id = ? AND status = 'current' ORDER BY id DESC LIMIT 1`).get(sessionId);
  const parsed = rowToCheckpoint(row);
  if (parsed && parsed.corrupt) return null;
  return parsed;
}

function getCheckpointHistory(sessionId, limit = 10) {
  requireSessionId(sessionId);
  if (!isWorkspaceSession(sessionId)) return [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
  return db.prepare(`SELECT * FROM workspace_checkpoints
    WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(sessionId, safeLimit)
    .map(rowToCheckpoint).filter(row => !row.corrupt);
}

function parseArchivedIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(id => Number.isSafeInteger(id)) : [];
  } catch {
    return [];
  }
}

// Derive staleness by comparing the row's bindings to live state. Any
// mismatch means the checkpoint no longer describes the current history.
function isCheckpointStale(sessionId, row) {
  requireSessionId(sessionId);
  const reasons = [];
  if (!row || row.corrupt || !row.checkpoint) return { stale: true, reasons: ['missing or unreadable checkpoint'] };
  const leafId = db.prepare('SELECT active_leaf_id FROM sessions WHERE id = ?').get(sessionId)?.active_leaf_id ?? null;
  if (leafId !== (row.active_leaf_id ?? null)) reasons.push('history advanced past the checkpoint snapshot');
  if (briefs.getBriefIdentity(sessionId) !== (row.brief_identity ?? '')) reasons.push('task instructions changed');
  const liveSummary = (() => {
    try {
      return require('./sessionManager').getSessionSummary(sessionId) ?? '';
    } catch {
      return '';
    }
  })();
  if (liveSummary !== (row.summary_text ?? '')) reasons.push('conversation summary changed');
  const archivedIds = parseArchivedIds(row.archived_ids_json);
  if (archivedIds.length) {
    const select = db.prepare('SELECT id, estimated_tokens, execution_steps FROM messages WHERE id = ? AND session_id = ?');
    const current = [];
    for (const id of archivedIds) {
      const live = select.get(id, sessionId);
      if (!live) {
        reasons.push('covered history was deleted');
        break;
      }
      let steps = [];
      try {
        steps = readExecutionSteps(live) || [];
      } catch {
        steps = [];
      }
      current.push({ id: live.id, estimated_tokens: live.estimated_tokens ?? null, steps });
    }
    if (!reasons.length) {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex');
      if (fingerprint !== row.evidence_fingerprint) reasons.push('covered execution evidence changed');
    }
  }
  return { stale: reasons.length > 0, reasons };
}

function buildCheckpointSection(sessionId) {
  requireSessionId(sessionId);
  const row = getLatestCheckpoint(sessionId);
  if (!row || !row.checkpoint) return null;
  const { stale, reasons } = isCheckpointStale(sessionId, row);
  return {
    role: 'system',
    content: renderCheckpointSection(row.checkpoint, { version: row.id, stale, reasons }),
    taskCheckpoint: true,
    checkpointId: row.id,
    checkpointStale: stale,
    checkpointVersion: row.id,
  };
}

// Must be called inside the caller's SQLite transaction: supersedes prior
// current rows, then inserts the candidate as current. Returns the new id.
function persistCheckpointRow({ sessionId, modelId, checkpoint, summaryId, summaryText,
  briefIdentity, leafId, archivedIds, fingerprint }) {
  requireSessionId(sessionId);
  db.prepare(`UPDATE workspace_checkpoints SET status = 'superseded'
    WHERE session_id = ? AND status = 'current'`).run(sessionId);
  const result = db.prepare(`INSERT INTO workspace_checkpoints
    (session_id, status, model_id, checkpoint_json, summary_id, summary_text,
     brief_identity, active_leaf_id, archived_ids_json, evidence_fingerprint)
    VALUES (?, 'current', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, modelId ?? null, JSON.stringify(checkpoint), summaryId ?? null,
    summaryText ?? '', briefIdentity ?? '', leafId ?? null,
    JSON.stringify(archivedIds ?? []), fingerprint ?? '',
  );
  return Number(result.lastInsertRowid);
}

module.exports = {
  CHECKPOINT_MARKER,
  CHECKPOINT_END,
  CHECKPOINT_BYTE_CAP,
  CHECKPOINT_LLM_MAX_TOKENS,
  isWorkspaceSession,
  classifyStepOutcome,
  parseTestCounts,
  collectEvidence,
  evidenceIndex,
  computeEvidenceFingerprint,
  renderEvidenceForModel,
  buildCheckpointInput,
  validateCheckpoint,
  renderCheckpointSection,
  getLatestCheckpoint,
  getCheckpointHistory,
  isCheckpointStale,
  buildCheckpointSection,
  persistCheckpointRow,
};
