// Shared execution-event model for Casual Chat and Workspace renderers.
//
// Both renderers read the same runtime data: assistant `executionSteps`
// persisted on each message variant. No orchestration is duplicated here;
// this module only classifies and summarizes recorded steps so the two
// renderers stay consistent while presenting differently.
//
// Recorded step shape (see src/main/executionSteps.js + memoryChat.mjs):
//   { id, type: 'thought'|'tool_call', toolName, serverName, status,
//     args (object|null), result (any), error (string),
//     streamingArguments, durationMs? (thoughts only) }
//
// Known gaps (NOT fabricated by this module):
// - Tool steps carry no timestamps/duration. `durationMs` is shown only when
//   present; otherwise it is omitted, never synthesized.
// - No stored diff. Edit diffs below are derived from the recorded
//   `args.old_str` / `args.new_str` and always labelled as the *requested*
//   edit, with applied/confirmed wording gated on successful completion.
// - No separate exit-status / test-summary fields. Exit codes are read from
//   the recorded `result.exitCode`; test counts are best-effort parses of the
//   recorded stdout/stderr and labelled as parsed output.
// - No distinct `cancelled` status in stored steps (normalizeExecutionSteps
//   maps it to `error`); cancellation is inferred from error text and
//   labelled as such. Permission denials are inferred from the same error
//   text (`Execution blocked…`, `approval denied`, …).

export const RUNNING_STATUSES = Object.freeze(['preparing', 'pending', 'running']);

const CANCELLED_RE = /(?:tool execution cancelled|execution interrupted|question cancelled|aborted|interrupt)/i;
const BLOCKED_RE = /(?:execution blocked|approval denied|permission denied|requires a project|read only mode|ask for approval|full access)/i;

export function isRunningStatus(status) {
  return RUNNING_STATUSES.includes(status);
}

export function errorText(step) {
  if (!step || typeof step !== 'object') return '';
  const direct = typeof step.error === 'string' ? step.error : '';
  const nested =
    step.result && typeof step.result === 'object' && !Array.isArray(step.result)
      ? typeof step.result.error === 'string'
        ? step.result.error
        : ''
      : '';
  return direct || nested;
}

// Displayed failures show a classified one-liner (step.error); the recorded
// result usually carries the actual error underneath. Extract it so failure
// cards can show (and copy) substance instead of only the summary. Returns ''
// when the result adds nothing beyond the banner text.
const FAILURE_DETAIL_LIMIT = 4000;

function capDetail(text) {
  const trimmed = text.trim();
  return trimmed.length > FAILURE_DETAIL_LIMIT
    ? `${trimmed.slice(0, FAILURE_DETAIL_LIMIT)}\n… [error truncated for display]`
    : trimmed;
}

export function failureDetail(step) {
  if (!step || typeof step !== 'object') return '';
  const banner = errorText(step).trim();
  const outcome = commandOutcome(step);
  if (outcome) {
    // stdout already has its own Output section with a copy button; only
    // stderr adds information here. An exit-code-only outcome carries no
    // more than the banner already says.
    const stream = typeof outcome.stderr === 'string' ? outcome.stderr : '';
    if (stream.trim() && stream.trim() !== banner) return capDetail(stream);
    return '';
  }
  const result = step.result;
  if (typeof result === 'string') {
    return result.trim() && result.trim() !== banner ? capDetail(result) : '';
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    for (const key of ['error', 'message', 'details']) {
      const value = result[key];
      if (typeof value === 'string' && value.trim() && value.trim() !== banner) return capDetail(value);
    }
  }
  return '';
}

export function isCancelledStep(step) {
  if (!step || step.type !== 'tool_call') return false;
  if (step.status === 'cancelled') return true;
  return CANCELLED_RE.test(errorText(step));
}

export function isBlockedStep(step) {
  if (!step || step.type !== 'tool_call') return false;
  if (step?.error?.code === 'APPROVAL_DENIED' || step?.error?.code === 'PERMISSION_DENIED') return true;
  const text = `${errorText(step)} ${typeof step.result === 'string' ? step.result : ''}`;
  return BLOCKED_RE.test(text);
}

export function isFailedStep(step) {
  if (!step || step.type !== 'tool_call') return false;
  if (isCancelledStep(step) || isBlockedStep(step)) return true;
  if (step.status === 'error') return true;
  const result = step.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (result.isError === true || result.success === false) return true;
    if (typeof result.error === 'string' && result.error.trim()) return true;
  }
  return false;
}

// Canonical presentation status. Never invents timing or outcome data.
export function classifyStep(step) {
  if (!step || typeof step !== 'object') return { key: 'unknown', label: 'Unknown', tone: 'muted' };
  if (step.type === 'thought') return { key: 'thought', label: 'Thought', tone: 'muted' };
  if (isRunningStatus(step.status)) {
    return {
      key: 'running',
      label: step.status === 'preparing' ? 'Preparing' : 'Running',
      tone: 'running',
    };
  }
  if (step.status === 'cancelled' || isCancelledStep(step))
    return { key: 'cancelled', label: 'Cancelled', tone: 'cancelled' };
  if (isBlockedStep(step)) return { key: 'blocked', label: 'Needs approval', tone: 'blocked' };
  if (isFailedStep(step)) return { key: 'failed', label: 'Failed', tone: 'failed' };
  return { key: 'success', label: 'Done', tone: 'success' };
}

function truncate(text, limit = 160) {
  if (typeof text !== 'string') return '';
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function argPaths(args) {
  if (!args || typeof args !== 'object') return [];
  const candidates = [
    args.relative_path,
    args.path,
    args.file_path,
    args.filePath,
    args.cwd,
  ];
  const files = Array.isArray(args.target_files)
    ? args.target_files.filter((file) => typeof file === 'string')
    : [];
  return [...candidates.filter((value) => typeof value === 'string' && value), ...files].slice(0, 4);
}

// Short human summary derived ONLY from recorded args/result.
export function summarizeStep(step) {
  if (!step || step.type === 'thought') {
    return { title: 'Thought', summary: truncate(step?.content ?? '', 140), paths: [] };
  }
  const toolName = step.toolName || 'Tool';
  const args = step.args && typeof step.args === 'object' ? step.args : null;
  const paths = argPaths(args);
  let summary = '';
  if (args) {
    if (typeof args.command === 'string') summary = truncate(args.command, 120);
    else if (typeof args.query === 'string') summary = truncate(`"${args.query}"`, 120);
    else if (typeof args.question === 'string') summary = truncate(args.question, 140);
    else if (typeof args.task_description === 'string') summary = truncate(args.task_description, 140);
    else if (typeof args.prompt === 'string') summary = truncate(args.prompt, 120);
    else if (typeof args.name === 'string' && toolName === 'propose_skill')
      summary = truncate(args.name, 80);
    else if (typeof args.name === 'string' && toolName === 'use_skill') summary = truncate(args.name, 80);
    else if (typeof args.url === 'string') summary = truncate(args.url, 120);
    else if (paths.length) summary = truncate(paths.join(', '), 120);
    else summary = truncate(JSON.stringify(args), 120);
  } else if (typeof step.streamingArguments === 'string' && step.streamingArguments) {
    summary = truncate(step.streamingArguments, 120);
  }
  if (!summary) {
    const err = errorText(step);
    if (err) summary = truncate(err, 140);
    else if (typeof step.result === 'string') summary = truncate(step.result, 140);
  }
  return { title: toolName, summary, paths };
}

export function commandOutcome(step) {
  const result = step?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const out = {};
  if (typeof result.exitCode === 'number') out.exitCode = result.exitCode;
  if (typeof result.stdout === 'string') out.stdout = result.stdout;
  if (typeof result.stderr === 'string') out.stderr = result.stderr;
  return Object.keys(out).length ? out : null;
}

// Best-effort test summary parsed from recorded command output. Returns null
// when nothing recognizable is present; callers must label it as parsed.
export function parseTestSummary(text) {
  if (typeof text !== 'string' || !text) return null;
  const passed = /(\d+)\s+passed\b/i.exec(text);
  const failed = /(\d+)\s+failed\b/i.exec(text);
  const tests = /(\d+)\s+tests?\b/i.exec(text);
  if (!passed && !failed && !tests) {
    if (/^(ok|pass)\b/im.test(text) && /fail/i.test(text)) return { note: 'Mixed pass/fail output', passed: null, failed: null };
    return null;
  }
  return {
    passed: passed ? Number(passed[1]) : null,
    failed: failed ? Number(failed[1]) : null,
    total: tests ? Number(tests[1]) : null,
  };
}

// Requested-edit diff derived from recorded str_replace args. The caller
// decides the applied/confirmed wording from the step status.
export function requestedEditDiff(args, maxLines = 60) {
  if (!args || typeof args !== 'object') return null;
  const { old_str: oldStr, new_str: newStr } = args;
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
  const oldLines = oldStr.split('\n').slice(0, maxLines);
  const newLines = newStr.split('\n').slice(0, maxLines);
  return {
    path: typeof args.relative_path === 'string' ? args.relative_path : null,
    oldLines,
    newLines,
    truncated: oldStr.split('\n').length > maxLines || newStr.split('\n').length > maxLines,
  };
}

export function fileEditStats(step) {
  const args = step?.args;
  if (!args || typeof args !== 'object') return null;
  if (typeof args.content === 'string') {
    const lines = args.content.split('\n').length;
    return { kind: 'write', lines, chars: args.content.length };
  }
  const diff = requestedEditDiff(args, 100000);
  if (diff) return { kind: 'edit', removed: diff.oldLines.length, added: diff.newLines.length };
  return null;
}

function activeStepsOf(message) {
  if (!message || message.role !== 'assistant') return [];
  const index = message.active_variant_index ?? 0;
  const variant = Array.isArray(message.variants) ? message.variants[index] : null;
  const source = variant && typeof variant === 'object' ? variant : message;
  const steps = source.executionSteps;
  return Array.isArray(steps) ? steps : [];
}

// Flatten persisted messages into one chronological event list. Ordering and
// identifiers are preserved; nothing is synthesized.
export function buildExecutionTimeline(messages) {
  const events = [];
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      events.push({ key: `user:${message.id}`, kind: 'user', messageId: message.id, message });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const steps = activeStepsOf(message);
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      if (step.type === 'thought') {
        events.push({ key: `thought:${message.id}:${step.id}`, kind: 'thought', messageId: message.id, step });
        continue;
      }
      if (step.type !== 'tool_call') continue;
      let kind = 'tool';
      if (step.toolName === 'ask_user') kind = 'question';
      else if (step.toolName === 'propose_skill') kind = 'skill';
      else if (['delegate_task', 'spawn_sub_agent', 'extract_web_page_data'].includes(step.toolName))
        kind = 'subagent';
      events.push({ key: `tool:${message.id}:${step.id}`, kind, messageId: message.id, stepId: step.id, step });
    }
    events.push({ key: `assistant:${message.id}`, kind: 'assistant', messageId: message.id, message });
  }
  return events;
}

export function pendingSkillProposals(messages, isResolved = () => false) {
  const pending = [];
  for (const message of messages ?? []) {
    for (const step of activeStepsOf(message)) {
      if (step?.type === 'tool_call' && step.toolName === 'propose_skill' && step.status === 'complete') {
        if (!isResolved(step.id)) pending.push({ messageId: message.id, step });
      }
    }
  }
  return pending;
}

function shortenOutcome(text, limit) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

// Compact per-turn outcome entries for resolved agent interactions, derived
// ONLY from recorded steps plus already-stored resolutions. Returns entries
// in chronological step order; steps that are still pending (live request
// above the composer), undecided, or from dead non-terminal runs produce no
// entry — a resolved interaction must exist before it is reported, and
// approval is reported only for a stored registration decision.
export function getTurnOutcomes(steps, { pendingQuestions = {}, getSkillDecision = () => '' } = {}) {
  const outcomes = [];
  for (const step of steps ?? []) {
    if (!step || step.type !== 'tool_call') continue;
    if (step.toolName === 'ask_user') {
      if (pendingQuestions?.[step.id]) continue;
      if (step.status === 'complete') {
        const result = typeof step.result === 'string' ? step.result.trim() : '';
        const options = Array.isArray(step.args?.options) ? step.args.options : [];
        const detail = result && options.includes(result) ? result : 'Custom response';
        outcomes.push({
          key: `question:${step.id}`,
          kind: 'question',
          status: 'answered',
          label: `Question answered · ${shortenOutcome(detail, 80)}`,
        });
      } else if (step.status === 'error') {
        outcomes.push({
          key: `question:${step.id}`,
          kind: 'question',
          status: 'cancelled',
          label: 'Question cancelled',
        });
      }
      continue;
    }
    if (step.toolName === 'propose_skill') {
      let decision = '';
      try {
        decision = getSkillDecision(step.id) || '';
      } catch {
        decision = '';
      }
      const rawName = step.args && typeof step.args === 'object' && typeof step.args.name === 'string'
        ? step.args.name.trim()
        : '';
      const name = shortenOutcome(rawName || 'Unnamed', 60);
      if (decision === 'registered') {
        outcomes.push({
          key: `skill:${step.id}`,
          kind: 'skill',
          status: 'approved',
          label: `Skill registration approved · ${name}`,
        });
      } else if (decision === 'declined') {
        outcomes.push({
          key: `skill:${step.id}`,
          kind: 'skill',
          status: 'declined',
          label: `Skill registration declined · ${name}`,
        });
      }
      continue;
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Workspace stage grouping + tool-specific presentation helpers.
//
// All helpers below derive ONLY from recorded steps. They never invent
// timestamps, durations, counts, or outcomes: every number comes from the
// steps themselves (args, result, status, durationMs) and every label names
// the recorded tool or its arguments.
// ---------------------------------------------------------------------------

const COMMAND_TOOLS = new Set(['execute_command']);
const READ_TOOLS = new Set(['read_project_file', 'get_single_web_page_content']);
const GIT_TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame']);
const SEARCH_TOOLS = new Set(['search_project_content', 'get_recent_chat_history']);
const EDIT_TOOLS = new Set(['str_replace_editor']);
const WRITE_TOOLS = new Set(['write_project_file', 'git_stage', 'git_unstage', 'git_stash', 'git_sync', 'git_commit', 'git_create_branch', 'git_switch']);
const LIST_TOOLS = new Set(['list_directory', 'list_directory_with_size']);
const SUBAGENT_TOOLS = new Set(['delegate_task', 'spawn_sub_agent', 'extract_web_page_data']);
const MEDIA_TOOLS = new Set(['generate_image', 'take_screenshot']);
const SKILL_TOOLS = new Set(['propose_skill', 'use_skill']);

// Presentation category derived from the recorded tool name only.
export function toolKind(step) {
  const name = step?.toolName;
  if (typeof name !== 'string') return 'other';
  if (name === 'ask_user') return 'question';
  if (SKILL_TOOLS.has(name)) return 'skill';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (READ_TOOLS.has(name)) return 'read';
  if (GIT_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (LIST_TOOLS.has(name)) return 'list';
  if (SUBAGENT_TOOLS.has(name)) return 'subagent';
  if (MEDIA_TOOLS.has(name)) return 'media';
  return 'other';
}

// Short human verb for the row. The exact recorded tool name stays available
// via the `title` tooltip and `data-tool` attribute on the card.
export function toolVerb(step) {
  switch (toolKind(step)) {
    case 'command': return 'Run';
    case 'read': return 'Read';
    case 'search': return 'Search';
    case 'edit': return 'Edit';
    case 'write': return 'Write';
    case 'list': return 'List';
    case 'subagent': return 'Subagent';
    case 'media': return step?.toolName === 'take_screenshot' ? 'Screenshot' : 'Image';
    case 'question': return 'Question';
    case 'skill': return 'Skill';
    default: return step?.toolName || 'Tool';
  }
}

// Split one message's chronological steps into stages at thought boundaries.
// A thought step opens a new stage; following tool steps belong to it until
// the next thought. Leading tools before any thought form a stage with
// thought: null. Order is preserved; nothing is reordered or merged across
// messages.
export function splitStages(steps) {
  const stages = [];
  let current = null;
  const ensure = () => {
    if (!current) {
      current = { key: `stage:${stages.length}`, thought: null, events: [] };
      stages.push(current);
    }
    return current;
  };
  for (const step of steps ?? []) {
    if (!step || typeof step !== 'object') continue;
    if (step.type === 'thought') {
      current = { key: `stage:${stages.length}:${step.id ?? stages.length}`, thought: step, events: [] };
      stages.push(current);
      continue;
    }
    if (step.type !== 'tool_call') continue;
    ensure().events.push(step);
  }
  return stages.filter((stage) => stage.thought || stage.events.length > 0);
}

function distinctStagePaths(events) {
  const seen = [];
  for (const step of events) {
    for (const path of summarizeStep(step).paths) {
      if (!seen.includes(path)) seen.push(path);
    }
  }
  return seen;
}

// Compact stage summary grounded in the stage's own events. Counts record
// what happened; elapsed time is shown only from the thought's recorded
// durationMs (tool steps carry no durations).
export function summarizeStage(stage) {
  const events = stage?.events ?? [];
  const byKind = { command: 0, read: 0, search: 0, edit: 0, write: 0, list: 0, subagent: 0, media: 0, other: 0 };
  let done = 0;
  let failed = 0;
  let blocked = 0;
  let running = 0;
  let cancelled = 0;
  for (const step of events) {
    const kind = toolKind(step);
    if (Object.hasOwn(byKind, kind)) byKind[kind] += 1;
    else byKind.other += 1;
    const key = classifyStep(step).key;
    if (key === 'success') done += 1;
    else if (key === 'failed') failed += 1;
    else if (key === 'blocked') blocked += 1;
    else if (key === 'running') running += 1;
    else if (key === 'cancelled') cancelled += 1;
    else done += 1;
  }
  const files = distinctStagePaths(events);
  const searches = byKind.search;
  const reads = byKind.read + byKind.list;
  const ops = events.length;
  const onlyReads = ops > 0 && byKind.command === 0 && byKind.edit === 0 && byKind.write === 0 && byKind.other === 0 && byKind.subagent === 0 && byKind.media === 0;
  let title;
  if (ops === 0) {
    title = 'Thought';
  } else if (onlyReads) {
    const parts = [];
    if (files.length) parts.push(`${files.length} file${files.length === 1 ? '' : 's'}`);
    if (searches) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
    title = parts.length ? `Explored ${parts.join(', ')}` : `Looked up ${ops} operation${ops === 1 ? '' : 's'}`;
  } else if (byKind.command === ops) {
    title = `Ran ${ops} command${ops === 1 ? '' : 's'}`;
  } else if (byKind.edit > 0 && byKind.command === 0 && byKind.write === 0) {
    title = `Edited ${files.length || byKind.edit} file${(files.length || byKind.edit) === 1 ? '' : 's'}`;
  } else if (byKind.write > 0 && byKind.command === 0 && byKind.edit === 0) {
    title = `Wrote ${byKind.write} file${byKind.write === 1 ? '' : 's'}`;
  } else {
    title = `${ops} operation${ops === 1 ? '' : 's'}`;
  }
  const status = [];
  if (running) status.push(`${running} running`);
  if (failed) status.push(`${failed} failed`);
  if (blocked) status.push('needs approval');
  if (cancelled) status.push(`${cancelled} cancelled`);
  const elapsedMs = typeof stage?.thought?.durationMs === 'number' ? stage.thought.durationMs : null;
  return {
    title,
    ops,
    done,
    failed,
    blocked,
    running,
    cancelled,
    files,
    status,
    elapsedMs,
    counts: byKind,
  };
}

// Line count of a recorded string result (labelled as lines, never matches).
export function resultLineCount(result) {
  if (typeof result === 'string') return result ? result.split('\n').length : 0;
  if (Array.isArray(result)) return result.length;
  return null;
}

// Formatted argument fields for display. Full fidelity stays available via
// the raw JSON <details>; these fields only pick the salient scalars.
export function formatArgFields(step) {
  const args = step?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const str = (value, limit = 120) => {
    if (typeof value !== 'string') return null;
    const single = value.replace(/\s+/g, ' ').trim();
    return single.length > limit ? `${single.slice(0, limit)}…` : single;
  };
  const fields = [];
  const push = (label, value) => {
    if (value) fields.push({ label, value });
  };
  switch (toolKind(step)) {
    case 'command':
      push('Command', str(args.command));
      push('Directory', str(args.cwd, 80));
      break;
    case 'read':
      push('Path', str(args.relative_path ?? args.path, 160));
      break;
    case 'search':
      push('Query', str(args.query));
      if (args.relative_path) push('Scope', str(args.relative_path, 120));
      break;
    case 'edit': {
      push('Path', str(args.relative_path, 160));
      if (typeof args.old_str === 'string' && typeof args.new_str === 'string') {
        push('Change', `${args.old_str.split('\n').length} lines → ${args.new_str.split('\n').length} lines`);
      }
      break;
    }
    case 'write': {
      push('Path', str(args.relative_path, 160));
      if (typeof args.content === 'string') {
        push('Content', `${args.content.split('\n').length} lines, ${args.content.length.toLocaleString()} chars`);
      }
      break;
    }
    case 'list':
      push('Path', str(args.relative_path ?? args.path ?? '.', 160));
      break;
    case 'subagent': {
      push('Task', str(args.task_description));
      if (Array.isArray(args.target_files)) push('Files', `${args.target_files.length} files`);
      push('URL', str(args.url, 120));
      push('Query', str(args.query));
      break;
    }
    case 'media':
      push('Prompt', str(args.prompt));
      push('Display', str(args.display_id, 40));
      break;
    default: {
      for (const [key, value] of Object.entries(args).slice(0, 4)) {
        if (typeof value === 'string') push(key, str(value));
        else if (typeof value === 'number' || typeof value === 'boolean') push(key, String(value));
      }
      break;
    }
  }
  return fields;
}

const TEST_COMMAND_RE = /(vitest|jest|pytest|npm test|npx jest|go test|cargo test|phpunit|rspec|deno test|bun test)/i;

// True only for recorded execute_command steps whose command names a known
// test runner. Callers must still label counts as parsed output.
export function isTestCommand(step) {
  if (step?.toolName !== 'execute_command') return false;
  const command = step?.args?.command;
  return typeof command === 'string' && TEST_COMMAND_RE.test(command);
}

const EXTENSION_LANGUAGES = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java', c: 'c',
  h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', kt: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', html: 'html', css: 'css',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', md: 'markdown',
};

// Best-effort language label from a file path for diff headers. Returns ''
// when unknown; callers render plain monospace in that case.
export function languageOfPath(filePath) {
  if (typeof filePath !== 'string') return '';
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGES[ext] ?? '';
}
