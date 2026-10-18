'use strict';
// Phase 1.5 — completion reporting and streaming reliability.
//
// Deterministic and model-free: every provider shape is scripted, so the test
// asserts exact classifications rather than trusting a live model. It covers
// the two false-completion defects Phase 1.5 fixes (a non-`length` truncation
// reported as completed, and an interrupted SSE stream reported as completed)
// plus the surrounding guarantees: no tool dispatch from an interrupted stream,
// a bounded continuation for every no-visible-content turn, and a structured
// completion verdict in the terminal accounting.
//
// Run with: node --test tests/subagentCompletionReliability.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-completion-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};

const db = require('../src/main/db');
db.initDatabase(directory);
const settings = require('../src/main/subagents/budgetSettings');
const completion = require('../src/main/subagents/completion');
const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
const { runFileAnalysisExecution } = require('../src/main/subagents/executionManager');
const { readCompletion } = require('../src/main/subagents/providers/streamCompletion');

const engine = { provider: 'local', port: 9, modelId: 'fixture', contextLength: 32768 };
const { COMPLETION } = completion;

const json = (content, finish_reason = 'stop', extra = {}) => Response.json({
  choices: [{ finish_reason, message: { content, ...extra } }],
  usage: { prompt_tokens: 50, completion_tokens: 10 },
});
const sseBody = frames => frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
const sse = frames => new Response(sseBody(frames), { headers: { 'Content-Type': 'text/event-stream' } });
const toolCall = (id, name = 'list_directory', args = {}) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function script(responses) {
  const requests = [];
  return { requests, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length, 'unexpected extra generation');
    return responses.shift();
  } };
}
function configure(patch = { }) {
  settings.saveBudgetSettings({ mode: 'custom', maxInputTokens: null, maxOutputTokens: null,
    maxToolCalls: null, maxTurns: null, maxAggregateToolCalls: null, ...patch });
}
const run = (session, s, options = {}) =>
  runInvestigationExecution({ session, task: 'Inspect the project.', rootPath: directory, engine, ...s, ...options });

test.beforeEach(() => configure());
test.after(() => { db.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

// ---- Pure classification -----------------------------------------------------

test('every backend finish vocabulary classifies truthfully', () => {
  for (const reason of ['stop', 'end_turn', 'stop_sequence', 'eos', 'eos_token', 'completed', 'complete',
    null, undefined, '', 'something-new']) {
    assert.equal(completion.classifyCompletion({ finishReason: reason }), COMPLETION.COMPLETE, String(reason));
  }
  for (const reason of ['length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens',
    'token_limit', 'length_limit', 'truncated', 'MAX_TOKENS']) {
    assert.equal(completion.classifyCompletion({ finishReason: reason }), COMPLETION.TRUNCATED, reason);
  }
  for (const reason of ['content_filter', 'content-filter', 'safety', 'blocked', 'prohibited_content']) {
    assert.equal(completion.classifyCompletion({ finishReason: reason }), COMPLETION.FILTERED, reason);
  }
  // Interruption outranks any finish reason that may have been seen earlier.
  assert.equal(completion.classifyCompletion({ finishReason: 'stop', streamInterrupted: true }), COMPLETION.INTERRUPTED);
  assert.equal(completion.stopReasonFor(COMPLETION.COMPLETE), 'completed');
  for (const kind of [COMPLETION.TRUNCATED, COMPLETION.FILTERED, COMPLETION.INTERRUPTED]) {
    assert.equal(completion.stopReasonFor(kind), 'incomplete_response');
  }
});

// ---- Streaming identity ------------------------------------------------------

test('an SSE stream that ends without [DONE] or a finish reason is flagged interrupted', async () => {
  const interrupted = await readCompletion(sse([{ choices: [{ delta: { content: 'PARTIAL' } }] }]));
  assert.equal(interrupted.choices[0].message.streamInterrupted, true);

  const done = await readCompletion(new Response(sseBody([
    { choices: [{ delta: { content: 'CLEAN' } }] }, '[DONE]',
  ]), { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(done.choices[0].message.streamInterrupted, undefined);

  const finished = await readCompletion(sse([
    { choices: [{ delta: { content: 'CLEAN' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  assert.equal(finished.choices[0].message.streamInterrupted, undefined);

  // A JSON body is never a stream; it carries no interruption flag.
  const plain = await readCompletion(Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }));
  assert.equal(plain.choices[0].message.streamInterrupted, undefined);

  // An empty stream is a genuinely empty completion, not a false interruption.
  const empty = await readCompletion(new Response('', { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(empty.choices[0].message.streamInterrupted, undefined);
});

// ---- Agent loop: no false completion ----------------------------------------

test('truncated and filtered answers with visible content are never reported completed', async () => {
  for (const [label, reason, expectedClass] of [
    ['max_tokens', 'max_tokens', COMPLETION.TRUNCATED],
    ['length', 'length', COMPLETION.TRUNCATED],
    ['content_filter', 'content_filter', COMPLETION.FILTERED],
  ]) {
    const session = {}; const s = script([json('PARTIAL ANSWER.', reason)]);
    const result = await run(session, s);
    assert.notEqual(result.outcome, 'completed', label);
    assert.equal(result.outcome, 'partial', label);
    assert.equal(result.stopReason, 'incomplete_response', label);
    assert.equal(result.completionClass, expectedClass, label);
    assert.equal(s.requests.length, 1, `${label}: a visible partial answer must not be retried`);
    assert.match(result.output, /PARTIAL ANSWER\./);
  }
});

test('a clean finish with visible content still completes', async () => {
  const session = {}; const s = script([json('FINAL ANSWER.', 'stop')]);
  const result = await run(session, s);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.completionClass, COMPLETION.COMPLETE);
  assert.equal(result.accounting.completionClass, COMPLETION.COMPLETE);
  assert.equal(result.accounting.evidence, true);
});

test('an interrupted stream with content is incomplete, never completed', async () => {
  const session = {}; const s = script([sse([{ choices: [{ delta: { content: 'PARTIAL ANSWER' } }] }])]);
  const result = await run(session, s);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.stopReason, 'incomplete_response');
  assert.equal(result.completionClass, COMPLETION.INTERRUPTED);
  assert.match(result.output, /PARTIAL ANSWER/);
});

test('an interrupted stream carrying a tool call is refused without any dispatch', async () => {
  const tools = require('../src/main/tools/agentTools');
  const execute = tools.executeAgentTool;
  let effects = 0;
  tools.executeAgentTool = async () => { effects += 1; return 'evidence'; };
  try {
    const session = {};
    // The argument JSON is deliberately cut mid-string and the stream ends
    // without a finish reason: exactly what a dropped connection produces.
    const s = script([sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'x1', function: { name: 'list_directory', arguments: '{"relative_path":".' } },
    ] } }] }])]);
    const result = await run(session, s);
    assert.equal(effects, 0, 'no tool may run from a half-received stream');
    assert.equal(session.budgetState.toolCalls, 0);
    assert.equal(result.stopReason, 'malformed_response');
    assert.equal(result.completionClass, COMPLETION.INTERRUPTED);
    // The batch is paired with an explicit skipped result: protocol-valid and replay-safe.
    const toolMessages = session.context.filter(message => message.role === 'tool');
    assert.equal(toolMessages.length, 1);
    assert.match(toolMessages[0].content, /interrupted stream/i);
  } finally {
    tools.executeAgentTool = execute;
  }
});

// ---- Bounded continuation for every no-content shape -------------------------

test('a clean-but-empty stop is retried once and never becomes a completed child', async () => {
  const session = {}; const s = script([json(null, 'stop'), json(null, 'stop')]);
  const result = await run(session, s);
  assert.equal(s.requests.length, 2, 'exactly one bounded continuation');
  assert.equal(result.stopReason, 'empty_response');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.accounting.evidence, false);
});

test('a transient empty stop recovers on the single bounded continuation', async () => {
  const session = {}; const s = script([json(null, 'stop'), json('Recovered.', 'stop')]);
  const result = await run(session, s);
  assert.equal(s.requests.length, 2);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.output, 'Recovered.');
});

test('reasoning-only turns never report completed without visible content', async () => {
  const session = {};
  const s = script([
    json(null, 'stop', { reasoning_content: 'thinking very hard' }),
    json(null, 'max_tokens', { reasoning_content: 'still thinking' }),
  ]);
  const result = await run(session, s);
  assert.equal(s.requests.length, 2);
  assert.notEqual(result.outcome, 'completed');
  assert.equal(result.stopReason, 'incomplete_response');
  assert.equal(result.completionClass, COMPLETION.TRUNCATED);
});

// ---- One-shot executions -----------------------------------------------------

test('one-shot completions cannot report a truncated or filtered answer as complete', async () => {
  fs.writeFileSync(path.join(directory, 'oneshot.txt'), 'source evidence text');
  for (const [label, reason, expectedClass] of [
    ['max_tokens', 'max_tokens', COMPLETION.TRUNCATED],
    ['content_filter', 'content_filter', COMPLETION.FILTERED],
  ]) {
    const session = {}; const s = script([json(`PARTIAL SUMMARY (${label}).`, reason)]);
    const result = await runFileAnalysisExecution({
      session, task_description: 'Summarize the file.', target_files: ['oneshot.txt'],
      rootPath: directory, engine, fetchImpl: s.fetchImpl,
    });
    assert.equal(result.stopReason, 'incomplete_response', label);
    assert.equal(result.completionClass, expectedClass, label);
    assert.equal(s.requests.length, 1, `${label}: a visible partial summary must not be retried`);
    assert.match(result.output, /PARTIAL SUMMARY/);
  }
  // A clean one-shot answer is still a normal completed child.
  const session = {}; const s = script([json('Complete summary.', 'stop')]);
  const ok = await runFileAnalysisExecution({
    session, task_description: 'Summarize the file.', target_files: ['oneshot.txt'],
    rootPath: directory, engine, fetchImpl: s.fetchImpl,
  });
  assert.equal(ok.outcome, 'completed');
  assert.equal(ok.completionClass, COMPLETION.COMPLETE);
});
