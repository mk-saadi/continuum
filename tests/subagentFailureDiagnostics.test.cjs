const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/main/subagents');
const sessionManager = require('../src/main/subagents/sessionManager');
const { executeSpawnSubagent, spawnSubagentTool } = require('../src/main/tools/subagent');

// Focused regressions for the three sub-agent failures under audit:
//   1. a normal small file-analysis task returns text,
//   2. an empty provider completion fails with distinguishable diagnostics
//      after exactly one bounded retry,
//   3. a web-research task without url/target_file fails with actionable
//      guidance (the tool is fetch-only; there is no web search),
//   4. a direct URL extraction success path,
//   5. URL extraction with no content reports WHICH stage failed.
const engine = { port: 4321, modelId: 'local-model', contextLength: 32768 };

function completion({ content, finishReason = 'stop', usage, message: extraMessage = {} }) {
  return Response.json({
    choices: [{ message: { role: 'assistant', content, ...extraMessage }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
}

async function expectRejection(promise, label) {
  return promise.then(
    () => assert.fail(`${label}: expected a rejection`),
    error => error,
  );
}

test('1. a normal small file-analysis subagent returns text', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-small-file-'));
  try {
    await fs.writeFile(path.join(rootPath, 'ToolLimitToast.jsx'),
      'export default function ToolLimitToast({ limit, onError }) {\n'
      + '  if (!limit) return null;\n  return <div onClick={onError}>{limit}</div>;\n}\n');
    const payloads = [];
    const output = await runtime.runFileAnalysis({
      task_description: 'Analyze this source file thoroughly: ToolLimitToast.jsx. Cover: purpose, key '
        + 'components/states, props passed to/from it, notable patterns, and any issues. Keep it concise.',
      target_files: ['ToolLimitToast.jsx'],
      rootPath,
      engine,
      parentSessionId: 'diag_ok',
      fetchImpl: async (_url, options) => {
        payloads.push(JSON.parse(options.body));
        return completion({
          content: '- Purpose: shows the tool-limit warning toast.\n- Props: limit, onError.',
          usage: { prompt_tokens: 210, completion_tokens: 96, total_tokens: 306 },
        });
      },
    });
    assert.equal(output, '- Purpose: shows the tool-limit warning toast.\n- Props: limit, onError.');
    assert.equal(payloads.length, 1, 'a successful completion must not be retried');
    assert.match(payloads[0].messages[1].content, /\[FILE: ToolLimitToast\.jsx\]/);
    const session = sessionManager.listSessions().find(item => item.parentSessionId === 'diag_ok');
    assert.equal(session.status, 'completed');
    assert.equal(session.error, null);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('2. an empty provider completion fails with per-attempt diagnostics after one bounded retry', async () => {
  const base = { task_description: 'Summarize', target_files: [], rootPath: process.cwd(), engine };

  // (a) A genuinely empty completion: 200, empty content, zero output tokens.
  let calls = 0;
  const emptyError = await expectRejection(runtime.runFileAnalysis({
    ...base,
    parentSessionId: 'diag_empty',
    fetchImpl: async () => {
      calls += 1;
      return completion({ content: '', usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 } });
    },
  }), 'empty completion');
  assert.equal(calls, 2, 'exactly one bounded retry, never a retry loop');
  assert.match(emptyError.message, /no output tokens/);
  assert.match(emptyError.message, /attempt 1/);
  assert.match(emptyError.message, /attempt 2/);
  assert.match(emptyError.message, /finish_reason="stop"/);
  assert.match(emptyError.message, /completion_tokens=0/);
  assert.ok(!/smaller, more specific/i.test(emptyError.message),
    'the failure must not blame the task size');
  // The same diagnostics are recorded on the child session for observability.
  const failedSession = sessionManager.listSessions().find(item => item.parentSessionId === 'diag_empty');
  assert.equal(failedSession.status, 'failed');
  assert.match(failedSession.error, /no output tokens/);
  assert.match(failedSession.error, /completion_tokens=0/);

  // (b) A transient empty completion is recovered by the bounded retry: the
  // same task returns text on attempt 2, proving normal completions still work.
  let sequence = 0;
  const recovered = await runtime.runFileAnalysis({
    ...base,
    parentSessionId: 'diag_retry',
    fetchImpl: async () => {
      sequence += 1;
      return sequence === 1
        ? completion({ content: '' })
        : completion({ content: 'Recovered summary', usage: { completion_tokens: 7 } });
    },
  });
  assert.equal(recovered, 'Recovered summary');
  assert.equal(sequence, 2, 'one empty attempt, one successful retry');

  // (c) Different empty causes stay distinguishable: reasoning-only output with
  // no usage report is labelled as such instead of a generic no-tokens message.
  let reasonCalls = 0;
  const reasoningError = await expectRejection(runtime.runFileAnalysis({
    ...base,
    parentSessionId: 'diag_reasoning',
    fetchImpl: async () => {
      reasonCalls += 1;
      return completion({ content: null, finishReason: 'length',
        message: { reasoning_content: 'x'.repeat(400) } });
    },
  }), 'reasoning-only completion');
  assert.equal(reasonCalls, 2, 'still exactly one bounded retry');
  assert.match(reasoningError.message, /no output tokens/);
  assert.match(reasoningError.message, /finish_reason="length"/);
  assert.match(reasoningError.message, /reasoning_content=400 chars/);
  assert.match(reasoningError.message, /usage=missing/);
});

test('3. a web-research task without url or target_file fails with actionable guidance', async () => {
  const error = await expectRejection(executeSpawnSubagent({
    task: 'Find the actual VRAM/memory requirements to run Qwen 3 177B or QwQ-32B or similar Qwen models '
      + 'at Q4 quantization.',
    engine,
  }), 'url-less web research task');
  // The parameter guidance stays (existing callers match on it) and now states
  // WHY the shape is invalid: the tool is fetch-only, not search-capable.
  assert.match(error.message, /Provide a url or target_file parameter/);
  assert.match(error.message, /cannot search or discover pages/);
  assert.match(error.message, /investigate/);
  // The supported web behavior is documented on the tool itself.
  assert.match(spawnSubagentTool.function.description, /isolated web research/);
  assert.match(spawnSubagentTool.function.description, /cannot search or discover pages/);
  assert.match(spawnSubagentTool.function.parameters.properties.url.description, /no web search/i);
});

test('4. a direct URL extraction returns the answer from the fetched page', async () => {
  let payload;
  let modelCalls = 0;
  const output = await runtime.runWebExtraction({
    url: 'https://example.com/quantization',
    query: 'What is the Q4 VRAM requirement?',
    engine,
    parentSessionId: 'diag_url_ok',
    pageFetchImpl: async () => new Response(
      '<article><p>Q4 quantization of a 32B model needs about 20 GB of VRAM.</p></article>',
      { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async (_url, options) => {
      modelCalls += 1;
      payload = JSON.parse(options.body);
      return completion({ content: 'About 20 GB of VRAM at Q4.', usage: { completion_tokens: 12 } });
    },
  });
  assert.equal(output, 'About 20 GB of VRAM at Q4.');
  assert.equal(modelCalls, 1, 'a successful extraction must not be retried');
  assert.equal(payload.temperature, 0);
  assert.equal(payload.max_tokens, 450);
  assert.match(payload.messages[1].content, /20 GB of VRAM/);
  const session = sessionManager.listSessions().find(item => item.parentSessionId === 'diag_url_ok');
  assert.equal(session.status, 'completed');
});

test('5. URL extraction with no content reports which stage failed', async () => {
  // (a) Page-content failure: the fetch succeeds but nothing readable comes
  // out (client-rendered page). The model must not be called, and the error
  // names the URL and the page-content cause.
  const pageError = await expectRejection(runtime.runWebExtraction({
    url: 'https://client-rendered.example/app',
    query: 'What is on the page?',
    engine,
    parentSessionId: 'diag_nopage',
    pageFetchImpl: async () => new Response(
      '<html><head><script>window.boot();</script></head><body></body></html>',
      { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async () => assert.fail('the model must not be called without page text'),
  }), 'empty page');
  assert.match(pageError.message, /no readable text/i);
  assert.match(pageError.message, /client-rendered/);
  assert.match(pageError.message, /https:\/\/client-rendered\.example\/app/);
  assert.match(pageError.message, /model was never called/);

  // (b) Empty-answer failure: the page WAS fetched and readable, but the model
  // returned no answer. Reported as the model stage — with attempt
  // diagnostics — not as a page or fetch failure.
  let calls = 0;
  const answerError = await expectRejection(runtime.runWebExtraction({
    url: 'https://example.com/story',
    query: 'When does it launch?',
    engine,
    parentSessionId: 'diag_noanswer',
    pageFetchImpl: async () => new Response(
      '<article><p>The launch date is 1 October.</p></article>',
      { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async () => {
      calls += 1;
      return completion({ content: '   ', usage: { completion_tokens: 0 } });
    },
  }), 'empty model answer');
  assert.equal(calls, 2, 'one bounded retry for the empty model answer');
  assert.match(answerError.message, /Web extractor returned no answer/);
  assert.match(answerError.message, /page was fetched and readable/);
  assert.match(answerError.message, /attempt 1/);
  assert.match(answerError.message, /attempt 2/);
  assert.match(answerError.message, /finish_reason="stop"/);
  assert.ok(!/no readable text/i.test(answerError.message),
    'the page stage succeeded and must not be blamed');

  // (c) Fetch failure keeps its specific upstream cause, now naming the URL.
  const fetchError = await expectRejection(runtime.runWebExtraction({
    url: 'https://unreachable.example/page',
    query: 'Anything?',
    engine,
    parentSessionId: 'diag_fetchfail',
    pageFetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); },
    fetchImpl: async () => assert.fail('the model must not be called after a fetch failure'),
  }), 'fetch failure');
  assert.match(fetchError.message, /Web page fetch failed for https:\/\/unreachable\.example\/page/);
  assert.match(fetchError.message, /SUBAGENT_FETCH_ERROR/);
});
