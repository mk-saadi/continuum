'use strict';

const path = require('node:path');
// Required through the module object so every model turn visibly goes through
// the Step 3 scheduler (and so tests can observe each turn individually).
const inferenceScheduler = require('./inferenceScheduler');
const { isEngineReady, engineNotReadyError } = require('./providers');
const { pushActivity } = require('./sessionManager');
const { escalatedCeiling, estimatePromptTokens } = require('./budgets');
const { combineSignals, isDeadlineError, isRequestTimeoutError } = require('./executionDeadline');
const { COMPLETION, classifyCompletion, stopReasonFor } = require('./completion');

// The child agent loop: one foreground execution that turns a delegated task
// into an investigate -> inspect -> reason -> report cycle instead of a single
// one-shot completion.
//
//   child session -> one foreground execution -> agent loop
//        loop turn: scheduler -> provider -> model
//                  tool call: allowlist -> read-only tool -> tool result
//
// Inference and tool execution stay separate on purpose: every model turn is
// submitted to the inference scheduler (which owns provider/model capacity and
// releases its slot after each individual turn), while tool calls run directly
// against the existing native tool implementations and never enter the
// scheduler. The scheduler schedules generations, not arbitrary work.
//
// The loop owns its conversation context end to end. It is created here from
// exactly: the child system prompt + the task + this loop's own assistant/tool
// messages. Parent conversation history, parent tool calls, parent memory, and
// other child sessions are never read, inherited, or reachable from this
// module — there is no API here that accepts them.
//
// Since Step 6 the context outlives one execution: the child session carries
// `session.context`, and the loop restores it for a continuation turn (a
// parent message or a resume) instead of seeding a fresh [system, task] pair.
// The context is committed only at safe boundaries — after the seed, after a
// complete tool round, and on the final answer — so an execution stopped by an
// interrupt always leaves a protocol-valid prefix behind (never a dangling
// assistant tool_calls without its tool results), and cancelled/interrupted batches are paired with explicit skipped or
// unknown results before committing; completed tools are never replayed on resume. Only this child's own messages are ever in that
// context: a new parent instruction is appended as one more user message, and
// nothing of the parent's conversation is ever copied in.
//
// Termination is bounded three ways: the model returns a final answer without
// tool calls, a configured loop limit is reached (inference turns / tool
// calls), or the execution signal aborts (cancellation or interrupt stops the
// loop before the next turn and never starts another inference).

const CHILD_AGENT_SYSTEM_PROMPT =
  'You are a read-only investigation agent. Work autonomously: investigate the task with the tools provided, '
  + 'then answer directly with your findings in structured markdown. Think briefly, then answer or act — '
  + 'long deliberation consumes the response budget. '
  + 'Your tools can only search project files, read files, list directories, inspect git history (status, diff, log, branches, blame), and fetch public web pages. '
  + 'Editing, writing, running commands, memory, and other capabilities are unavailable to you; a tool error is '
  + 'reported back as an error message, so adapt and continue rather than repeating the same failing call. '
  + 'Once you have gathered enough evidence, stop calling tools and return your final answer. Do not ask follow-up questions.';

// The explicit child tool allowlist. These map 1:1 onto the existing native
// read-only tools — same implementations, same path checks, same bounded
// output the parent already uses. Everything else (write/edit, shell, MCP,
// memory, subagent spawning, approvals) is rejected before execution, and the
// tools are executed under permissionMode 'read_only' as a second, independent
// layer: even a mistake in this list could not reach a non-read tool.
const CHILD_TOOL_NAMES = Object.freeze([
  'search_project_content',
  'read_project_file',
  'list_directory',
  'get_single_web_page_content',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'git_blame',
]);

// Backward-compatible Automatic policy exports; actual limits resolve from
// the saved budget settings once per child lifetime. Phase 1.3A raises the
// default to a long-horizon envelope (see ./budgets.js) so a child can run for
// hundreds of requests/tool calls; a child must still not spin forever on a
// model that keeps requesting tools, and Custom can set a finite limit or the
// explicit unbounded sentinel per field. This bounds the loop only — it is not
// a token/cost budget for the agent tree.
const DEFAULT_MAX_TURNS = require('./budgets').MAX_TURNS.investigation;
const DEFAULT_MAX_TOOL_CALLS = require('./budgets').MAX_TOOL_CALLS.investigation;
const MAX_TASK_CHARACTERS = 8000;
const TURN_TEMPERATURE = 0.2;
// Final-answer and per-tool-result ceilings: aligned with the existing
// MAX_SUMMARY_CHARACTERS and the web tool's 12,000-character page cap.
const MAX_FINAL_CHARACTERS = 6000;
const TRUNCATION_NOTICE = '\n[Truncated]';

/** Plain-text content of a model message, tolerating the array-of-parts form. */
function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n');
    return text || null;
  }
  return null;
}

/**
 * Normalize a response's tool calls into the OpenAI shape the loop stores in
 * its own history. A malformed entry becomes an empty-named call, which the
 * allowlist then rejects — a model can never smuggle a tool past validation
 * by mangling the response shape.
 */
function normalizeToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.filter(call => call && typeof call === 'object').map((call, index) => ({
    id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
    type: 'function',
    function: {
      name: typeof call.function?.name === 'string' ? call.function.name : '',
      arguments: typeof call.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call.function?.arguments ?? {}),
    },
  }));
}

function truncate(text, maxCharacters) {
  if (text.length <= maxCharacters) return text;
  return text.slice(0, Math.max(0, maxCharacters - TRUNCATION_NOTICE.length)) + TRUNCATION_NOTICE;
}


/**
 * Validate one tool call against the child allowlist, then execute it through
 * the existing native tool implementation. Never throws: every outcome —
 * forbidden tool, invalid arguments, failed read/search — comes back as a
 * string that is fed to the model as the tool result, so a failing read-only
 * tool degrades the child's answer instead of crashing the parent session.
 * Cancellation is the one exception: it is rethrown as a real abort.
 */
async function executeChildTool({ name, rawArguments, rootPath, signal }) {
  const toContent = value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  if (!CHILD_TOOL_NAMES.includes(name)) {
    return toContent(`Error: Tool "${name || ''}" is not available to this agent. `
      + `Allowed tools: ${CHILD_TOOL_NAMES.join(', ')}.`);
  }
  // Lazy require: the loop shares the application's tool registry rather than
  // carrying its own copies of the read/search/list implementations.
  const { executeAgentTool } = require('../tools/agentTools');
  let output;
  try {
    // sessionId is null: the child session is not a database chat session, so
    // it derives no project, no history, and no permissions from the parent.
    // rootPath is the explicit project root of this execution, honored only
    // for read-only tools inside executeAgentTool.
    output = await executeAgentTool({
      name,
      arguments: rawArguments,
      sessionId: null,
      permissionMode: 'read_only',
      rootPath,
      signal,
    });
  } catch (error) {
    return toContent(`Error: ${error?.message ?? error}`);
  }
  signal?.throwIfAborted(); // a tool cancelled mid-run is a cancellation, not a result
  if (output && typeof output === 'object' && output.type === 'image_url') {
    // Never push binary payloads into a text-only child context.
    return toContent({ file_path: output.file_path, note: 'Image content is not available to this text-only agent.' });
  }
  if (output && typeof output === 'object' && output.success === false) {
    return toContent(`Error: ${output.error ?? 'The tool failed.'}`);
  }
  // Same untrusted-web handling the parent applies to web tool results.
  const { sanitizeWebToolResult } = require('../tools/webSearch');
  return toContent(sanitizeWebToolResult(output, name));
}

/**
 * One multi-turn investigation execution inside an existing subagent session.
 * Maintains the child's own isolated context (system prompt + task + this
 * loop's tool calls/results only), sends every model turn through the
 * inference scheduler, validates each tool call against the child allowlist,
 * and finishes on a final answer, a loop limit, an inference error, or
 * cancellation/interrupt. Returns { output, usage } with usage summed across
 * this execution's turns. `session` is the owning child session recorded by
 * the runtime.
 *
 * Continuation (Step 6): when the session already carries a context, this is a
 * resumed/message turn — the existing context is restored verbatim and the
 * loop continues it instead of seeding a new task, so the child keeps its own
 * history, tool results, and previous answers across any number of turns.
 */
async function runInvestigationExecution({ session, task, rootPath, engine, signal, fetchImpl,
  maxTurns, maxToolCalls, budgetScope, deadline = null, timers }) {
  const budget = require('./executionBudget');
  const restored = Array.isArray(session?.context) && session.context.length > 0;
  if (!restored && (typeof task !== 'string' || !task.trim() || task.includes('\0') || task.length > MAX_TASK_CHARACTERS)) {
    throw new Error(`task must be a non-empty string of at most ${MAX_TASK_CHARACTERS} characters.`);
  }
  if (!isEngineReady(engine)) throw engineNotReadyError(engine, 'delegating a task');
  signal?.throwIfAborted();
  const state = await budget.getExecutionBudget(session, { kind: 'investigation', engine, budgetScope, maxTurns, maxToolCalls });
  // The child resolves reasoning from its OWN effective model settings, never
  // the parent chat's session overrides or wire parameters.
  const childReasoning = await require('../reasoningRuntime').resolveChildReasoning({ engine });
  const reasoningFields = require('../reasoningRuntime').requestFieldsForEngine(engine, childReasoning);
  // The runtime arms the child's execution deadline and forwards it here (see
  // ../index.js and ../continuationManager.js), so cleanup runs in the runtime's
  // finally and a nested child inherits the parent's deadline. A direct call
  // with no deadline has no wall-clock limit — cancellation stays available.
  const executionDeadline = deadline ?? null;
  // `signal` is the run's cancellation signal (user/parent action) and must stay
  // distinguishable from the deadline. `activeSignal` carries both, so requests,
  // tools and compaction abort on either, while classification uses the raw one.
  const activeSignal = combineSignals(signal, executionDeadline?.signal) ?? signal;
  const deadlineExpired = () => executionDeadline?.signal.aborted === true;
  const { agentTools } = require('../tools/agentTools');
  const tools = agentTools.filter(tool => CHILD_TOOL_NAMES.includes(tool.function.name));
  const root = path.resolve(rootPath ?? process.cwd());
  const messages = restored ? [...session.context] : [
    { role: 'system', content: CHILD_AGENT_SYSTEM_PROMPT }, { role: 'user', content: task },
  ];
  const commit = () => { session.context = messages.slice(); };
  const context = require('./contextRecovery').createChildContextAdapter({ session, messages, engine, state, fetchImpl, signal: activeSignal, commit });
  context.persist();
  let ceiling = state.budgets.perRequestCeiling;
  let incompleteRetries = 0;
  let stopReason = null;
  let finalizing = false;
  const findings = () => session.rawContext.filter(m => m.role === 'tool' && !/^Error:|^\[Tool skipped/.test(m.content ?? ''));
  const fallback = () => findings().slice(-6).map(m => `Tool evidence (${m.tool_call_id}): ${m.content.slice(0, 700)}`).join('\n\n');
  const finish = (output, reason = 'completed', hasFindings = !!output?.trim(), detail = null, completionClass = null) => {
    const result = budget.outcome(state, { output: truncate(output || fallback(), MAX_FINAL_CHARACTERS),
      stopReason: reason, findings: hasFindings || findings().length > 0, detail, completionClass });
    context.append({ role: 'assistant', content: result.output }); context.persist();
    return result;
  };
  for (;;) {
    signal?.throwIfAborted();
    // No new work once the deadline has elapsed: return a timeout result (never
    // a throw, never a success), preserving any findings already gathered.
    if (deadlineExpired()) return finish('', 'timed_out', findings().length > 0, 'The child execution deadline was exceeded.');
    stopReason ??= budget.exhaustion(state);
    // Reserve the last configured request for reporting rather than issuing an
    // extra request after the ceiling. Unbounded turns never trigger this.
    if (!stopReason && budget.limitReached(state.budgets.maxTurns, budget.totals(state).turns + 1)) stopReason = 'turn_limit';
    if (stopReason && !finalizing) {
      if (state.finalizationAttempted || budget.limitReached(state.budgets.maxTurns, budget.totals(state).turns) ||
          (!findings().length && stopReason !== 'turn_limit')) return finish('', stopReason, false);
      finalizing = true;
      state.finalizationAttempted = true;
      context.append({ role: 'system', content: `Execution stopped: ${stopReason}. Tools are unavailable. Report only findings already supported by the task and tool evidence, and clearly state incomplete work. Do not invent findings.` });
    }
    const requestTools = finalizing ? [] : tools;
    let reply;
    try {
      let payload = { model: engine.modelId, messages, temperature: TURN_TEMPERATURE,
        max_tokens: finalizing ? Math.min(ceiling, 1024) : ceiling, tools: requestTools, tool_choice: finalizing ? 'none' : 'auto',
        ...reasoningFields };
      payload = await context.prepare(payload);
      // Summary/checkpoint requests can consume ordinary-turn capacity. Honor
      // the Phase 1 reporting slot after compaction as well as before it.
      if (!finalizing && (budget.exhaustion(state) || budget.limitReached(state.budgets.maxTurns, budget.totals(state).turns + 1))) {
        stopReason = budget.exhaustion(state) ?? 'turn_limit'; continue;
      }
      let recovered = false;
      for (;;) {
        const measured = context.lastMeasurement;
        payload = budget.stopBeforeRequest(state, payload,
          measured?.method === 'server-template-tokenizer' ? measured.tokens : undefined, measured?.limit);
        pushActivity(session, { type: 'turn', turn: budget.totals(state).turns + 1 });
        try {
          reply = await inferenceScheduler.scheduleInference({ session, engine, payload,
            signal: activeSignal, fetchImpl, allowTools: !finalizing, budgetState: state, timers });
          break;
        } catch (error) {
          signal?.throwIfAborted();
          // Recovery runs after scheduler settlement releases the local lane.
          // Never schedule a summarizer recursively while holding its slot.
          if (!error?.confirmedOverflow || recovered) throw error;
          recovered = true;
          payload = await context.prepare(payload, true, error.contextWindowLimit);
        }
      }
      if (!reply.ok) {
        if (finalizing) state.finalizationStopReason = 'provider_error';
        return finish('', stopReason ?? 'provider_error', false, `Child agent request failed (HTTP ${reply.status}).`);
      }
    } catch (error) {
      // Raw cancellation (user/parent) always wins over a clock event.
      signal?.throwIfAborted();
      if (deadlineExpired() || isDeadlineError(error)) {
        return finish('', 'timed_out', findings().length > 0, 'The child execution deadline was exceeded.');
      }
      // A single model-request timeout is terminal (never retried) and maps to
      // the explicit request_timeout stop reason; findings are preserved.
      if (isRequestTimeoutError(error)) {
        if (finalizing) state.finalizationStopReason = 'request_timeout';
        return finish('', 'request_timeout', findings().length > 0, `The model request timed out (${error.timeoutKind ?? 'total'}).`);
      }
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
      const reason = budget.reasonOf(error);
      if (finalizing) state.finalizationStopReason = reason;
      if (!finalizing && findings().length && !['provider_budget_violation', 'context_exhausted', 'compaction_failed', 'provider_error'].includes(reason)) {
        stopReason = reason; continue;
      }
      return finish('', stopReason ?? reason, false);
    }
    signal?.throwIfAborted();
    // A deadline that elapsed while the request was in flight wins over a late
    // response (or one from a transport that ignored the abort): the result is
    // discarded and no further work is derived from it.
    if (deadlineExpired()) return finish('', 'timed_out', findings().length > 0, 'The child execution deadline was exceeded.');
    const result = reply.result;
    if (state.overrun) return finish('', state.overrun, false);
    const message = result?.choices?.[0]?.message;
    const content = textContent(message?.content) || result?.choices?.[0]?.text || result?.output_text;
    const calls = normalizeToolCalls(message?.tool_calls);
    // Phase 1.5: one backend-aware completion verdict for this turn. A provider
    // that spells truncation differently (`max_tokens`), a filtered turn, or a
    // stream that ended without a terminal marker must never be a success.
    const finishReason = result?.choices?.[0]?.finish_reason;
    const streamInterrupted = message?.streamInterrupted === true;
    const completion = classifyCompletion({ finishReason, streamInterrupted });
    if (message?.toolMarkupIncomplete) {
      if (finalizing) state.finalizationStopReason = 'malformed_response';
      return finish('', stopReason ?? 'malformed_response', false, 'The model emitted incomplete tool markup.', completion);
    }
    const turn = budget.totals(state).turns;
    const thought = message?.reasoning_content ?? message?.reasoning;
    if (typeof thought === 'string' && thought.trim()) pushActivity(session, { type: 'thought', turn, text: thought });
    // A stream that ended without [DONE] or a finish reason may have truncated
    // the tool arguments. Never dispatch a call parsed from an incomplete
    // stream: pair the batch with explicit skipped results (so the committed
    // transcript stays protocol-valid) and report the turn as malformed.
    if (streamInterrupted && calls.length) {
      state.blockedCalls += calls.length;
      context.append({ role: 'assistant', content: content || null, tool_calls: calls });
      for (const call of calls) context.append({ role: 'tool', tool_call_id: call.id,
        content: '[Tool skipped: interrupted stream] The tool call was not fully received; it was never executed.' });
      context.persist();
      if (finalizing) state.finalizationStopReason = 'malformed_response';
      return finish('', stopReason ?? 'malformed_response', false,
        'The model stream ended before the tool call finished; no tool was executed.', completion);
    }
    if (finalizing) {
      // Some providers ignore tool_choice:none. Pair their calls with skipped
      // results, commit the batch, and never dispatch or retry finalization.
      if (calls.length) {
        state.finalizationStopReason = 'malformed_response';
        state.blockedCalls += calls.length;
        context.append({ role: 'assistant', content: content || null, tool_calls: calls });
        for (const call of calls) context.append({ role: 'tool', tool_call_id: call.id,
          content: `[Tool skipped: ${stopReason}] Tools are disabled during finalization.` });
        context.persist();
        return finish('', stopReason, false);
      }
      const visible = typeof content === 'string' && content.trim() ? content.trim() : '';
      state.finalizationStopReason = visible ? 'completed' : 'empty_response';
      return finish(visible, stopReason, !!visible);
    }
    if (!calls.length) {
      const visible = typeof content === 'string' ? content.trim() : '';
      if (visible) return finish(visible, stopReasonFor(completion), true, null, completion);
      // No visible answer. The bounded continuation covers every no-content
      // shape — a truncated, filtered or interrupted turn AND a clean-but-empty
      // stop — at most once; a truly truncated turn escalates its ceiling first.
      if (incompleteRetries++ < 1) {
        if (completion === COMPLETION.TRUNCATED) {
          ceiling = escalatedCeiling(ceiling, state.budgets, state.ledger, estimatePromptTokens(messages, tools)) ?? ceiling;
        }
        // A repeated identical request would saturate the same ceiling again
        // (docs/SESSION-HANDOFF.md). Append a forced-answer instruction so the
        // bounded continuation is a different request, not a futile replay.
        const { FORCED_ANSWER_SYSTEM } = require('./executionManager');
        context.append({ role: 'system', content: FORCED_ANSWER_SYSTEM });
        pushActivity(session, { type: 'note', turn, text: `No visible answer (${completion}); one bounded continuation without replaying tools.` });
        continue;
      }
      return finish('', completion === COMPLETION.COMPLETE ? 'empty_response' : 'incomplete_response', false,
        completion === COMPLETION.COMPLETE ? null : `The model stopped without a visible answer (completion=${completion}).`, completion);
    }
    const ids = calls.map(c => c.id);
    if (new Set(ids).size !== ids.length) return finish('', 'malformed_response', false);
    context.append({ role: 'assistant', content: content || null, tool_calls: calls });
    let batchReason = null;
    for (const call of calls) {
      // Even cancellation leaves a truthful, paired committed transcript for
      // already executed tools. It never resumes by replaying a partial batch.
      let skipped = signal?.aborted ? 'cancelled' : deadlineExpired() ? 'timed_out' : batchReason;
      // The first denied call is charged by dispatchTool; subsequent calls
      // inherit the batch stop without entering that gate, but are still
      // distinct blocked attempts for accounting and the transcript UI.
      if (['tool_limit', 'aggregate_tool_limit'].includes(skipped)) state.blockedCalls++;
      if (!skipped) {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { args = null; }
        const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
        const signature = JSON.stringify([call.function.name, canonical(args)]);
        const repeated = (state.seenCalls.get(signature) ?? 0) + 1;
        state.seenCalls.set(signature, repeated);
        // Detect attempts, never reuse tool output or assume unchanged state.
        if (repeated >= 3) skipped = 'no_progress';
        else if (!CHILD_TOOL_NAMES.includes(call.function.name) || !args || typeof args !== 'object' || Array.isArray(args)) skipped = 'invalid_tool';
        else skipped = budget.dispatchTool(state, session, call.function.name);
      }
      let toolContent;
      if (skipped) {
        if (skipped !== 'invalid_tool') batchReason ??= skipped;
        state.blockedCalls += ['no_progress', 'invalid_tool', 'cancelled'].includes(skipped) ? 1 : 0;
        toolContent = skipped === 'invalid_tool'
          ? `Error: Tool "${call.function.name}" is not available to this agent or its arguments are invalid. This call was not executed.`
          : `[Tool skipped: ${skipped}] This requested tool was not executed.`;
      } else {
        pushActivity(session, { type: 'tool', turn, name: call.function.name, arguments: call.function.arguments });
        try {
          toolContent = await executeChildTool({ name: call.function.name, rawArguments: call.function.arguments, rootPath: root, signal: activeSignal });
        } catch (error) {
          toolContent = 'Error: Tool execution was interrupted; its outcome is unknown and it will not be replayed.';
          batchReason = signal?.aborted ? 'cancelled' : deadlineExpired() ? 'timed_out' : 'runtime_error';
        }
        pushActivity(session, { type: 'tool-result', turn, name: call.function.name,
          ok: !toolContent.startsWith('Error:'), chars: toolContent.length });
      }
      const projected = require('./contextRecovery').trimToolResult(toolContent, { task: task ?? session.inputSummary?.task ?? '', contextLength: state.budgets.contextLength });
      context.append({ role: 'tool', tool_call_id: call.id, content: projected }, toolContent);
    }
    context.persist();
    signal?.throwIfAborted();
    stopReason = batchReason ?? budget.exhaustion(state);
  }
}

module.exports = {
  runInvestigationExecution,
  CHILD_AGENT_SYSTEM_PROMPT,
  CHILD_TOOL_NAMES,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_TOOL_CALLS,
};
