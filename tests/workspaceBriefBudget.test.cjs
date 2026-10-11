const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-brief-budget-'));
const originalLoad = Module._load;
const registered = new Map();
const mcp = Object.assign(new EventEmitter(), { init: async () => {}, reload: async () => {}, getTools: () => [], getStatus: () => ({ servers: [] }), configPath: path.join(directory, 'mcp.json') });
let transport;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn), removeHandler: channel => registered.delete(channel) },
    Notification: { isSupported: () => false }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } };
  if (name === './mcpManager') return mcp;
  if (name === './localEngineFetch') return { localEngineFetch: (...args) => transport.fetch(...args) };
  return originalLoad.call(this, name, ...args);
};

const { backend } = require('./fixtures/contextBackend.cjs');
const { initDatabase, closeDatabase } = require('../src/main/db');
initDatabase();
const sessions = require('../src/main/sessionManager');
const profiles = require('../src/main/profileSettings');
const projects = require('../src/main/projectManager');
const briefs = require('../src/main/taskBriefs');
const { prepareChatMessages, rebuildChatMessages, buildSessionSystemPrompt, getToolContext } = require('../src/main/promptBuilder');
const { prependBaseSystemPrompt } = require('../src/main/baseSystemPrompt');
const compression = require('../src/main/compressionEngine');
const { approximateTokens } = require('../src/main/contextBudget');

const project = projects.createProject({ name: 'Budget Project' });
const MODEL = 'model';
const LIMIT = 8192;
const reserveFor = (limit) => Math.min(1024, Math.floor(limit / 4)) + Math.min(128, Math.ceil(limit / 100));
const budgetFor = (limit) => limit - reserveFor(limit);

function workspaceSession(id) {
  sessions.getOrCreateSession(id, MODEL, project.id);
  return id;
}

function briefSections(prompt) {
  return prompt.filter(message => message.taskBrief === true
    || (message.role === 'system' && typeof message.content === 'string'
      && message.content.includes(briefs.SECTION_MARKER)));
}

const dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
  isTrustedSender: () => true,
  getEngineConfig: () => ({ modelPath: 'model', port: 9999, activeModelConfig: { contextLength: LIMIT } }),
  llmSummarizeCallback: async (_old, batch) => { assert.ok(batch.length); return 'Earlier conversation retained in this summary.'; },
});
const sender = Object.assign(new EventEmitter(), { send: () => {}, isDestroyed: () => false });
const event = { sender };

test.after(() => { dispose(); closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('a fitting brief does not imply a fitting prompt: complete request exceeds usable budget', () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Do the thing.');
  sessions.saveMessage(id, 'assistant', 'Doing it.');
  profiles.saveProfileSettings(null, { systemPrompt: 'x'.repeat(20000) });
  try {
    const applicable = briefs.getApplicableBriefs(id);
    const briefTokens = briefs.estimateBriefTokens(applicable);
    assert.ok(briefTokens < LIMIT, `briefTokens=${briefTokens} should fit the raw window`);
    const prompt = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'Another small instruction.', regenerate: false });
    assert.equal(briefSections(prompt).length, 1);
    const { tools } = getToolContext([], true, id, 'workspace_write');
    const measured = approximateTokens({ messages: prompt, tools });
    // The complete prompt (system instructions, project context, tool
    // schemas, history, brief, reserve) exceeds the usable budget even though
    // the brief alone fits. approximateTokens is the documented fallback
    // measurer, not an exact tokenizer count.
    assert.ok(measured > budgetFor(LIMIT), `measured=${measured} budget=${budgetFor(LIMIT)} briefTokens=${briefTokens}`);
  } finally {
    profiles.saveProfileSettings(null, { systemPrompt: '' });
  }
});

test('forced recovery refuses before the model call when non-compressible context cannot fit', async () => {
  const id = workspaceSession(crypto.randomUUID());
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Turn${i} `.padEnd(100, 'x'));
  const contents = sessions.loadSession(id).messages.map(row => row.content);
  profiles.saveProfileSettings(null, { systemPrompt: 'x'.repeat(32000) });
  try {
    let calls = 0;
    const attempt = () => compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
      contextWindowLimit: LIMIT, llmSummarizeCallback: async () => { calls++; return 'Must never be produced.'; } });
    const first = await attempt();
    assert.equal(first.compressed, false);
    assert.equal(first.reason, 'non-compressible-context-too-large');
    assert.equal(calls, 0);
    assert.equal(sessions.getSessionSummary(id), null);
    assert.ok(sessions.loadSession(id).messages.every(row => row.archived === 0 && row.is_summarized === 0));
    // A repeat attempt must not compress further either: termination, not erosion.
    const second = await attempt();
    assert.equal(second.compressed, false);
    assert.equal(second.reason, 'non-compressible-context-too-large');
    assert.equal(calls, 0);
    assert.deepEqual(sessions.loadSession(id).messages.map(row => row.content), contents);
    assert.ok(briefs.getApplicableBriefs(id).every(row => contents.some(content => content.includes(row.content_text.slice(0, 20)))));
  } finally {
    profiles.saveProfileSettings(null, { systemPrompt: '' });
  }
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});

test('forced recovery refuses after summarization when the grown summary breaks fit', async () => {
  const id = workspaceSession(crypto.randomUUID());
  // Two large assistant turns (no briefs) so the no-saving guard passes, then
  // short tail turns. Limit is calibrated from measured components so the
  // pre-LLM floor fits but the grown summary cannot.
  sessions.saveMessage(id, 'user', 'Calibrated requirement.');
  sessions.saveMessage(id, 'assistant', `BigA ${'a'.repeat(8000)}`);
  sessions.saveMessage(id, 'assistant', `BigB ${'b'.repeat(8000)}`);
  for (let i = 0; i < 10; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Tail${i} `.padEnd(120, 't'));
  assert.equal(sessions.loadSession(id).messages.length, 13);
  const sysEst = Math.ceil(JSON.stringify(buildSessionSystemPrompt({ sessionId: id, modelId: MODEL, delegationAvailable: false, userText: '' })).length / 4)
    + Math.ceil(JSON.stringify(prependBaseSystemPrompt([{ role: 'system', content: 'x' }], true)[0]).length / 4);
  const tailEst = 10 * Math.ceil(120 / 4);
  const briefEst = briefs.estimateBriefTokens(briefs.getApplicableBriefs(id));
  const limit = sysEst + tailEst + briefEst + 2000;
  assert.ok(limit > 0 && Number.isSafeInteger(limit));
  let calls = 0;
  const result = await compression.recoverContextOverflow({ sessionId: id, modelId: MODEL,
    contextWindowLimit: limit, llmSummarizeCallback: async () => { calls++; return `Grown ${'S'.repeat(14000)}`; } });
  assert.equal(result.compressed, false);
  assert.equal(result.reason, 'non-compressible-context-too-large');
  assert.equal(calls, 1);
  assert.equal(sessions.getSessionSummary(id), null);
  assert.ok(sessions.loadSession(id).messages.every(row => row.archived === 0 && row.is_summarized === 0));
  assert.equal(briefs.getApplicableBriefs(id).length, 6);
  assert.equal(sessions.loadSession(id).is_compressing, 0);
});

test('workspace normal send retains the brief in the dispatched payload', async () => {
  const id = workspaceSession(crypto.randomUUID());
  for (let i = 0; i < 6; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `Send${i} `.padEnd(100, 'x'));
  transport = backend({ tokens: text => Math.ceil(text.length / 4),
    infer: () => Response.json({ choices: [{ message: { content: 'Done [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  const messages = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'Final workspace instruction.', regenerate: false });
  const result = await registered.get('engine:chat')(event, { requestId: id, messageId: id, sessionId: id,
    modelId: MODEL, activeChatProvider: { type: 'local' }, messages });
  assert.equal(result.text, 'Done [TASK COMPLETE]');
  assert.equal(transport.calls.length, 1);
  const dispatched = transport.calls[0].messages;
  const sections = dispatched.filter(message => typeof message.content === 'string' && message.content.includes(briefs.SECTION_MARKER));
  assert.equal(sections.length, 1);
  assert.ok(sections[0].content.includes('Final workspace instruction.'));
  assert.ok(sections[0].content.includes('Send0'));
  assert.ok(briefs.getApplicableBriefs(id).some(row => row.content_text === 'Final workspace instruction.'));
});

test('branch execution context retains the applicable brief', () => {
  const id = workspaceSession(crypto.randomUUID());
  sessions.saveMessage(id, 'user', 'Branch task requirement.');
  sessions.saveMessage(id, 'assistant', 'Branch reply.');
  const target = sessions.saveMessage(id, 'user', 'Second branch instruction.');
  const { buildBranchContext } = require('../src/main/engineManager');
  const { messages } = buildBranchContext(target.id, MODEL);
  const sections = briefSections(messages);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].content.includes('Branch task requirement.'));
  assert.ok(sections[0].content.includes('Second branch instruction.'));
});

test('casual forced recovery creates no briefs and dispatches no brief section', async () => {
  const id = crypto.randomUUID();
  sessions.getOrCreateSession(id, MODEL);
  for (let i = 0; i < 20; i++) sessions.saveMessage(id, i % 2 ? 'user' : 'assistant', String(i).padEnd(100, 'x'));
  transport = backend({ tokens: text => Math.ceil(text.length / 4),
    infer: (_payload, count) => count === 1
      ? new Response(JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 8619, n_ctx: LIMIT } }), { status: 400 })
      : Response.json({ choices: [{ message: { content: 'Casual done [TASK COMPLETE]' }, finish_reason: 'stop' }] }) });
  const messages = prepareChatMessages({ sessionId: id, modelId: MODEL, userText: 'retry', regenerate: true });
  const result = await registered.get('engine:chat')(event, { requestId: id, messageId: id, sessionId: id,
    modelId: MODEL, activeChatProvider: { type: 'local' }, messages });
  assert.equal(result.text, 'Casual done [TASK COMPLETE]');
  assert.equal(transport.calls.length, 2);
  for (const call of transport.calls) {
    assert.ok(!JSON.stringify(call.messages).includes(briefs.SECTION_MARKER));
  }
  assert.deepEqual(briefs.getAllBriefs(id), []);
});
