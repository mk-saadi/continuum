'use strict';
// Phase 1.7: the native, permission-aware web_search tool.
//
// Deterministic and offline: the provider transport is exercised through an
// injected/mocked fetch, never the network, so no key and no paid call is
// needed. Covers the provider boundary (validation, classification, bounding,
// retry, cancellation, secret hygiene) and the real tool path
// (executeAgentTool + guardTool + the child allowlist), plus the transcript
// (turnDigest) and UI-presentation (executionEvents) integrations.
//
// Run with: node --test tests/webSearchTool.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// The database lives under the electron userData dir; point it at a throwaway
// temp dir so nothing touches a real profile.
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-db-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => appDir } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(appDir);

const provider = require('../src/main/tools/webSearchProvider');
const {
  searchWeb, providerLabel, normalizeResults, validateResultUrl,
  classifyHttpFailure, SEARCH_OUTCOMES,
} = provider;
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { capabilityOf, isToolVisible, guardTool, CAPABILITIES } = require('../src/main/toolPermissions');
const configManager = require('../src/main/configManager');
const nodeHttpFetchModule = require('../src/main/nodeHttpFetch');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');
const { failedToolReason } = require('../src/main/engineManager');

const CONFIGURED = { provider: 'brave', apiKey: 'test-brave-key' };

// A Brave-shaped success body.
function braveBody(results, extra = {}) {
  return { type: 'search', query: { original: 'x' }, web: { type: 'search', results }, ...extra };
}
function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// Tool registry / schema
// ---------------------------------------------------------------------------

test('web_search is a native tool with a required query and bounded max_results', () => {
  const tool = agentTools.find((entry) => entry.function.name === 'web_search');
  assert.ok(tool, 'web_search is registered');
  assert.deepEqual(tool.function.parameters.required, ['query']);
  assert.equal(tool.function.parameters.properties.query.type, 'string');
  assert.equal(tool.function.parameters.properties.max_results.maximum, 20);
  assert.equal(tool.function.parameters.properties.max_results.minimum, 1);
  assert.match(tool.function.description, /never fetches a result page/i);
});

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

test('web_search maps to READ and is visible/allowed in read-only and casual contexts', async () => {
  assert.equal(capabilityOf('web_search'), CAPABILITIES.READ);
  assert.equal(isToolVisible('web_search', { permissionMode: 'read_only' }), true);
  assert.equal(isToolVisible('web_search', { permissionMode: 'workspace_write', project: { root_path: '/tmp' } }), true);
  // READ needs no approval in any mode, including caseless casual chat.
  const decision = await guardTool({ name: 'web_search', args: { query: 'x' }, permissionMode: 'read_only' });
  assert.equal(decision.mode, 'read_only');
  assert.equal(decision.approved, false);
});

test('children cannot reach web_search (deliberate policy)', () => {
  assert.equal(CHILD_TOOL_NAMES.includes('web_search'), false);
});

test('web_search is not a second fetch tool: only the provider URL is contacted', async () => {
  const calls = [];
  const result = await searchWeb({
    query: 'electron ipc', max_results: 3, settings: CONFIGURED,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, options });
      return jsonResponse(braveBody([{ title: 'A', url: 'https://a.example/1', description: 'one' }]));
    },
  });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1, 'exactly one page is contacted (the provider endpoint)');
  assert.equal(calls[0].url.startsWith('https://api.search.brave.com/res/v1/web/search?'), true);
  // No result page is ever fetched by the search tool.
  assert.ok(!calls.some((call) => call.url.includes('a.example')));
});

// ---------------------------------------------------------------------------
// Provider: configuration + secrets
// ---------------------------------------------------------------------------

test('unconfigured search reports not_configured without contacting the network', async () => {
  const result = await searchWeb({
    query: 'anything', settings: { provider: 'brave', apiKey: '' },
    fetchImpl: () => assert.fail('must not fetch when unconfigured'),
  });
  assert.equal(result.success, false);
  assert.equal(result.outcome, SEARCH_OUTCOMES.NOT_CONFIGURED);
  assert.deepEqual(result.results, []);
  assert.match(result.error, /not configured/i);
});

test('the API key is sent to the provider but never returned or embedded in errors', async () => {
  const seenHeaders = [];
  const ok = await searchWeb({
    query: 'secret hygiene', settings: CONFIGURED,
    fetchImpl: async (_url, options) => {
      seenHeaders.push(options.headers['X-Subscription-Token']);
      return jsonResponse(braveBody([{ title: 'T', url: 'https://t.example/', description: 's' }]));
    },
  });
  assert.equal(seenHeaders[0], 'test-brave-key');
  assert.ok(!JSON.stringify(ok).includes('test-brave-key'), 'key never appears in a success result');

  const failed = await searchWeb({
    query: 'secret hygiene', settings: CONFIGURED,
    fetchImpl: async () => new Response('nope', { status: 401 }),
  });
  assert.equal(failed.outcome, SEARCH_OUTCOMES.PROVIDER_ERROR);
  assert.ok(!JSON.stringify(failed).includes('test-brave-key'), 'key never appears in a failure result');
});

test('the outbound request carries only the query and provider parameters', async () => {
  let captured;
  await searchWeb({
    query: 'only this query travels', max_results: 4, settings: CONFIGURED,
    fetchImpl: async (url) => {
      captured = url;
      return jsonResponse(braveBody([]));
    },
  });
  const params = [...captured.searchParams.keys()].sort();
  assert.deepEqual(params, ['count', 'extra_snippets', 'q', 'safesearch', 'text_decorations']);
  assert.equal(captured.searchParams.get('q'), 'only this query travels');
  assert.equal(captured.searchParams.get('count'), '4');
});

// ---------------------------------------------------------------------------
// Provider: successful normalization
// ---------------------------------------------------------------------------

test('successful search returns bounded structured results with stable positions', async () => {
  const result = await searchWeb({
    query: 'structured results', settings: CONFIGURED,
    fetchImpl: async () => jsonResponse(braveBody([
      { title: 'First', url: 'https://one.example/path', description: 'First snippet', page_age: '2024-05-01T10:00:00' },
      { title: 'Second', url: 'https://two.example/', description: 'Second snippet', age: '2 days ago' },
    ])),
  });
  assert.equal(result.success, true);
  assert.equal(result.outcome, SEARCH_OUTCOMES.SUCCESS);
  assert.equal(result.provider, 'brave');
  assert.equal(result.providerLabel, 'Brave Search');
  assert.equal(result.resultCount, 2);
  assert.deepEqual(result.results.map((r) => r.position), [1, 2]);
  assert.equal(result.results[0].title, 'First');
  assert.equal(result.results[0].url, 'https://one.example/path');
  assert.equal(result.results[0].source, 'one.example');
  assert.equal(result.results[0].snippet, 'First snippet');
  assert.equal(result.results[0].published, '2024-05-01', 'reliable ISO date kept');
  assert.equal(result.results[1].published, null, 'relative age is never fabricated into a date');
});

test('an empty result set is a success with outcome no_results (not a tool failure)', async () => {
  const result = await searchWeb({
    query: 'no such thing', settings: CONFIGURED,
    fetchImpl: async () => jsonResponse(braveBody([])),
  });
  assert.equal(result.success, true);
  assert.equal(result.outcome, SEARCH_OUTCOMES.NO_RESULTS);
  assert.deepEqual(result.results, []);
  assert.equal(failedToolReason(result, 'web_search'), null, 'no_results is not reported as a failure');
});

test('max_results defaults to 5 and is clamped to 1..20', async () => {
  const raw = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://e.example/${i}`, description: 'd' }));
  const build = (max) => searchWeb({
    query: 'q', max_results: max, settings: CONFIGURED,
    fetchImpl: async () => jsonResponse(braveBody(raw)),
  });
  assert.equal((await build(undefined)).resultCount, 5, 'default');
  assert.equal((await build(0)).resultCount, 1, 'clamped low');
  assert.equal((await build(999)).resultCount, 20, 'clamped high');
  assert.equal(normalizeResults(raw, 7).length, 7);
});

test('results are de-duplicated by canonical URL and preserve query strings', () => {
  const results = normalizeResults([
    { title: 'a', url: 'https://Example.com/post?utm=1' },
    { title: 'dupe', url: 'https://example.com/post/?utm=1' },
    { title: 'other query', url: 'https://example.com/post?utm=2' },
  ], 10);
  assert.equal(results.length, 2, 'canonical duplicate (trailing slash/host case) removed');
  assert.equal(results[0].url, 'https://example.com/post?utm=1', 'host is normalized to lowercase');
  assert.equal(results[1].url, 'https://example.com/post?utm=2', 'distinct query strings are kept');
});

test('titles and snippets are bounded', () => {
  const results = normalizeResults([{
    title: 'T'.repeat(5000),
    url: 'https://long.example/',
    description: 'S'.repeat(5000),
  }], 5);
  assert.ok(results[0].title.length <= 300);
  assert.ok(results[0].snippet.length <= 1200);
});

// ---------------------------------------------------------------------------
// Provider: URL validation
// ---------------------------------------------------------------------------

test('validateResultUrl accepts only public http(s) URLs', () => {
  assert.equal(validateResultUrl('https://example.com/a').href, 'https://example.com/a');
  assert.equal(validateResultUrl('http://example.com/a').protocol, 'http:');
  assert.equal(validateResultUrl('javascript:alert(1)'), null);
  assert.equal(validateResultUrl('file:///etc/passwd'), null);
  assert.equal(validateResultUrl('ftp://example.com/x'), null);
  assert.equal(validateResultUrl('https://user:pass@example.com/x'), null);
  assert.equal(validateResultUrl('http://localhost/x'), null);
  assert.equal(validateResultUrl('http://127.0.0.1/x'), null);
  assert.equal(validateResultUrl('http://10.0.0.5/x'), null);
  assert.equal(validateResultUrl('http://192.168.1.1/x'), null);
  assert.equal(validateResultUrl('http://169.254.1.1/x'), null);
  assert.equal(validateResultUrl('http://[::1]/x'), null);
  assert.equal(validateResultUrl('not a url'), null);
  assert.equal(validateResultUrl(''), null);
});

test('hostile/private/invalid result URLs are dropped from normalized output', () => {
  const results = normalizeResults([
    { title: 'ok', url: 'https://good.example/page' },
    { title: 'bad', url: 'javascript:alert(1)' },
    { title: 'internal', url: 'http://127.0.0.1/secret' },
    { title: 'creds', url: 'https://user:pass@evil.example/' },
    { title: 'no url' },
  ], 10);
  assert.deepEqual(results.map((r) => r.url), ['https://good.example/page']);
});

// ---------------------------------------------------------------------------
// Provider: failure classification
// ---------------------------------------------------------------------------

test('401/403 auth failures are provider_error and are not retried', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'auth', settings: CONFIGURED,
    fetchImpl: async () => { attempts++; return new Response('unauthorized', { status: 401 }); },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.PROVIDER_ERROR);
  assert.match(result.error, /rejected the API key/);
  assert.equal(attempts, 1, 'auth is permanent, never retried');
});

test('400/422 validation failures are provider_error and are not retried', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'bad', settings: CONFIGURED,
    fetchImpl: async () => { attempts++; return new Response('bad', { status: 422 }); },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.PROVIDER_ERROR);
  assert.equal(attempts, 1);
});

test('a 5xx response is retried exactly once and then reported as provider_error', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'flaky', settings: CONFIGURED, maxRetries: 1,
    fetchImpl: async () => { attempts++; return new Response('boom', { status: 503 }); },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.PROVIDER_ERROR);
  assert.equal(attempts, 2, 'one initial attempt plus one bounded retry');
});

test('a transient 5xx that succeeds on retry returns success', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'recovers', settings: CONFIGURED,
    fetchImpl: async () => {
      attempts++;
      return attempts === 1
        ? new Response('boom', { status: 502 })
        : jsonResponse(braveBody([{ title: 'ok', url: 'https://ok.example/', description: 'd' }]));
    },
  });
  assert.equal(result.success, true);
  assert.equal(attempts, 2);
});

test('429 is rate_limited with retryAfter metadata and is not auto-retried', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'limited', settings: CONFIGURED,
    fetchImpl: async () => {
      attempts++;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
    },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.RATE_LIMITED);
  assert.equal(result.retryAfter, '30');
  assert.equal(attempts, 1);
  assert.equal(classifyHttpFailure({ status: 429, headers: new Headers({ 'retry-after': '12' }) }).outcome, SEARCH_OUTCOMES.RATE_LIMITED);
});

test('a network failure is retried once then classified as provider_error', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'network', settings: CONFIGURED,
    fetchImpl: async () => { attempts++; throw new Error('ECONNRESET'); },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.PROVIDER_ERROR);
  assert.match(result.error, /could not reach/i);
  assert.equal(attempts, 2);
});

test('a provider timeout is classified as timed_out and not retried', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'slow', settings: CONFIGURED,
    fetchImpl: async () => { attempts++; const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.TIMED_OUT);
  assert.equal(attempts, 1);
});

test('an unexpected redirect is a provider_error and is never followed', async () => {
  let attempts = 0;
  const result = await searchWeb({
    query: 'redirected', settings: CONFIGURED,
    fetchImpl: async () => { attempts++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }); },
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.PROVIDER_ERROR);
  assert.match(result.error, /redirect/i);
  assert.equal(attempts, 1);
});

test('a non-JSON or unexpected body is invalid_response', async () => {
  const notJson = await searchWeb({
    query: 'html', settings: CONFIGURED,
    fetchImpl: async () => new Response('<html>nope</html>', { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(notJson.outcome, SEARCH_OUTCOMES.INVALID_RESPONSE);
  const wrongShape = await searchWeb({
    query: 'shape', settings: CONFIGURED,
    fetchImpl: async () => jsonResponse({ totally: 'different' }),
  });
  assert.equal(wrongShape.outcome, SEARCH_OUTCOMES.INVALID_RESPONSE);
});

test('an oversized provider body is rejected as invalid_response', async () => {
  const result = await searchWeb({
    query: 'huge', settings: CONFIGURED,
    fetchImpl: async () => new Response(JSON.stringify({ type: 'search', web: { results: [] }, pad: 'x'.repeat(1024 * 1024 + 10) }),
      { headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(result.outcome, SEARCH_OUTCOMES.INVALID_RESPONSE);
});

test('caller cancellation propagates as an abort instead of a tool result', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchWeb({ query: 'cancelled', settings: CONFIGURED, signal: controller.signal,
      fetchImpl: async () => assert.fail('must not fetch after abort') }),
    (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR',
  );
});

test('cancellation during the request propagates too', async () => {
  const controller = new AbortController();
  const pending = searchWeb({
    query: 'cancelled mid-flight', settings: CONFIGURED, signal: controller.signal,
    fetchImpl: async (_url, options) => {
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
});

test('providerLabel names the known provider and degrades safely', () => {
  assert.equal(providerLabel('brave'), 'Brave Search');
  assert.equal(providerLabel('unknown'), 'Web Search');
});

// ---------------------------------------------------------------------------
// Tool path: executeAgentTool
// ---------------------------------------------------------------------------

let fetchPatch;
function patchFetch(implementation) {
  fetchPatch = nodeHttpFetchModule.nodeHttpFetch;
  nodeHttpFetchModule.nodeHttpFetch = implementation;
}
function restoreFetch() {
  if (fetchPatch) nodeHttpFetchModule.nodeHttpFetch = fetchPatch;
  fetchPatch = null;
}

test('executeAgentTool runs web_search through the real dispatch and returns results', async () => {
  configManager.saveSearchSettings({ provider: 'brave', apiKey: 'test-brave-key' });
  patchFetch(async () => jsonResponse(braveBody([
    { title: 'Tool path', url: 'https://tool.example/doc', description: 'found it' },
  ])));
  try {
    const output = await executeAgentTool({
      name: 'web_search', arguments: { query: 'tool path' }, sessionId: null, permissionMode: 'read_only',
    });
    assert.equal(output.success, true);
    assert.equal(output.outcome, 'success');
    assert.equal(output.results[0].url, 'https://tool.example/doc');
  } finally {
    restoreFetch();
    configManager.saveSearchSettings({ provider: 'brave', apiKey: '' });
  }
});

test('executeAgentTool reports not_configured truthfully when no key is saved', async () => {
  configManager.saveSearchSettings({ provider: 'brave', apiKey: '' });
  patchFetch(async () => assert.fail('must not fetch when unconfigured'));
  try {
    const output = await executeAgentTool({
      name: 'web_search', arguments: { query: 'nope' }, sessionId: null, permissionMode: 'read_only',
    });
    assert.equal(output.success, false);
    assert.equal(output.outcome, 'not_configured');
    assert.equal(failedToolReason(output, 'web_search'), 'A tool call failed.');
  } finally {
    restoreFetch();
  }
});

test('executeAgentTool types malformed input and cancellation outcomes', async () => {
  const missing = await executeAgentTool({
    name: 'web_search', arguments: {}, sessionId: null, permissionMode: 'read_only',
  });
  assert.equal(missing.success, false);
  assert.equal(missing.outcome, 'error');

  const unexpected = await executeAgentTool({
    name: 'web_search', arguments: { query: 'x', nonsense: 1 }, sessionId: null, permissionMode: 'read_only',
  });
  assert.equal(unexpected.outcome, 'error');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeAgentTool({
    name: 'web_search', arguments: { query: 'x' }, sessionId: null, permissionMode: 'read_only', signal: controller.signal,
  });
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.outcome, 'cancelled');
});

test('executeAgentTool routes web_search through the guard to the provider', async () => {
  configManager.saveSearchSettings({ provider: 'brave', apiKey: 'test-brave-key' });
  patchFetch(async () => jsonResponse(braveBody([{ title: 'Guarded', url: 'https://guard.example/', description: 'd' }])));
  try {
    // Guarded path: no permissionGranted, so the inner guard decides. READ needs
    // no approval and the model cannot self-approve anything mutating.
    const output = await executeAgentTool({
      name: 'web_search', arguments: { query: 'guarded' }, sessionId: null, permissionMode: 'read_only',
    });
    assert.equal(output.success, true);
    assert.equal(output.results[0].title, 'Guarded');
  } finally {
    restoreFetch();
    configManager.saveSearchSettings({ provider: 'brave', apiKey: '' });
  }
});

// ---------------------------------------------------------------------------
// Tool path: chat loop round-trip
// ---------------------------------------------------------------------------

test('a web_search tool call round-trips through the memory chat loop', async () => {
  configManager.saveSearchSettings({ provider: 'brave', apiKey: 'test-brave-key' });
  patchFetch(async () => jsonResponse(braveBody([{ title: 'Loop', url: 'https://loop.example/', description: 'd' }])));
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const requests = [];
  try {
    const result = await runMemoryChat({
      baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Be helpful.' }],
      chatTools: agentTools,
      executeTool: async (call) => {
        const args = JSON.parse(call.arguments || '{}');
        return executeAgentTool({ name: call.name, arguments: args, sessionId: null, permissionMode: 'read_only' });
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        return Response.json({ choices: [{ message: requests.length === 1
          ? { role: 'assistant', tool_calls: [{ id: 's1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'loop test' }) } }] }
          : { role: 'assistant', content: 'Found it. [TASK COMPLETE]' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] });
      },
    });
    assert.equal(result, 'Found it. [TASK COMPLETE]');
    const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /loop\.example/);
  } finally {
    restoreFetch();
    configManager.saveSearchSettings({ provider: 'brave', apiKey: '' });
  }
});

// ---------------------------------------------------------------------------
// Config manager: redaction + persistence
// ---------------------------------------------------------------------------

test('search settings are redacted for the renderer and preserve the stored key', () => {
  const saved = configManager.saveSearchSettings({ provider: 'brave', apiKey: 'persist-me' });
  assert.deepEqual(Object.keys(saved).sort(), ['configured', 'provider', 'providerLabel']);
  assert.equal(saved.configured, true);
  assert.equal(saved.providerLabel, 'Brave Search');
  assert.ok(!('apiKey' in saved), 'the key is never returned to the renderer');

  // Saving without apiKey keeps the existing secret.
  const again = configManager.saveSearchSettings({ provider: 'brave' });
  assert.equal(again.configured, true);
  assert.equal(configManager.readSearchSettings().apiKey, 'persist-me');

  // Explicit empty string clears it.
  const cleared = configManager.saveSearchSettings({ provider: 'brave', apiKey: '' });
  assert.equal(cleared.configured, false);
  assert.equal(configManager.readSearchSettings().apiKey, '');
});

test('search settings reject unsupported providers and malformed keys', () => {
  assert.throws(() => configManager.saveSearchSettings({ provider: 'google', apiKey: 'x' }), /Unsupported search provider/);
  assert.throws(() => configManager.saveSearchSettings({ provider: 'brave', apiKey: 'bad\nkey' }), /Invalid search API key/);
});

// ---------------------------------------------------------------------------
// Transcript + UI presentation
// ---------------------------------------------------------------------------

test('turnDigest summarizes web_search by query and outcome, not as a fetch', () => {
  const turnDigest = require('../src/main/turnDigest');
  assert.equal(turnDigest.classifyTool('web_search'), 'web');
  const success = turnDigest.buildTurnDigest([
    { type: 'tool_call', toolName: 'web_search', status: 'complete',
      args: { query: 'quantum widgets' },
      result: { success: true, outcome: 'success', results: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] } },
  ], { turnSeq: 1 });
  const successText = JSON.stringify(success);
  assert.match(successText, /searched 'quantum widgets' \(2 results\)/);
  assert.ok(!successText.includes('fetched'));

  const empty = turnDigest.buildTurnDigest([
    { type: 'tool_call', toolName: 'web_search', status: 'complete',
      args: { query: 'nothing' }, result: { success: true, outcome: 'no_results', results: [] } },
  ], { turnSeq: 1 });
  assert.match(JSON.stringify(empty), /searched 'nothing' \(0 results\)/);
});

test('execution events present web_search as a Search operation with a Query field', async () => {
  const { toolKind, toolVerb, formatArgFields, summarizeStage, splitStages } = await import('../src/lib/executionEvents.mjs');
  const step = { type: 'tool_call', toolName: 'web_search', status: 'complete', args: { query: 'find this' } };
  assert.equal(toolKind(step), 'search');
  assert.equal(toolVerb(step), 'Search');
  assert.deepEqual(formatArgFields(step), [{ label: 'Query', value: 'find this' }]);
  const stage = summarizeStage(splitStages([step])[0]);
  assert.equal(stage.counts.search, 1);
});

// ---------------------------------------------------------------------------
// OPTIONAL MANUAL LIVE SMOKE TEST — separately labelled, never runs in CI.
//
// The deterministic suite above never touches the network. To run this single
// live call, export a real Brave Search API key:
//
//   CONTINUUM_LIVE_SEARCH_KEY=... node --test tests/webSearchTool.test.cjs
//
// Without the env var the test is skipped, so routine runs spend no quota.
// ---------------------------------------------------------------------------

test('MANUAL LIVE SMOKE: a real Brave search returns at least one structured result',
  { skip: process.env.CONTINUUM_LIVE_SEARCH_KEY ? false : 'set CONTINUUM_LIVE_SEARCH_KEY to run the live smoke test' },
  async () => {
    const result = await searchWeb({
      query: 'Electron desktop framework',
      settings: { provider: 'brave', apiKey: process.env.CONTINUUM_LIVE_SEARCH_KEY },
    });
    assert.equal(result.success, true, `live search failed: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'success');
    assert.ok(result.results.length > 0, 'at least one result');
    assert.ok(result.results.every((entry) => /^https?:\/\//.test(entry.url)));
    assert.ok(!JSON.stringify(result).includes(process.env.CONTINUUM_LIVE_SEARCH_KEY), 'the key is never echoed back');
  });
