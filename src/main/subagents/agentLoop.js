'use strict';

const path = require('node:path');
// Required through the module object so every model turn visibly goes through
// the Step 3 scheduler (and so tests can observe each turn individually).
const inferenceScheduler = require('./inferenceScheduler');
const { isEngineReady, engineNotReadyError } = require('./providers');

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
// assistant tool_calls without its tool results), and the interrupted tail is
// simply redone on resume. Only this child's own messages are ever in that
// context: a new parent instruction is appended as one more user message, and
// nothing of the parent's conversation is ever copied in.
//
// Termination is bounded three ways: the model returns a final answer without
// tool calls, a configured loop limit is reached (inference turns / tool
// calls), or the execution signal aborts (cancellation or interrupt stops the
// loop before the next turn and never starts another inference).

const CHILD_AGENT_SYSTEM_PROMPT =
  'You are a read-only investigation agent. Work autonomously: investigate the task with the tools provided, '
  + 'then answer directly with your findings in structured markdown. '
  + 'Your tools can only search project files, read files, list directories, and fetch public web pages. '
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
]);

// Runaway guards for one foreground execution. A delegated investigation is
// short by design; the parent chat loop allows far more, and a child must not
// be able to spin forever on a model that keeps requesting tools. This bounds
// the loop only — it is not a token/cost budget for the agent tree.
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 10;
const MAX_LIMIT = 100;
const MAX_TASK_CHARACTERS = 8000;
// Per-turn generation ceiling: aligned with the existing one-shot executions.
const MAX_TURN_TOKENS = 1024;
const TURN_TEMPERATURE = 0.2;
// Final-answer and per-tool-result ceilings: aligned with the existing
// MAX_SUMMARY_CHARACTERS and the web tool's 12,000-character page cap.
const MAX_FINAL_CHARACTERS = 6000;
const MAX_TOOL_RESULT_CHARACTERS = 12000;
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

function accumulateUsage(total, source) {
  for (const key of Object.keys(total)) {
    if (Number.isFinite(source[key])) total[key] += source[key];
  }
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
  const toContent = value => truncate(
    typeof value === 'string' ? value : JSON.stringify(value) ?? String(value),
    MAX_TOOL_RESULT_CHARACTERS,
  );
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
  maxTurns = DEFAULT_MAX_TURNS, maxToolCalls = DEFAULT_MAX_TOOL_CALLS }) {
  const restored = Array.isArray(session?.context) && session.context.length > 0;
  if (!restored && (typeof task !== 'string' || !task.trim() || task.includes('\0') ||
      task.length > MAX_TASK_CHARACTERS)) {
    throw new Error(`task must be a non-empty string of at most ${MAX_TASK_CHARACTERS} characters.`);
  }
  for (const [name, value] of Object.entries({ maxTurns, maxToolCalls })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw new Error(`${name} must be an integer from 1 to ${MAX_LIMIT}.`);
    }
  }
  if (!isEngineReady(engine)) throw engineNotReadyError(engine, 'delegating a task');
  signal?.throwIfAborted();

  const { agentTools } = require('../tools/agentTools');
  // The model only ever sees the allowlisted schemas — a forbidden tool is
  // not merely blocked at execution, it is never advertised.
  const tools = agentTools.filter(tool => CHILD_TOOL_NAMES.includes(tool.function.name));
  const root = path.resolve(rootPath ?? process.cwd());
  // The child's complete context. Nothing outside this array is ever sent.
  // A continuation turn starts from exactly the committed prefix it left off
  // at; a first turn starts from the system prompt and the task.
  const messages = restored
    ? [...session.context]
    : [
      { role: 'system', content: CHILD_AGENT_SYSTEM_PROMPT },
      { role: 'user', content: task },
    ];
  // Commit only at safe boundaries: the seed, a fully-answered tool round,
  // and the final answer. Anything in between (an in-flight round) stays
  // uncommitted, so an interrupt can never leave the persisted context ending
  // in an assistant tool_calls message without its tool results.
  const commit = () => { session.context = messages.slice(); };
  if (!restored) commit();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let sawUsage = false;
  let toolCallCount = 0;

  for (let turn = 1; ; turn += 1) {
    signal?.throwIfAborted();
    if (turn > maxTurns) {
      throw new Error(`Child agent reached the inference-turn limit (${maxTurns}) before producing a final answer.`);
    }
    // Every model turn goes through the Step 3 scheduler; its slot is released
    // when this individual turn settles, so other sessions can interleave
    // between the child's turns if capacity allows.
    const reply = await inferenceScheduler.scheduleInference({
      engine,
      payload: {
        model: engine.modelId,
        messages,
        temperature: TURN_TEMPERATURE,
        max_tokens: MAX_TURN_TOKENS,
        tools,
        tool_choice: 'auto',
      },
      signal,
      fetchImpl,
      allowTools: true,
      recoverContext: require('./contextRecovery').childContextRecovery({ session, messages, engine,
        fetchImpl: fetchImpl ?? require('../localEngineFetch').localEngineFetch, signal, commit }),
    });
    if (!reply.ok) throw new Error(`Child agent request failed (HTTP ${reply.status}).`);
    signal?.throwIfAborted();
    const result = reply.result;
    if (result?.usage) { sawUsage = true; accumulateUsage(usage, result.usage); }
    const message = result?.choices?.[0]?.message;
    const content = textContent(message?.content);
    const toolCalls = normalizeToolCalls(message?.tool_calls);

    if (!toolCalls.length) {
      // Final answer: the model stopped asking for tools.
      const finalAnswer = [content, result?.choices?.[0]?.text, result?.output_text]
        .filter(value => typeof value === 'string').map(value => value.trim()).find(Boolean) || '';
      if (!finalAnswer) {
        if (usage.completion_tokens > 0) {
          return { output: 'Child agent generated tokens but returned no visible answer.', usage: sawUsage ? usage : null };
        }
        throw new Error('Child agent generated no output tokens. Try a simpler task.');
      }
      // The answer becomes part of the child's own context, so a later message
      // turn continues after it instead of pretending the turn never happened.
      const output = truncate(finalAnswer, MAX_FINAL_CHARACTERS);
      messages.push({ role: 'assistant', content: output });
      commit();
      return { output, usage: sawUsage ? usage : null };
    }

    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      signal?.throwIfAborted();
      if (toolCallCount >= maxToolCalls) {
        throw new Error(`Child agent reached the tool-call limit (${maxToolCalls}) before producing a final answer.`);
      }
      toolCallCount += 1;
      const toolContent = await executeChildTool({
        name: call.function.name,
        rawArguments: call.function.arguments,
        rootPath: root,
        signal,
      });
      signal?.throwIfAborted();
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
    }
    // Safe boundary: the round is fully answered, so the context is valid to
    // persist and to resume from if this execution is stopped right here.
    commit();
  }
}

module.exports = {
  runInvestigationExecution,
  CHILD_AGENT_SYSTEM_PROMPT,
  CHILD_TOOL_NAMES,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_TOOL_CALLS,
};
