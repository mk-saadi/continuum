'use strict';
// Regression tests for idle auto-compaction.
//
// Idle compaction targets the *projected* prompt at a kind-specific fraction
// of the window (40% workspace, 50% casual; trigger stays at 75%), instead of
// a DB-only message total that omitted the fixed prompt costs. Idle summaries
// are capped at 512 tokens and the abort signal is threaded through the whole
// call chain. When a bloated casual summary alone pins the floor above
// target, the summary is dropped (history preserved) with an explicit flag
// for the user notice.
//
// Deterministic mocks only; no live model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-compaction-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  if (name === './mcpManager') {
    return { getTools: () => [], getStatus: () => ({ servers: [] }), on: () => {}, reload: async () => {} };
  }
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const briefs = require('../src/main/taskBriefs');
const workLog = require('../src/main/workLog');
const memory = require('../src/main/memoryManager');
const engine = require('../src/main/compressionEngine');
const { prepareChatMessages } = require('../src/main/promptBuilder');

const MODEL = 'idle-model';
let seq = 0;
const freshId = (prefix) => `${prefix}-${seq++}`;

function seedMessages(sessionId, count, size, prefix = 'Body') {
  for (let i = 0; i < count; i++) {
    sessions.saveMessage(sessionId, i % 2 ? 'assistant' : 'user', `${prefix}${i} `.padEnd(size, 'x'));
  }
}

// Tool schemas of roughly `chars` JSON characters, so the suite controls the
// fixed schema overhead the DB estimate omits.
function bigTools(chars) {
  return [{ type: 'function', function: { name: 'heavy_tool', description: 'd'.repeat(chars), parameters: { type: 'object', properties: {} } } }];
}

function toolTokensEstimate(tools) {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

// Independent actual-prompt estimate through the real prompt builder plus the
// schemas that ride the request (chars/4, same documented heuristic).
function actualPromptEstimate(sessionId, tools) {
  const prompt = prepareChatMessages({ sessionId, modelId: MODEL, userText: '', regenerate: true, regenerateLast: true });
  const text = prompt.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('');
  return Math.ceil(text.length / 4) + (tools ? toolTokensEstimate(tools) : 0);
}

function tailIds(sessionId, n = 10) {
  return sessions.loadSession(sessionId).messages.slice(-n).map((row) => row.id);
}

test.after(() => {
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('database estimate undercounts system prompts and tool schemas', () => {
  const id = freshId('undercount');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 20, 400);
  const tools = bigTools(32000);
  const usage = sessions.getContextUsage(id, MODEL);
  const active = sessions.getActiveMessages(id);
  const projected = engine.projectIdlePrompt({
    sessionId: id, modelId: MODEL, summaryText: null, briefSection: null, checkpointSection: null,
    retainedMessages: active, tools, memoryTokens: usage.coreTokens, workLogTokens: usage.workLogTokens,
  });
  assert.ok(projected.breakdown.systemTokens > 0, 'system block counted');
  assert.ok(projected.breakdown.toolTokens > 0, 'schemas counted');
  assert.equal(projected.breakdown.toolTokens, toolTokensEstimate(tools));
  assert.ok(projected.total > usage.totalTokens, 'projection exceeds the DB-only total');
  assert.ok(projected.total - usage.totalTokens >= projected.breakdown.systemTokens + projected.breakdown.toolTokens);
});

test('synthetic 100K context crosses the 75% trigger and compacts to the projected target', async () => {
  const id = freshId('treadmill');
  const LIMIT = 100000;
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 76, 4000);
  const tools = bigTools(40000);
  const before = sessions.getContextUsage(id, MODEL);
  assert.ok(before.totalTokens > 0.75 * LIMIT, `precondition: DB usage ${before.totalTokens} above 75% trigger`);

  const seenOpts = [];
  let calls = 0;
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT, tools,
    llmSummarizeCallback: async (old, batch, _model, opts) => {
      calls += 1;
      seenOpts.push(opts);
      return `Idle summary pass ${calls} covering ${batch.length} messages.`;
    },
  });
  assert.equal(result.compressed, true);
  assert.ok(result.archivedCount > 0);
  assert.ok(calls >= 1);
  for (const opts of seenOpts) assert.equal(opts?.maxTokens, 512, 'every idle summary capped at 512 tokens');
  assert.ok(Number.isSafeInteger(result.projectedTokens));
  assert.ok(result.projectedTokens <= 0.50 * LIMIT, `projected ${result.projectedTokens} within 50% casual target`);
  assert.equal(result.overTarget, undefined, 'on-target commit carries no over-target flag');
  assert.equal(result.summaryDropped, undefined, 'no summary dropped when the target fits');

  // The prompt that would actually be sent (real builder + schemas) fits too.
  const actual = actualPromptEstimate(id, tools);
  assert.ok(actual <= 0.50 * LIMIT + 0.02 * LIMIT, `actual prompt ${actual} near the 50% target`);

  // Protected tail survives.
  const rows = sessions.loadSession(id).messages;
  assert.ok(rows.slice(-10).every((row) => !row.archived && !row.is_summarized));
  assert.equal(rows.filter((row) => row.archived).length, result.archivedCount);

  // Summary persisted and valid.
  assert.match(sessions.getSessionSummary(id) ?? '', /Idle summary/);
});

test('repeated compaction cycles retain headroom instead of retriggering', async () => {
  const id = freshId('headroom');
  const LIMIT = 100000;
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 76, 4000);
  const tools = bigTools(40000);
  const summaries = [];
  const run = () => engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT, tools,
    llmSummarizeCallback: async (old, batch) => {
      summaries.push(old);
      return `Headroom summary ${summaries.length} over ${batch.length}.`;
    },
  });
  const first = await run();
  assert.equal(first.compressed, true);
  const second = await run();
  assert.equal(second.compressed, false, 'no immediate retrigger after reaching target');
  seedMessages(id, 5, 4000);
  const third = await run();
  assert.equal(third.compressed, false, 'headroom absorbs the next turns');

  // No duplication or loss across cycles; resume chains summaries.
  const rows = sessions.loadSession(id).messages;
  assert.equal(rows.length, 81);
  assert.equal(new Set(rows.map((row) => row.id)).size, 81);
  seedMessages(id, 55, 4000);
  const summaryBeforeFourth = sessions.getSessionSummary(id);
  const fourth = await run();
  assert.equal(fourth.compressed, true);
  assert.ok(summaries.includes(summaryBeforeFourth), 'resume chains onto the running summary');
});

test('the idle trigger stays quiet below 75% of the full request', async () => {
  const id = freshId('trigger');
  const LIMIT = 100000;
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 12, 100);
  const usage = sessions.getContextUsage(id, MODEL);
  assert.ok(usage.totalTokens <= 0.75 * LIMIT, `precondition: ${usage.totalTokens} at/below trigger`);
  let called = 0;
  const quiet = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => { called += 1; return 'Must not run.'; },
  });
  assert.equal(quiet.compressed, false);
  assert.equal(called, 0, 'no summarizer call below the 75% trigger');
});

test('workspace sessions compact to the 40% target', async () => {
  const project = projects.createProject({ name: 'Forty Percent Project' });
  const id = freshId('forty');
  const LIMIT = 100000;
  sessions.getOrCreateSession(id, MODEL, project.id);
  sessions.saveMessage(id, 'user', 'Build the forty-percent widget.');
  // Assistant-side bulk (tool-output-like): user messages would each become a
  // task brief and blow the checkpoint size cap, which is a synthetic-test
  // artifact, not production brief shape. Token math is what matters here.
  for (let i = 0; i < 76; i++) sessions.saveMessage(id, 'assistant', `ToolOutput${i} `.padEnd(4000, 'x'));
  const tools = bigTools(40000);
  const before = sessions.getContextUsage(id, MODEL);
  assert.ok(before.totalTokens > 0.75 * LIMIT, `precondition: DB usage ${before.totalTokens} above 75% trigger`);
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT, tools,
    llmSummarizeCallback: async () => 'Workspace forty-percent summary.',
    llmCheckpointCallback: async () => ({ objective: 'Build the forty-percent widget.', outstandingRequirements: [] }),
  });
  assert.equal(result.compressed, true);
  assert.ok(Number.isSafeInteger(result.projectedTokens));
  assert.ok(result.projectedTokens <= 0.40 * LIMIT, `projected ${result.projectedTokens} within 40% workspace target`);
  assert.ok(Number.isSafeInteger(result.checkpointId), 'workspace checkpoint persisted');
  const actual = actualPromptEstimate(id, tools);
  assert.ok(actual <= 0.40 * LIMIT + 0.02 * LIMIT, `actual prompt ${actual} near the 40% target`);
  assert.ok(sessions.loadSession(id).messages.slice(-10).every((row) => !row.archived));
});

test('casual summary overflow drops the summary when that regains the target', async () => {
  const id = freshId('drop');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 12, 800);
  // Size the window from the measured floor: the ambient tool schemas ride
  // every projection, so the drop math must account for them, not assume
  // tools:null. floorNull covers system + tail + real schemas.
  const tools = engine.resolveProjectionTools(id, MODEL, {});
  const tailProbe = sessions.getActiveMessages(id).slice(-10);
  const floorNull = engine.projectIdlePrompt({ sessionId: id, modelId: MODEL,
    summaryText: null, briefSection: null, checkpointSection: null,
    retainedMessages: tailProbe, tools }).total;
  const LIMIT = Math.ceil((floorNull + 500) / 0.48);
  // A bloated stored summary: pushes usage over the 75% trigger and the
  // floor over target, while the floor without it still fits.
  const summaryToks = Math.ceil(0.75 * LIMIT) - 2400 + 100;
  db.prepare('INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)').run(id, 'S'.repeat(summaryToks * 4));
  const usage = sessions.getContextUsage(id, MODEL);
  assert.ok(usage.totalTokens > 0.75 * LIMIT, `precondition: ${usage.totalTokens} above trigger`);
  const beforeIds = sessions.loadSession(id).messages.map((row) => row.id);
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async (old) => old,
  });
  assert.equal(result.compressed, true);
  assert.equal(result.summaryDropped, true, 'explicit drop flag for the user notice');
  assert.equal(result.reason, 'summary-overflow-dropped');
  assert.ok(result.projectedTokens <= 0.50 * LIMIT);
  assert.equal(sessions.getSessionSummary(id), null, 'summary removed from context');
  const rows = sessions.loadSession(id).messages;
  assert.deepEqual(rows.map((row) => row.id), beforeIds, 'history preserved, nothing deleted');
  assert.deepEqual(tailIds(id), beforeIds.slice(-10), 'protected tail intact');
  // Context regained: no immediate retrigger, summary stays cleared.
  const again = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Must not run.',
  });
  assert.equal(again.compressed, false);
  assert.equal(sessions.getSessionSummary(id), null);
});

test('summary overflow with nothing archivable still regains context', async () => {
  const id = freshId('drop-short');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 5, 400);
  // Same dynamic sizing as above: 5 short messages plus a summary big enough
  // to trip the trigger, while the schema-inclusive floor without it fits.
  const tools = engine.resolveProjectionTools(id, MODEL, {});
  const floorNull = engine.projectIdlePrompt({ sessionId: id, modelId: MODEL,
    summaryText: null, briefSection: null, checkpointSection: null,
    retainedMessages: sessions.getActiveMessages(id), tools }).total;
  const LIMIT = Math.ceil((floorNull + 500) / 0.48);
  const summaryToks = Math.ceil(0.75 * LIMIT) - 500 + 100;
  db.prepare('INSERT INTO session_summaries(session_id, summary_text) VALUES (?, ?)').run(id, 'L'.repeat(summaryToks * 4));
  assert.ok(sessions.getContextUsage(id, MODEL).totalTokens > 0.75 * LIMIT);
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Must not run.',
  });
  assert.equal(result.compressed, false, 'nothing archived');
  assert.equal(result.archivedCount, 0);
  assert.equal(result.summaryDropped, true);
  assert.equal(result.reason, 'summary-overflow-dropped');
  assert.ok(result.projectedTokens <= 0.50 * LIMIT);
  assert.equal(sessions.getSessionSummary(id), null);
  assert.equal(sessions.loadSession(id).messages.length, 5, 'all messages preserved');
});

test('projection accounts for summaries, memories, briefs, worklog, and the protected tail', async () => {
  // Memories and worklog plumbing on a casual session. A dedicated model id
  // keeps the pinned memory scoped to this session only.
  const MEM_MODEL = 'idle-model-mem';
  const id = freshId('accounting');
  sessions.getOrCreateSession(id, MEM_MODEL);
  seedMessages(id, 12, 400);
  memory.addPermanentMemory({ category: 'preference', content: 'Pinned memory content for accounting.', scope: MEM_MODEL });
  const usage = sessions.getContextUsage(id, MEM_MODEL);
  assert.ok(usage.coreTokens > 0, 'pinned memory in usage');
  assert.ok(Number.isSafeInteger(usage.workLogTokens));
  const active = sessions.getActiveMessages(id);
  const base = engine.projectIdlePrompt({
    sessionId: id, modelId: MEM_MODEL, summaryText: null, briefSection: null, checkpointSection: null,
    retainedMessages: active, tools: [], memoryTokens: 0, workLogTokens: 0,
  });
  const withMemory = engine.projectIdlePrompt({
    sessionId: id, modelId: MEM_MODEL, summaryText: 'Prior summary text.', briefSection: null, checkpointSection: null,
    retainedMessages: active, tools: [], memoryTokens: usage.coreTokens, workLogTokens: 1234,
  });
  assert.ok(withMemory.breakdown.summaryTokens > 0, 'summary counted');
  assert.equal(withMemory.total - base.total, withMemory.breakdown.summaryTokens + usage.coreTokens + 1234);
  assert.ok(base.breakdown.tailTokens > 0, 'retained messages counted');

  // Briefs on a workspace session flow into the projection and the prompt.
  const project = projects.createProject({ name: 'Accounting Project' });
  const wid = freshId('accounting-ws');
  sessions.getOrCreateSession(wid, MODEL, project.id);
  sessions.saveMessage(wid, 'user', 'Build the accounting widget.');
  seedMessages(wid, 12, 400, 'WsBody');
  assert.ok(briefs.getApplicableBriefs(wid).length > 0, 'workspace brief exists');
  const briefSection = briefs.buildTaskBriefSection(wid);
  assert.ok(briefSection, 'brief section builds');
  assert.equal(workLog.buildWorkLogSection(wid, {}), null, 'digest-free session injects no worklog');
  const activeWs = sessions.getActiveMessages(wid);
  const withBrief = engine.projectIdlePrompt({
    sessionId: wid, modelId: MODEL, summaryText: null, briefSection, checkpointSection: null,
    retainedMessages: activeWs, tools: [], memoryTokens: 0, workLogTokens: 0,
  });
  assert.ok(withBrief.breakdown.briefTokens > 0, 'brief counted');
  const prompt = prepareChatMessages({ sessionId: wid, modelId: MODEL, userText: '', regenerate: true, regenerateLast: true });
  const contents = prompt.map((message) => (typeof message.content === 'string' ? message.content : ''));
  assert.ok(contents.some((content) => content.includes('[EARLIER CONVERSATION SUMMARY]:') || content.includes('Build the accounting widget.')));
});

test('brief and worklog injection keep working and archived history stays intact', async () => {
  const project = projects.createProject({ name: 'Injection Project' });
  const id = freshId('injection');
  sessions.getOrCreateSession(id, MODEL, project.id);
  sessions.saveMessage(id, 'user', 'Ship the injection widget.');
  seedMessages(id, 22, 400, 'Filler');
  const LIMIT = 2600;
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT,
    llmSummarizeCallback: async () => 'Injection rolling summary.',
    llmCheckpointCallback: async () => ({ objective: 'Ship the injection widget.', outstandingRequirements: [] }),
  });
  assert.equal(result.compressed, true);
  const prompt = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: '', regenerate: true, regenerateLast: true });
  const contents = prompt.map((message) => (typeof message.content === 'string' ? message.content : ''));
  const joined = contents.join('\n');
  assert.ok(joined.includes('Ship the injection widget.'), 'brief survives compression');
  assert.ok(joined.includes('Injection rolling summary.'), 'summary injected');
  const rows = sessions.loadSession(id).messages;
  assert.ok(rows.slice(-10).some((row) => row.archived), 'workspace tail is eligible for compaction');
  assert.ok(rows.filter((row) => row.archived).length > 0);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'no duplicated messages');
});

test('irreducible floor terminates safely with an explicit recoverable outcome', async () => {
  const id = freshId('irreducible');
  const LIMIT = 3000;
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 12, 800);
  const tools = bigTools(32000);
  const usage = sessions.getContextUsage(id, MODEL);
  assert.ok(usage.totalTokens > 0.75 * LIMIT, 'precondition: above trigger');
  const beforeIds = sessions.loadSession(id).messages.map((row) => row.id);
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT, tools,
    llmSummarizeCallback: async () => 'Irreducible summary.',
  });
  assert.equal(result.compressed, true);
  assert.equal(result.overTarget, true, 'explicit over-target flag');
  assert.equal(result.reason, 'projected-above-target');
  assert.equal(result.summaryDropped, undefined, 'summary kept when dropping would not regain the target');
  assert.ok(result.projectedTokens > 0.50 * LIMIT, 'projection still above target');
  assert.match(sessions.getSessionSummary(id) ?? '', /Irreducible summary/);
  const rows = sessions.loadSession(id).messages;
  assert.deepEqual(rows.map((row) => row.id), beforeIds, 'history preserved, nothing deleted');
  assert.deepEqual(tailIds(id), beforeIds.slice(-10), 'protected tail never archived');
  // A follow-up cycle must not destructively retry: nothing archivable remains.
  const again = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT, tools,
    llmSummarizeCallback: async () => 'Must not run.',
  });
  assert.equal(again.compressed, false);
  assert.deepEqual(tailIds(id), beforeIds.slice(-10));
});

test('forced compaction behavior remains intact', async () => {
  const id = freshId('forced');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 20, 400);
  const active = sessions.getActiveMessages(id);
  const seenArgs = [];
  // Window sized so the forced floor gate (system ~2.3K + tail + reserve)
  // admits the candidate: the gate itself is the pre-existing behavior.
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: 8000, force: true,
    llmSummarizeCallback: async (...args) => {
      seenArgs.push(args);
      return 'Forced summary.';
    },
  });
  assert.equal(result.compressed, true);
  assert.equal(result.archivedCount, active.length - 10, 'forced archives every candidate');
  assert.ok(!('projectedTokens' in result), 'forced result carries no idle projection');
  assert.equal(seenArgs[0].length, 2, 'forced summarize call shape unchanged');
  assert.ok(sessions.loadSession(id).messages.slice(-10).every((row) => !row.archived));
});

test('idle summary requests enforce the 512-token cap and receive the abort signal', async () => {
  const id = freshId('cap');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 20, 400);
  const controller = new AbortController();
  const seen = [];
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: 2600, signal: controller.signal,
    llmSummarizeCallback: async (old, batch, _model, opts) => {
      seen.push({ signal: opts?.signal, maxTokens: opts?.maxTokens });
      return 'Capped summary.';
    },
  });
  assert.equal(result.compressed, true);
  assert.ok(seen.length >= 1);
  for (const call of seen) {
    assert.equal(call.maxTokens, 512);
    assert.equal(call.signal, controller.signal, 'caller abort signal reaches the provider request');
  }
});

test('cancelled compaction leaves history and summary state intact', async () => {
  const id = freshId('cancel');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 20, 400);
  const before = sessions.loadSession(id).messages.map((row) => ({ id: row.id, archived: row.archived }));
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  await assert.rejects(
    engine.checkAndCompressContext({
      sessionId: id, modelId: MODEL, contextWindowLimit: 2600, signal: controller.signal,
      llmSummarizeCallback: async () => 'Must never commit.',
    }),
    (error) => error?.name === 'AbortError' || /abort|cancel/i.test(error?.message ?? ''),
  );
  assert.equal(sessions.getSessionSummary(id), null);
  assert.deepEqual(
    sessions.loadSession(id).messages.map((row) => ({ id: row.id, archived: row.archived })),
    before,
  );
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});

test('invalid and empty summaries never replace a valid summary', async () => {
  const id = freshId('invalid');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 20, 400);
  const first = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: 2600,
    llmSummarizeCallback: async () => 'Known good summary.',
  });
  assert.equal(first.compressed, true);
  const archivedBefore = sessions.loadSession(id).messages.filter((row) => row.archived).length;
  seedMessages(id, 15, 400, 'Extra');
  for (const bad of ['', '   ', 'bad\0summary']) {
    await assert.rejects(
      engine.checkAndCompressContext({
        sessionId: id, modelId: MODEL, contextWindowLimit: 2600,
        llmSummarizeCallback: async () => bad,
      }),
    );
    assert.equal(sessions.getSessionSummary(id), 'Known good summary.');
  }
  assert.equal(
    sessions.loadSession(id).messages.filter((row) => row.archived).length,
    archivedBefore,
    'failed summaries archive nothing further',
  );
});

test('provider errors leave the session recoverable', async () => {
  const id = freshId('provider');
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 20, 400);
  const before = sessions.loadSession(id).messages.map((row) => ({ id: row.id, archived: row.archived }));
  await assert.rejects(
    engine.checkAndCompressContext({
      sessionId: id, modelId: MODEL, contextWindowLimit: 2600,
      llmSummarizeCallback: async () => { throw new Error('summarizer offline'); },
    }),
    /offline/,
  );
  assert.deepEqual(
    sessions.loadSession(id).messages.map((row) => ({ id: row.id, archived: row.archived })),
    before,
  );
  assert.equal(sessions.getSessionSummary(id), null);
  assert.equal(sessions.loadSession(id).is_compressing, 0);
  const recovered = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: 2600,
    llmSummarizeCallback: async () => 'Recovery summary.',
  });
  assert.equal(recovered.compressed, true);
});

test('context-usage display stays consistent with the compaction projection', async () => {
  const id = freshId('consistent');
  const LIMIT = 3000;
  sessions.getOrCreateSession(id, MODEL);
  seedMessages(id, 12, 800);
  const tools = bigTools(32000);
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: LIMIT, tools,
    llmSummarizeCallback: async () => 'Consistency summary.',
  });
  assert.equal(result.compressed, true);
  // After archival the retained set equals the active set, so the usage
  // display and the projection must agree up to the documented fixed costs.
  const usage = sessions.getContextUsage(id, MODEL);
  const active = sessions.getActiveMessages(id);
  const summary = sessions.getSessionSummary(id);
  const projected = engine.projectIdlePrompt({
    sessionId: id, modelId: MODEL, summaryText: summary, briefSection: null, checkpointSection: null,
    retainedMessages: active, tools, memoryTokens: usage.coreTokens, workLogTokens: usage.workLogTokens,
  });
  const fixed = projected.breakdown.systemTokens + projected.breakdown.toolTokens
    + projected.breakdown.briefTokens + projected.breakdown.checkpointTokens;
  // The projection stores the summary with its `[EARLIER CONVERSATION
  // SUMMARY]:` marker prefix while usage counts the bare summary text; that
  // documented prefix is the only admitted difference.
  const markerOverhead = Math.ceil('[EARLIER CONVERSATION SUMMARY]:\n'.length / 4);
  assert.equal(projected.total - usage.totalTokens, fixed + markerOverhead);
});


test('short image-heavy workspace compacts from full-prompt pressure and preserves attachment evidence', async () => {
  const project = projects.createProject({ name: 'Image Workspace' });
  const id = freshId('images');
  const limit = 100000;
  sessions.getOrCreateSession(id, MODEL, project.id);
  const image = path.join(directory, 'tiny.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const { processUploads } = require('../src/main/fileUploads');
  for (let batch = 0; batch < 3; batch++) {
    const attachments = await processUploads(Array(8).fill(image));
    sessions.saveMessage(id, 'user', `Review batch ${batch}.`, attachments);
    sessions.saveMessage(id, 'assistant', `Observed layout details in batch ${batch}.`);
  }
  assert.equal(sessions.getContextUsage(id, MODEL).messageCount, 6);
  assert.ok(sessions.getContextUsage(id, MODEL).totalTokens < 1000);
  let imageCount = 0;
  const result = await engine.checkAndCompressContext({
    sessionId: id, modelId: MODEL, contextWindowLimit: limit, tools: [],
    llmSummarizeCallback: async (_old, batch) => {
      const content = require('../src/main/compactionCore').summaryUserContent(_old, batch);
      assert.ok(Array.isArray(content), 'vision parts reach the summarizer');
      assert.ok(!content[0].text.includes('base64,'), 'image bytes never become JSON text tokens');
      imageCount += content.filter(part => part.type === 'image_url').length;
      return 'Preserve observed layouts and the selected design direction.';
    },
    llmCheckpointCallback: async () => ({ objective: 'Review image layouts.', outstandingRequirements: [] }),
  });
  assert.equal(result.compressed, true);
  assert.ok(imageCount >= 16, 'image-heavy batches actually inspected before archival');
  assert.ok(Number.isSafeInteger(result.checkpointId));
  assert.ok(result.archivedCount > 0);
  assert.equal(sessions.loadSession(id).messages.length, 6, 'raw history remains stored');
  assert.ok(fs.existsSync(image));
  const rebuilt = require('../src/main/promptBuilder').rebuildChatMessages({ sessionId: id, modelId: MODEL });
  const remainingImages = rebuilt.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === 'image_url').length;
  assert.ok(remainingImages < 24, 'archived images leave the active request');
  assert.ok(rebuilt.some(message => message.role === 'user'), 'checkpoint-only continuation satisfies strict chat templates');
  assert.ok(briefs.getAllBriefs(id).length >= 3, 'task briefs remain');
});

test('workspace recovery keeps explicitly excluded in-flight messages verbatim', async () => {
  const project = projects.createProject({ name: 'In-flight Workspace' });
  const id = freshId('inflight');
  sessions.getOrCreateSession(id, MODEL, project.id);
  sessions.saveMessage(id, 'user', 'Build the widget.');
  sessions.saveMessage(id, 'assistant', 'Completed preparation.');
  const parked = sessions.saveMessage(id, 'assistant', 'In progress');
  const parkedId = typeof parked === 'number' ? parked : parked.id;
  const result = await engine.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: 100000, excludeMessageIds: [parkedId],
    llmSummarizeCallback: async () => 'Prepared widget.',
    llmCheckpointCallback: async () => ({ objective: 'Build the widget.', outstandingRequirements: [] }),
  });
  assert.equal(result.compressed, true);
  const rows = sessions.loadSession(id).messages;
  assert.equal(rows.find(row => row.id === parkedId).archived, 0);
  assert.ok(rows.slice(0, -1).every(row => row.archived));
});
