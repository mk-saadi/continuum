// Token-counter accuracy: per-request telemetry, peak-vs-sum separation,
// tokenizer-based measurement caching, session isolation, and graceful
// degradation. Run with: node --test tests/contextTelemetry.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-telemetry-'));
const handlers = new Map();
const bridges = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    contextBridge: { exposeInMainWorld: (name, bridge) => bridges.set(name, bridge) },
    ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)({ trusted: true }, payload) },
  };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');

async function main() {
  const { turnPromptTelemetry, mergePhaseStats } = await import('../src/lib/completionStats.mjs');
  const display = await import('../src/lib/contextDisplay.mjs');
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const { runDesktopChat } = await import('../src/lib/desktopChat.mjs');

  await test('peak prompt uses the maximum single request, never the sum', () => {
    const phases = [
      { promptTokens: 8000, completionTokens: 10, totalTokens: 8010 },
      { promptTokens: 12000, completionTokens: 10, totalTokens: 12010 },
      { promptTokens: 9500, completionTokens: 10, totalTokens: 9510 },
    ];
    const telemetry = turnPromptTelemetry(phases);
    assert.equal(telemetry.lastPromptTokens, 9500);
    assert.equal(telemetry.peakPromptTokens, 12000);
    assert.equal(telemetry.peakRequestIndex, 2);
    assert.equal(telemetry.promptRequests, 3);
    assert.equal(telemetry.promptCoverage, 'complete');
    const merged = mergePhaseStats(phases.map((phase, index) =>
      ({ ...phase, startTime: 0, endTime: (index + 1) * 1000, tokensPerSecond: 10 })), 0);
    // Cumulative accounting is unchanged: the sum is much larger than the peak.
    assert.equal(merged.promptTokens, 29500);
    assert.ok(merged.promptTokens > telemetry.peakPromptTokens);
    assert.equal(merged.peakPromptTokens, 12000);
    assert.equal(merged.lastPromptTokens, 9500);
    assert.equal(merged.scope, 'all');
  });

  await test('partial and missing telemetry are labeled, never zero-filled', () => {
    const partial = turnPromptTelemetry([{ promptTokens: 5000 }, { promptTokens: null }]);
    assert.equal(partial.promptCoverage, 'partial');
    assert.equal(partial.peakPromptTokens, 5000);
    assert.equal(partial.peakRequestIndex, 1);
    assert.equal(partial.lastPromptTokens, null);
    const none = turnPromptTelemetry([{ promptTokens: null }]);
    assert.equal(none.promptCoverage, 'none');
    assert.equal(none.peakPromptTokens, null);
    assert.equal(turnPromptTelemetry([]).promptCoverage, 'none');
    const incomplete = mergePhaseStats([
      { promptTokens: null, completionTokens: null, totalTokens: null, startTime: 0, endTime: 1, tokensPerSecond: null },
      { promptTokens: 15, completionTokens: 5, totalTokens: 20, startTime: 1, endTime: 2, tokensPerSecond: 20 },
    ], 0);
    assert.equal(incomplete.scope, 'final');
    assert.equal(incomplete.peakPromptTokens, 15);
    assert.equal(incomplete.promptCoverage, 'partial');
  });

  await test('merging the same phases twice does not change the result', () => {
    const phases = [
      { promptTokens: 10, completionTokens: 5, totalTokens: 15, startTime: 0, endTime: 1, tokensPerSecond: 5 },
      { promptTokens: 20, completionTokens: 15, totalTokens: 35, startTime: 1, endTime: 2, tokensPerSecond: 15 },
    ];
    assert.deepEqual(mergePhaseStats(phases, 0), mergePhaseStats(phases, 0));
  });

  const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  function stream(chunks) {
    const bytes = new TextEncoder().encode(chunks.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes);
      controller.close();
    } }));
  }
  const chatBase = { baseUrl: 'http://localhost', modelId: 'test',
    messages: [{ role: 'system', content: 'Rules' }],
    memoryTools: [{ name: 'search_memory', description: 'search', input_schema: { type: 'object' } }] };

  await test('multi-round fixture separates cumulative work from peak occupancy', async () => {
    const prompts = [8000, 12000, 9500];
    let requests = 0;
    const live = [];
    let stats;
    await runMemoryChat({ ...chatBase, executeTool: async () => ({}),
      onPhase: (event) => live.push(event),
      onStats: (value) => { stats = value; },
      fetchImpl: async () => {
        const round = requests++;
        if (round < 2) return stream([
          chunk({ tool_calls: [{ index: 0, id: `call${round}`, function: { name: 'search_memory', arguments: '{}' } }] }, 'tool_calls'),
          { choices: [], usage: { prompt_tokens: prompts[round], completion_tokens: 5 } },
        ]);
        return stream([chunk({ content: 'Done [TASK COMPLETE]' }, 'stop'),
          { choices: [], usage: { prompt_tokens: prompts[round], completion_tokens: 5 } }]);
      },
    });
    assert.equal(requests, 3);
    assert.deepEqual(live.map(event => event.promptTokens), prompts);
    assert.deepEqual(live.map(event => event.telemetry.peakPromptTokens), [8000, 12000, 12000]);
    assert.equal(stats.promptTokens, 29500);
    assert.equal(stats.peakPromptTokens, 12000);
    assert.equal(stats.lastPromptTokens, 9500);
    assert.equal(stats.promptCoverage, 'complete');
    assert.equal(stats.promptRequests, 3);
    assert.equal(stats.scope, 'all');
  });

  await test('desktop chat routes live phase telemetry per session', async () => {
    const oldWindow = globalThis.window;
    let listener, requestId, finish;
    const phases = [];
    globalThis.window = { chatAPI: {
      onEvent: callback => { listener = callback; return () => {}; },
      run: payload => { requestId = payload.requestId; return new Promise(resolve => { finish = resolve; }); },
    } };
    try {
      const chat = runDesktopChat({ modelId: 'test', messages: [], sessionId: 's1',
        onPhase: (event) => phases.push(event) });
      listener({ requestId: 'stale', type: 'phase', sessionId: 's1', promptTokens: 1 });
      listener({ requestId, type: 'phase', sessionId: 'other-session', promptTokens: 2 });
      listener({ requestId, type: 'phase', sessionId: 's1', round: 1, promptTokens: 8000, telemetry: { peakPromptTokens: 8000 } });
      finish({ text: 'Done' });
      await chat;
      assert.deepEqual(phases.map(event => event.promptTokens), [8000]);
    } finally { globalThis.window = oldWindow; }
  });

  await test('header helpers distinguish current, last, peak, and cumulative', () => {
    assert.equal(display.compactTokenCount(68412), '68.4k');
    assert.equal(display.compactTokenCount(999), '999');
    assert.equal(display.buildContextLabel({ total: 68412, limit: 102400 }).label, 'Context: 68.4k / 102.4k');
    const tooltip = display.buildContextTooltip({ total: 68412, limit: 102400,
      method: 'server-template-tokenizer', confidence: 'measured',
      persisted: { lastPromptTokens: 71203, peakPromptTokens: 74001, peakRequestIndex: 12, promptRequests: 30, promptCoverage: 'complete' } });
    assert.match(tooltip, /measured with the model tokenizer/);
    assert.match(tooltip, /Last turn: actual 71,203/);
    assert.match(tooltip, /peak 74,001 \(request 12 of 30\)/);
    assert.match(tooltip, /Cumulative inference work/);
    const partial = display.buildContextTooltip({ total: 100, limit: 1000, method: 'legacy-estimate',
      persisted: { lastPromptTokens: null, peakPromptTokens: 50, promptRequests: 2, promptCoverage: 'partial' } });
    assert.match(partial, /partial telemetry/);
    assert.match(display.buildContextTooltip({ total: null, limit: 1000 }), /No server request telemetry yet/);
  });

  // ---- Database-backed telemetry persistence (same harness as messageStats) ----
  initDatabase();
  const MODEL = 'telemetry-model';
  await test('telemetry persists, stays per-session, and degrades gracefully', async () => {
    sessions.getOrCreateSession('tele-a', MODEL);
    sessions.getOrCreateSession('tele-b', MODEL);
    assert.equal(sessions.getLastTurnTelemetry('tele-a'), null);
    assert.equal(sessions.getContextUsage('tele-a', MODEL).telemetry, null);
    const turnStats = { startTime: 0, endTime: 3000, time: 3, promptTokens: 29500,
      completionTokens: 15, totalTokens: 29515, tokensPerSecond: 5,
      lastPromptTokens: 9500, peakPromptTokens: 12000, peakRequestIndex: 2,
      promptRequests: 3, promptCoverage: 'complete', scope: 'all' };
    const saved = sessions.saveMessage('tele-a', 'assistant', 'Done.', [], turnStats);
    assert.equal(saved.stats.peakPromptTokens, 12000);
    const seen = sessions.getLastTurnTelemetry('tele-a');
    assert.equal(seen.peakPromptTokens, 12000);
    assert.equal(seen.lastPromptTokens, 9500);
    assert.equal(seen.messageId, saved.id);
    // Another session never sees this session's telemetry.
    assert.equal(sessions.getLastTurnTelemetry('tele-b'), null);
    assert.equal(sessions.getContextUsage('tele-b', MODEL).telemetry, null);
    assert.deepEqual(sessions.getContextUsage('tele-a', MODEL).telemetry.messageId, saved.id);
    // Interrupted/partial turns keep their coverage flag.
    const partial = sessions.saveMessage('tele-a', 'assistant', 'Interrupted.', [],
      { time: 1, lastPromptTokens: null, peakPromptTokens: 4000, promptRequests: 2, promptCoverage: 'partial' });
    assert.equal(sessions.getLastTurnTelemetry('tele-a').promptCoverage, 'partial');
    assert.equal(sessions.getLastTurnTelemetry('tele-a').messageId, partial.id);
    // Restart-proof: telemetry survives close/reopen like any other stats.
    closeDatabase(); initDatabase();
    assert.equal(sessions.getLastTurnTelemetry('tele-a').peakPromptTokens, 4000);
    assert.deepEqual(sessions.loadSession('tele-a').messages.at(-1).stats.promptCoverage, 'partial');
  });

  await test('invalid telemetry is rejected, never stored', async () => {
    sessions.getOrCreateSession('tele-invalid', MODEL);
    await assert.rejects(async () => sessions.saveMessage('tele-invalid', 'assistant', 'Bad', [],
      { time: 1, peakPromptTokens: -5 }), /Invalid generation stat/);
    await assert.rejects(async () => sessions.saveMessage('tele-invalid', 'assistant', 'Bad', [],
      { time: 1, promptCoverage: 'bogus' }), /Invalid generation stat/);
  });

  // ---- Tokenizer-based prepared-prompt measurement ----
  await test('measurement covers the real prompt, caches, and invalidates', async () => {
    const { measurePreparedContext, clearCache } = require('../src/main/promptMeasurement');
    clearCache();
    const id = crypto.randomUUID();
    sessions.getOrCreateSession(id, MODEL);
    sessions.saveMessage(id, 'user', 'Please analyze the attached rules.');
    sessions.saveMessage(id, 'assistant', 'Acknowledged.');
    const seen = { props: 0, template: 0, tokenize: 0, prompts: [] };
    const fetchImpl = async (href, options = {}) => {
      const url = String(href);
      if (url.endsWith('/props') && (!options.method || options.method === 'GET')) {
        seen.props++;
        return { ok: true, json: async () => ({ model_path: 'telemetry-model', chat_template: 'tmpl', default_generation_settings: { n_ctx: 102400 } }) };
      }
      if (url.endsWith('/apply-template')) {
        seen.template++;
        const payload = JSON.parse(options.body);
        seen.prompts.push(payload);
        return { ok: true, json: async () => ({ prompt: `TOOLS:${payload.tools.map(tool => `${tool.function.name}:${tool.function.description}:${JSON.stringify(tool.function.parameters)}`).join('|')}\nMSGS:${JSON.stringify(payload.messages)}` }) };
      }
      if (url.endsWith('/tokenize')) {
        seen.tokenize++;
        const prompt = JSON.parse(options.body).content;
        return { ok: true, json: async () => ({ tokens: new Array(1000 + prompt.length).fill(1) }) };
      }
      throw new Error(`unexpected route ${url}`);
    };
    const engine = { port: 18080, modelPath: MODEL, contextLength: 102400 };
    const first = await measurePreparedContext({ sessionId: id, modelId: MODEL, engine, fetchImpl, mcpToolsOverride: [] });
    assert.equal(first.confidence, 'measured');
    assert.equal(first.method, 'server-template-tokenizer');
    assert.ok(first.tokens > 1000);
    const rendered = seen.prompts.at(-1);
    const dump = JSON.stringify(rendered.messages);
    // Same builders as the inference path: system prompt, history, and tools.
    assert.ok(rendered.messages.some(message => message.role === 'system'));
    assert.match(dump, /Please analyze the attached rules/);
    assert.ok(rendered.tools.length > 0);
    const tokenizeCalls = seen.tokenize;
    const second = await measurePreparedContext({ sessionId: id, modelId: MODEL, engine, fetchImpl, mcpToolsOverride: [] });
    assert.deepEqual(second, first);
    assert.equal(seen.tokenize, tokenizeCalls, 'unchanged prompt must reuse the cached measurement');
    // Relevant input change invalidates the cache.
    sessions.saveMessage(id, 'user', 'Follow-up with substantially more content. '.repeat(50));
    const third = await measurePreparedContext({ sessionId: id, modelId: MODEL, engine, fetchImpl, mcpToolsOverride: [] });
    assert.ok(third.tokens > first.tokens);
    assert.equal(seen.tokenize, tokenizeCalls + 1);
    // Model switches never reuse an incompatible cached measurement.
    const otherEngine = { port: 18080, modelPath: 'other-model', contextLength: 102400 };
    const other = await measurePreparedContext({ sessionId: id, modelId: 'other-model', engine: otherEngine, fetchImpl, mcpToolsOverride: [] });
    assert.equal(other.modelId, 'other-model');
    assert.equal(seen.tokenize, tokenizeCalls + 2);
    clearCache();
  });

  await test('unmeasurable backends degrade to a labeled estimate', async () => {    const { measurePreparedContext, clearCache } = require('../src/main/promptMeasurement');
    clearCache();
    const id = crypto.randomUUID();
    sessions.getOrCreateSession(id, MODEL);
    sessions.saveMessage(id, 'user', 'Hello cloud.');
    let calls = 0;
    const cloud = await measurePreparedContext({ sessionId: id, modelId: 'cloud:prov:model', cloud: true,
      fetchImpl: async () => { calls++; throw new Error('must not probe for cloud'); } });
    assert.equal(cloud.confidence, 'estimated');
    assert.equal(cloud.method, 'approximate-full-request');
    assert.equal(calls, 0);
    const offline = await measurePreparedContext({ sessionId: id, modelId: MODEL, engine: null,
      fetchImpl: async () => { throw new Error('must not probe while offline'); } });
    assert.equal(offline.confidence, 'estimated');
    assert.equal(offline.note, 'engine-not-ready');
    const failing = await measurePreparedContext({ sessionId: id, modelId: MODEL,
      engine: { port: 1, modelPath: MODEL, contextLength: 8192 },
      fetchImpl: async () => { throw new Error('connection refused'); } });
    assert.equal(failing.confidence, 'estimated');
    clearCache();
  });

  await test('measure-context IPC wires session telemetry without polling', async () => {    const { registerIpcHandlers } = require('../src/main/ipcHandlers');
    const dispose = registerIpcHandlers({ isTrustedSender: (event) => event.trusted === true, getEngineConfig: () => null });
    try {
      const handler = handlers.get('session:measure-context');
      assert.ok(handler, 'measure-context handler registered');
      const id = crypto.randomUUID();
      sessions.getOrCreateSession(id, MODEL);
      sessions.saveMessage(id, 'user', 'Measure me through IPC.');
      const result = await handler({ trusted: true }, { sessionId: id, modelId: MODEL });
      assert.equal(result.sessionId, id);
      assert.equal(result.modelId, MODEL);
      assert.ok(result.tokens > 0);
      // Offline engine: labeled estimate, never a fake exact count.
      assert.equal(result.confidence, 'estimated');
      await assert.rejects(handler({ trusted: true }, { sessionId: '', modelId: MODEL }), /sessionId/);
    } finally { dispose(); }
  });

  await test('explicit invalidation forces a fresh measurement', async () => {
    const { measurePreparedContext, invalidateMeasuredContext, clearCache } = require('../src/main/promptMeasurement');
    clearCache();
    const id = crypto.randomUUID();
    sessions.getOrCreateSession(id, MODEL);
    sessions.saveMessage(id, 'user', 'Cache me.');
    let calls = 0;
    const engine = { port: 18080, modelPath: MODEL, contextLength: 32768 };
    const fetchImpl = async (href, options = {}) => {
      const url = String(href);
      if (url.endsWith('/props')) return { ok: true, json: async () => ({ model_path: MODEL, chat_template: 't', default_generation_settings: { n_ctx: 32768 } }) };
      if (url.endsWith('/apply-template')) {
        calls++;
        return { ok: true, json: async () => ({ prompt: `PROMPT:${JSON.stringify(JSON.parse(options.body).messages).length}` }) };
      }
      if (url.endsWith('/tokenize')) return { ok: true, json: async () => ({ tokens: new Array(500).fill(1) }) };
      throw new Error(`unexpected route ${url}`);
    };
    await measurePreparedContext({ sessionId: id, modelId: MODEL, engine, fetchImpl, mcpToolsOverride: [] });
    assert.equal(calls, 1);
    await measurePreparedContext({ sessionId: id, modelId: MODEL, engine, fetchImpl, mcpToolsOverride: [] });
    assert.equal(calls, 1);
    invalidateMeasuredContext(id, MODEL);
    await measurePreparedContext({ sessionId: id, modelId: MODEL, engine, fetchImpl, mcpToolsOverride: [] });
    assert.equal(calls, 2);
    clearCache();
  });

  console.log('Context telemetry: peak-vs-sum, coverage, live routing, persistence, measurement cache, and fallbacks passed.');
}

main().then(() => {
  closeDatabase(); Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = 1;
});
