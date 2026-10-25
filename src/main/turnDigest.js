'use strict';

// Per-turn work digest (Phase 1: pure builder, no I/O, no database, no LLM).
//
// WHY: in Workspace chats only user text and final assistant text persist
// between turns. Tool calls/results live in the assistant message's
// execution_steps JSON (display only), so the agent forgets which files it
// read or edited, which tests failed, and what it searched. This module
// builds a small deterministic record from those persisted steps.
//
// BUDGET MODEL (shared, enforced here in part, assembled in Phase 2):
// - One digest's rendered text is hard-capped at DIGEST_CHAR_CAP characters
//   (~500 tokens at the local chars/4 heuristic). Four digests therefore cost
//   at most ~2,000 tokens, leaving room inside the WORKLOG_CHAR_CAP global
//   budget (~2,500 tokens) for the older-issue ledger. Never assume four full
//   digests fit untouched: Phase 2 assembles newest-first and truncates.
// - Inside one digest, fill order is: open/unresolved issues, edits, failed
//   commands, successful checks, delegated results, web sources, reads, other.
//   Truncation drops from the bottom and is always reported explicitly.
//
// DETERMINISM CONTRACT: identical steps + identical prior ledger + identical
// context produce byte-identical output. No timestamps, no randomness, no
// filesystem reads, no network. Callers supply turnSeq; the ledger carries a
// monotonic nextId counter instead of time.
//
// EVIDENCE RULES (never infer without evidence):
// - A step's own status (complete/error as persisted by the engine) plus
//   explicit result fields are the only evidence. Unfinished steps
//   (pending/running/preparing/anything else) are recorded as unfinished and
//   contribute to nothing: no successes, no resolutions.
// - Exit codes only from an explicit numeric exitCode field. Never parsed out
//   of text. A "tests passed" claim requires a test-runner command AND a
//   numeric exit code of 0 AND a non-error status.
// - Commit hashes only from an explicit 40/64-hex hash field. Line counts
//   for edits come from request args (what was requested), never the FS.
// - Secrets are redacted from every string that can carry one (commands,
//   args excerpts, results, errors, URLs) before truncation, so a cut can
//   never expose half a secret.
//
// PROMPT PLACEMENT NOTE (for Phase 2 integration, not this phase):
// appending digest text inside the brief section grows the prompt prefix, so
// llama.cpp prompt-cache reuse for the checkpoint/summary/message suffix is
// re-established only up to the append point on turns that add a digest.
// Earlier brief entries stay byte-stable, which preserves the reusable
// prefix. Phase 2 must measure actual prefix reuse; if cache churn dominates,
// prefer a single digest block after the brief section (same stability
// property, weaker semantic grouping) over per-brief interleaving.

const DIGEST_VERSION = 1;
const DIGEST_CHAR_CAP = 2000; // ~500 tokens per digest (rendered text hard cap)
const WORKLOG_CHAR_CAP = 10000; // ~2,500 tokens global work-log budget (Phase 2 assembly)
const LEDGER_ISSUE_CAP = 20;
const EXCERPT_CAP = 200; // per evidence excerpt (errors, results)
const SUMMARY_CAP = 160; // per summary/task line
const ISSUE_EXCERPT_CAP = 120;
const PATHS_LIST_MAX = 3;

// ---------------------------------------------------------------------------
// Tokens (approximate heuristic, same as the session estimate)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

// ---------------------------------------------------------------------------
// Secret redaction (applied BEFORE truncation everywhere)
// ---------------------------------------------------------------------------

const { redactSecrets } = require('../lib/secretRedaction.cjs');

// ---------------------------------------------------------------------------
// Tool classification (deterministic, by exact tool name)
// ---------------------------------------------------------------------------

const EDIT_TOOLS = new Set([
  'write_project_file',
  'str_replace_editor',
  'edit_project_files',
  'apply_patch',
  'move_project_file',
  'delete_project_file',
  'git_stage',
  'git_unstage',
  'git_commit',
  'git_create_branch',
  'git_switch',
  'git_stash',
]);
const READ_TOOLS = new Set([
  'read_project_file',
  'list_directory',
  'search_project_content',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'git_blame',
  'get_recent_chat_history',
]);
const DELEGATE_TOOLS = new Set(['spawn_sub_agent', 'delegate_task']);
const WEB_TOOLS = new Set(['get_single_web_page_content', 'extract_web_page_data', 'web_search']);

// Heuristic, documented: a shell command that IS a test-runner invocation.
// Word-boundaried so `contest`, `testing`, or `jest.config` never match.
const TEST_RUNNER_RE =
  /(^|[\s;&|])(npm\s+(test|tst|run\s+test)|npx\s+(vitest|jest)|vitest|jest|pytest|node\s+--test|cargo\s+test|go\s+test|make\s+(test|check)|pnpm\s+(test|run\s+test)|yarn\s+test|bun\s+test)(?=[\s;&|]|$)/;

function classifyTool(toolName) {
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (READ_TOOLS.has(toolName)) return 'read';
  if (toolName === 'execute_command' || toolName === 'run_tests') return 'command';
  if (DELEGATE_TOOLS.has(toolName)) return 'delegate';
  if (WEB_TOOLS.has(toolName)) return 'web';
  return 'other';
}

const ISSUE_BASE = {
  'edit-failure': 'edit',
  'command-failure': 'command',
  'check-failure': 'check',
  'delegate-failure': 'delegate',
  'web-failure': 'web',
  'op-failure': 'other',
};

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function capText(text, cap) {
  const value = String(text ?? '');
  return value.length > cap ? value.slice(0, cap) : value;
}

function countLines(text) {
  if (typeof text !== 'string' || !text) return 0;
  const parts = text.split('\n');
  return parts.length - (text.endsWith('\n') ? 1 : 0);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

// Project-relative paths straight from validated tool args (never the FS).
function extractPaths(toolName, args) {
  if (!args || typeof args !== 'object') return [];
  const paths = [];
  if (typeof args.relative_path === 'string') paths.push(args.relative_path);
  if (typeof args.path === 'string') paths.push(args.path);
  for (const value of stringList(args.paths)) paths.push(value);
  if (typeof args.source_path === 'string') paths.push(args.source_path);
  if (typeof args.destination_path === 'string') paths.push(args.destination_path);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit.relative_path === 'string') paths.push(edit.relative_path);
    }
  }
  return [...new Set(paths)];
}

function formatPaths(paths) {
  const shown = paths.slice(0, PATHS_LIST_MAX).join(', ');
  return paths.length > PATHS_LIST_MAX ? `${shown} (+${paths.length - PATHS_LIST_MAX} more)` : shown;
}

function normalizeCommand(command) {
  return String(command ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value) ? value : null;
}

function numericExit(value) {
  return Number.isSafeInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Step -> entry (evidence-only; never throws on unknown shapes)
// ---------------------------------------------------------------------------

function entryErrorText(step, result) {
  const direct = typeof step.error === 'string' && step.error ? step.error : null;
  const fromResult =
    result && typeof result === 'object' && typeof result.error === 'string' && result.error ? result.error : null;
  const text = direct ?? fromResult;
  return text ? capText(redactSecrets(text), EXCERPT_CAP) : null;
}

function isExplicitFailure(step, result) {
  if (step.status === 'error') return true;
  if (result && typeof result === 'object' && (result.isError === true || result.success === false)) return true;
  return false;
}

function buildEntry(step, index, resolveChild) {
  const tool = typeof step.toolName === 'string' && step.toolName ? step.toolName : 'unknown-tool';
  const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {};
  const result = step.result !== undefined ? step.result : null;
  const failed = isExplicitFailure(step, result);
  const finished = step.status === 'complete' || step.status === 'error';
  const status = !finished ? 'unfinished' : failed ? 'error' : 'complete';
  const paths = extractPaths(tool, args);
  const entry = {
    kind: classifyTool(tool),
    tool,
    status,
    paths,
    summary: '',
    exitCode: null,
    hash: null,
    linesAdded: null,
    linesRemoved: null,
    issueId: null,
    stepIndex: index,
  };
  if (status === 'unfinished') {
    entry.summary = capText(
      `started ${tool}${paths.length ? ` on ${formatPaths(paths)}` : ''} — unfinished`,
      SUMMARY_CAP,
    );
    return entry;
  }

  const errorText = status === 'error' ? entryErrorText(step, result) : null;
  if (entry.kind === 'edit') {
    entry.summary = summarizeEdit(tool, args, paths, result, status, errorText, entry);
  } else if (entry.kind === 'read') {
    entry.summary = summarizeRead(tool, args, paths, result, status, errorText);
  } else if (entry.kind === 'command') {
    summarizeCommand(entry, args, result, status, errorText);
  } else if (entry.kind === 'delegate') {
    summarizeDelegate(entry, args, result, status, errorText, step, resolveChild);
  } else if (entry.kind === 'web') {
    entry.summary = summarizeWeb(args, result, status, errorText);
  } else if (tool === 'update_plan') {
    entry.summary =
      status === 'error'
        ? capText(`update_plan failed${errorText ? `: ${errorText}` : ''}`, SUMMARY_CAP)
        : 'updated the task plan';
  } else if (tool === 'get_project_plans') {
    entry.summary =
      status === 'error'
        ? capText(`get_project_plans failed${errorText ? `: ${errorText}` : ''}`, SUMMARY_CAP)
        : 'reviewed project task plans';
  } else {
    entry.summary =
      status === 'error'
        ? capText(`${tool} failed${errorText ? `: ${errorText}` : ''}`, SUMMARY_CAP)
        : capText(tool, SUMMARY_CAP);
  }
  return entry;
}

const EDIT_VERBS = {
  write_project_file: 'wrote',
  str_replace_editor: 'edited',
  edit_project_files: 'edited',
  apply_patch: 'patched',
  move_project_file: 'moved',
  delete_project_file: 'deleted',
  git_stage: 'staged',
  git_unstage: 'unstaged',
  git_commit: 'committed',
  git_create_branch: 'created branch',
  git_switch: 'switched to',
  git_stash: 'stashed',
};

function summarizeEdit(tool, args, paths, result, status, errorText, entry) {
  const scope = paths.length ? ` ${formatPaths(paths)}` : '';
  if (status === 'error') {
    return capText(`${EDIT_VERBS[tool] ?? 'edited'}${scope} — failed${errorText ? `: ${errorText}` : ''}`, SUMMARY_CAP);
  }
  // Line counts describe the request args (what was asked for), never the FS.
  if (tool === 'str_replace_editor' && typeof args.old_str === 'string' && typeof args.new_str === 'string') {
    entry.linesAdded = countLines(args.new_str);
    entry.linesRemoved = countLines(args.old_str);
  } else if (tool === 'write_project_file' && typeof args.content === 'string') {
    entry.linesAdded = countLines(args.content);
  } else if (tool === 'edit_project_files' && Array.isArray(args.edits)) {
    let added = 0;
    let removed = 0;
    let known = false;
    for (const edit of args.edits) {
      if (edit && typeof edit.old_str === 'string' && typeof edit.new_str === 'string') {
        added += countLines(edit.new_str);
        removed += countLines(edit.old_str);
        known = true;
      }
    }
    if (known) {
      entry.linesAdded = added;
      entry.linesRemoved = removed;
    }
  } else if (tool === 'apply_patch' && typeof args.patch === 'string') {
    let added = 0;
    let removed = 0;
    for (const line of args.patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }
    entry.linesAdded = added;
    entry.linesRemoved = removed;
  }
  const lines =
    entry.linesAdded !== null && entry.linesRemoved !== null ? ` (+${entry.linesAdded}/-${entry.linesRemoved})` : '';
  if (tool === 'move_project_file' && typeof args.source_path === 'string') {
    return capText(`moved ${args.source_path} → ${args.destination_path ?? '?'}`, SUMMARY_CAP);
  }
  if (tool === 'git_commit') {
    const hash = result && typeof result === 'object' ? validHash(result.hash) : null;
    if (hash) entry.hash = hash;
    const message = firstString(typeof args.message === 'string' ? args.message.split('\n')[0].trim() : null);
    return capText(
      `committed${message ? ` '${capText(redactSecrets(message), 80)}'` : ''}${hash ? ` (${hash.slice(0, 7)})` : ''}`,
      SUMMARY_CAP,
    );
  }
  if (tool === 'git_create_branch' && typeof args.name === 'string') {
    return capText(`created branch ${args.name}`, SUMMARY_CAP);
  }
  if (tool === 'git_switch') {
    const ref = firstString(typeof args.ref === 'string' ? args.ref : null);
    return capText(`switched to${ref ? ` ${ref}` : ''}`, SUMMARY_CAP);
  }
  return capText(`${EDIT_VERBS[tool] ?? 'edited'}${scope}${lines}`, SUMMARY_CAP);
}

function summarizeRead(tool, args, paths, result, status, errorText) {
  const scope = paths.length ? ` ${formatPaths(paths)}` : '';
  if (status === 'error') {
    return capText(`${tool}${scope} — failed${errorText ? `: ${errorText}` : ''}`, SUMMARY_CAP);
  }
  const output = result && typeof result === 'object' && typeof result.output === 'string' ? result.output : null;
  if (tool === 'search_project_content' && result && typeof result === 'object' && Array.isArray(result.matches)) {
    const query = firstString(typeof args.query === 'string' ? args.query : null);
    return capText(
      `searched${query ? ` '${capText(redactSecrets(query), 60)}'` : ''}${scope}: ${result.matches.length} match(es)`,
      SUMMARY_CAP,
    );
  }
  if (tool === 'read_project_file') {
    const ranged = result && typeof result === 'object'
      && Number.isSafeInteger(result.actual_start_line) && Number.isSafeInteger(result.actual_end_line);
    const rangeSuffix = ranged
      ? ` lines ${result.actual_start_line}–${result.actual_end_line}${Number.isSafeInteger(result.total_lines) ? ` of ${result.total_lines}` : ''}`
      : '';
    if (result && typeof result === 'object' && result.not_modified === true) {
      return capText(`verified${scope}${rangeSuffix} unchanged`, SUMMARY_CAP);
    }
    if (result && typeof result === 'object' && (result.type === 'image_url' || result.image_url)) {
      return capText(`read${scope} (image content)`, SUMMARY_CAP);
    }
    if (ranged) {
      const truncated = result.truncated === true ? ' (truncated)' : '';
      return capText(`read${scope}${rangeSuffix}${truncated}`, SUMMARY_CAP);
    }
    const content = result && typeof result === 'object' && typeof result.content === 'string' ? result.content : null;
    if (content !== null) return capText(`read${scope} (${content.length} chars)`, SUMMARY_CAP);
    return capText(`read${scope}`, SUMMARY_CAP);
  }
  if (tool === 'git_diff' && output !== null) {
    if (!output.trim()) return capText(`diff${scope}: no changes`, SUMMARY_CAP);
    let added = 0;
    let removed = 0;
    for (const line of output.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }
    return capText(`diff${scope}: +${added}/-${removed}`, SUMMARY_CAP);
  }
  if (tool === 'git_log' && output !== null) {
    const commits = output.split('\n').filter((line) => line.trim()).length;
    return capText(`listed ${commits} commit(s)${scope}`, SUMMARY_CAP);
  }
  if (tool === 'git_status' && output !== null) {
    const entries = output.split('\n').filter((line) => line.trim() && !line.startsWith('##')).length;
    return capText(entries ? `status: ${entries} changed path(s)` : 'status: clean', SUMMARY_CAP);
  }
  if ((tool === 'git_show' || tool === 'git_blame') && output !== null) {
    const ref = firstString(typeof args.ref === 'string' ? args.ref : null);
    return capText(`${tool === 'git_show' ? 'showed' : 'blamed'}${ref ? ` ${ref}` : ''}${scope} (${output.length} chars)`, SUMMARY_CAP);
  }
  if (tool === 'list_directory' && result && typeof result === 'object' && Array.isArray(result.entries)) {
    return capText(`listed${scope} (${result.entries.length} entries)`, SUMMARY_CAP);
  }
  return capText(`${tool}${scope}`, SUMMARY_CAP);
}

function summarizeCommand(entry, args, result, status, errorText) {
  const command = typeof args.command === 'string' ? normalizeCommand(args.command) : '';
  const shown = capText(redactSecrets(command), 120);
  const exitCode = result && typeof result === 'object' ? numericExit(result.exitCode) : null;
  if (exitCode !== null) entry.exitCode = exitCode;
  const isTest = TEST_RUNNER_RE.test(command);
  if (isTest) entry.kind = 'check';
  if (status === 'error' || (exitCode !== null && exitCode !== 0)) {
    entry.status = 'error';
    entry.summary = capText(
      `${isTest ? 'tests failed' : shown ? `'${shown}' failed` : 'command failed'}${exitCode !== null ? ` (exit ${exitCode})` : ''}${errorText ? `: ${errorText}` : ''}`,
      SUMMARY_CAP,
    );
    return;
  }
  if (isTest && exitCode === 0) {
    entry.summary = capText(`tests passed: ${shown} (exit 0)`, SUMMARY_CAP);
    return;
  }
  entry.summary = capText(
    shown ? `ran '${shown}'${exitCode !== null ? ` (exit ${exitCode})` : ''}` : 'ran command',
    SUMMARY_CAP,
  );
}

const DELEGATE_TASK_KEYS = ['task_description', 'task', 'query', 'question', 'prompt', 'instruction', 'goal'];

function summarizeDelegate(entry, args, result, status, errorText, step, resolveChild) {
  const task = capText(redactSecrets(delegateTaskText(args) ?? ''), SUMMARY_CAP);
  if (status === 'error') {
    entry.summary = capText(`delegation failed${task ? `: ${task}` : ''}${errorText ? ` — ${errorText}` : ''}`, SUMMARY_CAP);
    return;
  }
  // Prefer evidence already on the step; fall back to the injected child
  // transcript resolver (wired by Phase 2); never invent an answer.
  let answer = null;
  if (typeof result === 'string' && result.trim()) answer = result;
  else if (result && typeof result === 'object') {
    const text = firstString(result.text, result.content, result.answer, result.summary);
    if (text) answer = text;
  }
  if (answer === null && step && typeof step.childSessionId === 'string') {
    try {
      const resolved = resolveChild ? resolveChild(step.childSessionId) : null;
      if (typeof resolved === 'string' && resolved.trim()) answer = resolved;
    } catch {
      answer = null;
    }
  }
  entry.summary = capText(
    `delegated${task ? ` ${task}` : ''} → ${answer ? capText(redactSecrets(answer), SUMMARY_CAP) : 'result unavailable'}`,
    SUMMARY_CAP,
  );
}

function summarizeWeb(args, result, status, errorText) {
  const url = typeof args.url === 'string' ? redactSecrets(args.url) : '';
  const query = firstString(
    typeof args.query === 'string' ? args.query : null,
    typeof args.question === 'string' ? args.question : null,
  );
  const shownUrl = capText(url, 160);
  const shownQuery = query ? capText(redactSecrets(query), 60) : null;
  // Web search carries no URL: report the query and the recorded outcome or
  // result count instead of a fetch summary.
  if (!url && query) {
    if (status === 'error' || result?.success === false) {
      return capText(`web search failed${shownQuery ? ` for '${shownQuery}'` : ''}${errorText ? ` — ${errorText}` : ''}`, SUMMARY_CAP);
    }
    const outcome = typeof result?.outcome === 'string' ? result.outcome : null;
    const count = Array.isArray(result?.results) ? result.results.length : null;
    if (outcome && outcome !== 'success' && outcome !== 'no_results') {
      return capText(`searched '${shownQuery ?? ''}' → ${outcome}`, SUMMARY_CAP);
    }
    return capText(`searched '${shownQuery ?? ''}'${count !== null ? ` (${count} result${count === 1 ? '' : 's'})` : ''}`, SUMMARY_CAP);
  }
  if (status === 'error') {
    return capText(`fetch failed${shownUrl ? `: ${shownUrl}` : ''}${errorText ? ` — ${errorText}` : ''}`, SUMMARY_CAP);
  }
  let size = null;
  if (result && typeof result === 'object' && typeof result.content === 'string') size = ` (${result.content.length} chars)`;
  return capText(`fetched${shownUrl ? ` ${shownUrl}` : ''}${shownQuery ? ` for '${shownQuery}'` : ''}${size ?? ''}`, SUMMARY_CAP);
}

// ---------------------------------------------------------------------------
// Issue ledger: open on evidence, resolve only on matching evidence
// ---------------------------------------------------------------------------

function issueBaseKind(issueKind) {
  return ISSUE_BASE[issueKind] ?? null;
}

function entrySig(entry) {
  if (entry.kind === 'edit') {
    const paths = [...entry.paths].sort();
    return `edit:${paths.join(',') || entry.tool}`;
  }
  if (entry.kind === 'command' || entry.kind === 'check') {
    const command = entry.commandText ?? '';
    return `cmd:${command.slice(0, 120)}`;
  }
  if (entry.kind === 'delegate') {
    return `delegate:${(entry.taskText ?? '').slice(0, 120)}`;
  }
  if (entry.kind === 'web') {
    return `web:${(entry.urlText ?? '').slice(0, 120)}`;
  }
  return `op:${entry.tool}:${entry.paths[0] ?? ''}`;
}

function normalizeLedger(input) {
  const ledger = { version: DIGEST_VERSION, nextId: 1, issues: [] };
  if (!input || typeof input !== 'object') return ledger;
  if (Number.isSafeInteger(input.nextId) && input.nextId >= 1) ledger.nextId = input.nextId;
  if (!Array.isArray(input.issues)) return ledger;
  for (const issue of input.issues) {
    if (!issue || typeof issue !== 'object') continue;
    if (typeof issue.id !== 'string' || typeof issue.kind !== 'string' || typeof issue.sig !== 'string') continue;
    if (issue.status !== 'open' && issue.status !== 'resolved') continue;
    ledger.issues.push({
      id: issue.id,
      kind: issue.kind,
      tool: typeof issue.tool === 'string' ? issue.tool : '',
      sig: issue.sig,
      status: issue.status,
      excerpt: typeof issue.excerpt === 'string' ? issue.excerpt : '',
      exitCode: Number.isSafeInteger(issue.exitCode) ? issue.exitCode : null,
      openedTurn: Number.isSafeInteger(issue.openedTurn) ? issue.openedTurn : null,
      resolvedTurn: Number.isSafeInteger(issue.resolvedTurn) ? issue.resolvedTurn : null,
    });
    const numeric = /^iss-(\d+)$/.exec(issue.id);
    if (numeric) ledger.nextId = Math.max(ledger.nextId, Number(numeric[1]) + 1);
  }
  return ledger;
}

function issueKindFor(entry) {
  if (entry.kind === 'edit') return 'edit-failure';
  if (entry.kind === 'check') return 'check-failure';
  if (entry.kind === 'command') return 'command-failure';
  if (entry.kind === 'delegate') return 'delegate-failure';
  if (entry.kind === 'web') return 'web-failure';
  return 'op-failure';
}

function entryOpensIssue(entry) {
  if (entry.status !== 'error') return false;
  if ((entry.kind === 'command' || entry.kind === 'check') && entry.exitCode === 0) return false;
  return true;
}

function entryResolvesIssue(entry, issue) {
  if (entry.status !== 'complete') return false;
  const base = issueBaseKind(issue.kind);
  if (!base) return false;
  if (base === 'command' || base === 'check') {
    if (entry.kind !== 'command' && entry.kind !== 'check') return false;
    if (entry.exitCode !== 0) return false;
  } else if (entry.kind !== base) {
    return false;
  }
  return entrySig(entry) === issue.sig;
}

// Pure reducer: prior ledger + this turn's entries -> reconciled ledger.
// Chronological walk: failures open, later matching completions resolve.
function reconcileIssues(prevLedger, entries, turnSeq) {
  const ledger = normalizeLedger(prevLedger);
  let resolvedThisTurn = 0;
  let evicted = 0;
  for (const entry of entries) {
    if (entryOpensIssue(entry)) {
      const sig = entrySig(entry);
      const base = entry.kind === 'check' ? 'check' : entry.kind;
      const kind =
        base === 'edit' ? 'edit-failure'
        : base === 'command' ? 'command-failure'
        : base === 'check' ? 'check-failure'
        : base === 'delegate' ? 'delegate-failure'
        : base === 'web' ? 'web-failure'
        : 'op-failure';
      const duplicate = ledger.issues.some((issue) => issue.status === 'open' && issue.kind === kind && issue.sig === sig);
      if (duplicate) continue;
      const id = `iss-${ledger.nextId}`;
      ledger.nextId += 1;
      ledger.issues.push({
        id,
        kind,
        tool: entry.tool,
        sig,
        status: 'open',
        excerpt: capText(entry.summary, ISSUE_EXCERPT_CAP),
        exitCode: entry.kind === 'command' || entry.kind === 'check' ? entry.exitCode : null,
        openedTurn: turnSeq,
        resolvedTurn: null,
      });
      entry.issueId = id;
      continue;
    }
    for (const issue of ledger.issues) {
      if (issue.status !== 'open') continue;
      if (entryResolvesIssue(entry, issue)) {
        issue.status = 'resolved';
        issue.resolvedTurn = turnSeq;
        entry.issueId = entry.issueId ?? issue.id;
        resolvedThisTurn += 1;
        break;
      }
    }
  }
  while (ledger.issues.length > LEDGER_ISSUE_CAP) {
    const resolvedIndex = ledger.issues.findIndex((issue) => issue.status === 'resolved');
    ledger.issues.splice(resolvedIndex >= 0 ? resolvedIndex : 0, 1);
    evicted += 1;
  }
  return { ledger, resolvedThisTurn, evicted };
}

// ---------------------------------------------------------------------------
// Digest assembly (prioritized fill under the hard cap)
// ---------------------------------------------------------------------------

const ENTRY_RANK = {
  edit: 10,
  error: 20,
  check: 30,
  delegate: 40,
  web: 50,
  read: 60,
  other: 70,
  unfinished: 80,
};

function entryRank(entry) {
  if (entry.status === 'unfinished') return ENTRY_RANK.unfinished;
  if (entry.status === 'error') return ENTRY_RANK.error;
  return ENTRY_RANK[entry.kind] ?? ENTRY_RANK.other;
}

function issueLabel(issue) {
  const base =
    issue.kind === 'edit-failure' ? 'edit failed'
    : issue.kind === 'command-failure' ? 'command failed'
    : issue.kind === 'check-failure' ? 'tests failed'
    : issue.kind === 'delegate-failure' ? 'delegation failed'
    : issue.kind === 'web-failure' ? 'fetch failed'
    : 'operation failed';
  return issue.exitCode !== null && issue.exitCode !== undefined ? `${base} (exit ${issue.exitCode})` : base;
}

function renderIssueLine(issue) {
  return `- ${issueLabel(issue)}: ${issue.sig} — ${issue.excerpt}`;
}

function buildTurnDigest(steps, context = {}) {
  if (!Array.isArray(steps)) throw new TypeError('steps must be an array.');
  const { turnSeq, partial = false, resolveChild = null } = context ?? {};
  if (!Number.isSafeInteger(turnSeq) || turnSeq < 0) throw new TypeError('turnSeq must be a non-negative integer.');
  if (resolveChild !== null && typeof resolveChild !== 'function') throw new TypeError('resolveChild must be a function.');
  const partialFlag = partial === true;

  const entries = [];
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') return;
    if (step.type === 'thought') return;
    if (step.type !== undefined && step.type !== 'tool_call') return;
    const entry = buildEntry(step, index, resolveChild);
    // Stash raw evidence needed for signatures before rendering. Secret
    // bearing text is redacted here: signatures render in issue lines and
    // persist in the ledger, so they must never carry live secrets.
    if ((entry.kind === 'command' || entry.kind === 'check') && typeof step.args === 'object' && step.args !== null) {
      entry.commandText = redactSecrets(normalizeCommand(step.args.command));
    }
    if (entry.kind === 'delegate') {
      entry.taskText = redactSecrets(delegateTaskText(step.args));
    }
    if (entry.kind === 'web') {
      entry.urlText = typeof step.args?.url === 'string'
        ? redactSecrets(step.args.url)
        : (typeof step.args?.query === 'string' ? `query:${redactSecrets(step.args.query)}` : '');
    }
    entries.push(entry);
  });

  const { ledger, resolvedThisTurn, evicted } = reconcileIssues(context.prevLedger, entries, turnSeq);
  const openIssues = ledger.issues.filter((issue) => issue.status === 'open').map((issue) => ({ ...issue }));

  // Entries linked to still-open issues live in the Open section; rendering
  // them again would spend budget twice on the same fact.
  const openIds = new Set(openIssues.map((issue) => issue.id));
  const renderable = entries.filter((entry) => !(entry.issueId && openIds.has(entry.issueId)));
  const ranked = renderable
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => entryRank(a.entry) - entryRank(b.entry) || b.entry.stepIndex - a.entry.stepIndex)
    .map(({ entry }) => entry);

  const lines = [{ kind: 'header', text: `[Work record · turn ${turnSeq}${partialFlag ? ' · partial' : ''}]` }];
  const omitted = { entries: 0, issues: evicted };
  const pushLine = (kind, text) => {
    const current = lines.reduce((total, line) => total + line.text.length + 1, 0);
    if (current + text.length + 1 > DIGEST_CHAR_CAP) {
      if (kind === 'entry' || kind === 'unfinished') omitted.entries += 1;
      else if (kind === 'issue') omitted.issues += 1;
      return false;
    }
    lines.push({ kind, text });
    return true;
  };

  if (openIssues.length) {
    pushLine('section', `Open issues (${openIssues.length}):`);
    const ordered = [...openIssues].reverse();
    for (const issue of ordered) pushLine('issue', renderIssueLine(issue));
  }
  const unfinished = ranked.filter((entry) => entry.status === 'unfinished');
  const done = ranked.filter((entry) => entry.status !== 'unfinished');
  if (done.length) {
    pushLine('section', 'Done:');
    for (const entry of done) pushLine('entry', `- ${entry.summary}`);
  }
  if (unfinished.length) {
    pushLine('section', 'Unfinished:');
    for (const entry of unfinished) pushLine('unfinished', `- ${entry.summary}`);
  }
  const hasContent = lines.some((line) => line.kind === 'entry' || line.kind === 'unfinished' || line.kind === 'issue');
  if (!hasContent) pushLine('section', 'No tool operations recorded.');
  const omissionNote = () => {
    const bits = [];
    if (omitted.entries) bits.push(`${omitted.entries} entr${omitted.entries === 1 ? 'y' : 'ies'}`);
    if (omitted.issues) bits.push(`${omitted.issues} issue(s)`);
    return bits.length ? `Omitted: ${bits.join(', ')}.` : '';
  };
  const renderText = () => lines.map((line) => line.text).join('\n');
  const pruneTrailingOrphans = () => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].kind === 'section') {
        const follows = lines
          .slice(i + 1)
          .some((line) => line.kind === 'entry' || line.kind === 'unfinished' || line.kind === 'issue');
        if (!follows) lines.splice(i, 1);
        break;
      }
      if (lines[i].kind === 'header' || lines[i].kind === 'note') break;
    }
  };
  let text = renderText();
  for (;;) {
    const note = omissionNote();
    const full = note ? `${text}\n${note}` : text;
    if (full.length <= DIGEST_CHAR_CAP) {
      if (note) lines.push({ kind: 'note', text: note });
      text = renderText();
      break;
    }
    const last = lines[lines.length - 1];
    if (!last || last.kind === 'header' || last.kind === 'note') break;
    lines.pop();
    if (last.kind === 'entry' || last.kind === 'unfinished') omitted.entries += 1;
    else if (last.kind === 'issue') omitted.issues += 1;
    pruneTrailingOrphans();
    text = renderText();
  }

  const stripInternal = (entry) => {
    const { commandText, taskText, urlText, stepIndex, ...rest } = entry;
    void commandText;
    void taskText;
    void urlText;
    void stepIndex;
    return rest;
  };
  return {
    version: DIGEST_VERSION,
    turnSeq,
    partial: partialFlag,
    entries: entries.map(stripInternal),
    ledger,
    openIssues,
    resolvedThisTurn,
    omitted,
    tokens: estimateTokens(text),
    text,
  };
}

function delegateTaskText(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of DELEGATE_TASK_KEYS) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

module.exports = {
  DIGEST_VERSION,
  DIGEST_CHAR_CAP,
  WORKLOG_CHAR_CAP,
  LEDGER_ISSUE_CAP,
  estimateTokens,
  redactSecrets,
  classifyTool,
  reconcileIssues,
  buildTurnDigest,
};
