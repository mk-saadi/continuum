// Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/skillProposalIpc.test.cjs
// B1: live `step-update` events are the renderer's only source of execution
// steps while a turn runs (and the only source after an abort), so they must
// carry the canonical structured `args` even past the 10,000-char display cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === './localEngineFetch') return { localEngineFetch: (...params) => global.fetch(...params) };
  if (name === './promptBuilder') return { ...originalLoad.call(this, name, ...args), buildSessionSystemPrompt: () => ({ role: 'system', content: 'test', memoryContext: true }) };
  if (name === './profileSettings') return { ...originalLoad.call(this, name, ...args),
    getSessionSettings: () => ({ effective: { memoryEnabled: false, allowMidRunQuestions: false }, params: {} }) };
  if (name === 'electron') return { app: { isReady: () => true }, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) } };
  return originalLoad.call(this, name, ...args);
};
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proposal-ipc-'));
const { initDatabase, db } = require('../src/main/db');
const manager = require('../src/main/mcpManager');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
const { getOrCreateSession } = require('../src/main/sessionManager');
Module._load = originalLoad;

initDatabase(directory);
manager.configPath = path.join(directory, 'mcp_config.json');
fs.writeFileSync(manager.configPath, JSON.stringify({ mcpServers: {} }));
manager.init = async () => {};
registerIpcHandlers({ isTrustedSender: event => event.trusted, getEngineConfig: () => ({ port: 12345 }), getReasoningEfforts: () => ['low', 'high'] });

const instructions = `# Large skill\n\n${'Repeatable step with details.\n'.repeat(800)}`;
const proposal = { name: 'large-skill', description: 'Keeps a long workflow', instructions };
assert.ok(JSON.stringify(proposal).length > 10_000, 'fixture must exceed the display cap');

const makeSender = () => {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.events = [];
  sender.send = (channel, payload) => sender.events.push({ channel, payload });
  return sender;
};
const chat = (sender, payload) => handlers.get('engine:chat')({ trusted: true, sender }, payload);
const stepUpdates = sender => sender.events.filter(event => event.channel === 'stream:step-update');

const proposeSkillCall = args => ({
  id: 'call1',
  type: 'function',
  function: { name: 'propose_skill', arguments: JSON.stringify(args) },
});
const toolCallTurn = args => Response.json({
  usage: { prompt_tokens: 12, completion_tokens: 5 },
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [proposeSkillCall(args)] } }],
});
const finalTurn = text => Response.json({
  usage: { prompt_tokens: 30, completion_tokens: 3 },
  // The loop auto-continues a tool-using turn whose final text lacks a terminal
  // marker, so the fixture ends the turn explicitly.
  choices: [{ finish_reason: 'stop', message: { content: `${text} [TASK COMPLETE]`, reasoning_content: 'Final thought' } }],
});

test('step-update keeps propose_skill args structured past 10,000 characters', async () => {
  const originalFetch = global.fetch;
  const turns = [];
  global.fetch = async (url, options) => {
    turns.push(JSON.parse(options.body));
    return turns.length === 1 ? toolCallTurn(proposal) : finalTurn('Proposal captured.');
  };
  try {
    const sender = makeSender();
    const result = await chat(sender, { requestId: 'req-large', modelId: 'model', messages: [{ role: 'user', content: 'Propose a skill' }] });
    assert.match(result.text, /Proposal captured/);
    assert.equal(turns.length, 2, 'one tool round plus the final response');
    assert.ok(turns[0].tools.some(tool => tool.function.name === 'propose_skill'), 'propose_skill is offered to the model');

    const updates = stepUpdates(sender);
    assert.ok(updates.length >= 2, 'pending and complete snapshots were published');
    for (const { payload } of updates) {
      for (const step of payload.executionSteps) {
        if (step.type !== 'tool_call') continue;
        assert.ok(step.args == null || (typeof step.args === 'object' && !Array.isArray(step.args)),
          `step-update args must stay structured, received ${typeof step.args}`);
      }
    }
    const live = updates.at(-1).payload.executionSteps.find(step => step.toolName === 'propose_skill');
    assert.equal(live.status, 'complete');
    assert.deepEqual(live.args, proposal);
    assert.equal(live.args.instructions, instructions);
    assert.ok(JSON.stringify(live.args).length > 10_000);

    // The authoritative invoke result is unchanged by the display boundary.
    const final = result.executionSteps.find(step => step.toolName === 'propose_skill');
    assert.deepEqual(final.args, proposal);
  } finally { global.fetch = originalFetch; }
});

test('small propose_skill args reach step-update unchanged', async () => {
  const small = { name: 'small-skill', description: 'Short one', instructions: 'Do the thing.' };
  const originalFetch = global.fetch;
  const turns = [];
  global.fetch = async (url, options) => {
    turns.push(JSON.parse(options.body));
    return turns.length === 1 ? toolCallTurn(small) : finalTurn('Done.');
  };
  try {
    const sender = makeSender();
    const result = await chat(sender, { requestId: 'req-small', modelId: 'model', messages: [{ role: 'user', content: 'Propose a skill' }] });
    const live = stepUpdates(sender).at(-1).payload.executionSteps.find(step => step.toolName === 'propose_skill');
    assert.deepEqual(live.args, small);
    assert.equal(typeof live.args, 'object');
    assert.deepEqual(live.args, result.executionSteps.find(step => step.toolName === 'propose_skill').args);
  } finally { global.fetch = originalFetch; }
});

test('aborted turn with a large propose_skill step still saves the message', async () => {
  getOrCreateSession('skill-abort-session', 'model');
  const sender = makeSender();
  const originalFetch = global.fetch;
  const turns = [];
  global.fetch = async (url, options) => {
    turns.push(JSON.parse(options.body));
    if (turns.length === 1) return toolCallTurn(proposal);
    // Hit Stop while the follow-up request is in flight, like the renderer does.
    // The listener must exist before the abort fires.
    const pending = new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
    });
    handlers.get('engine:cancel-chat')({ trusted: true, sender }, { requestId: 'req-abort' });
    return pending;
  };
  try {
    await assert.rejects(
      chat(sender, { requestId: 'req-abort', modelId: 'model', sessionId: 'skill-abort-session', messages: [{ role: 'user', content: 'Propose a skill' }] }),
      error => error.name === 'AbortError',
    );
  } finally { global.fetch = originalFetch; }

  const created = sender.events.find(event => event.channel === 'engine:chat-event' && event.payload.type === 'message-created');
  assert.ok(created, 'assistant message row exists before the abort');
  const messageId = created.payload.messageId;

  const updates = stepUpdates(sender);
  assert.ok(updates.length >= 1, 'the renderer saw live step snapshots before the abort');
  // Exactly what ChatInterface keeps after the invoke rejects: the last live
  // snapshot, finalized the same way its finally block finalizes running tools.
  const captured = updates.at(-1).payload.executionSteps.map(step =>
    step.type === 'tool_call' && ['pending', 'running'].includes(step.status)
      ? { ...step, status: 'error', error: 'Tool execution cancelled.' }
      : step);

  // finishMessage → session:save-message must not throw `Invalid tool step`.
  const saved = await handlers.get('session:save-message')({ trusted: true, sender }, {
    sessionId: 'skill-abort-session',
    role: 'assistant',
    content: 'Partial reply',
    messageId,
    executionSteps: captured,
  });
  assert.ok(saved, 'the interrupted reply was saved');

  const row = db.prepare('SELECT execution_steps FROM messages WHERE id = ?').get(messageId);
  const steps = JSON.parse(row.execution_steps);
  const step = steps.find(item => item.toolName === 'propose_skill');
  assert.equal(typeof step.args, 'object');
  assert.deepEqual(step.args, proposal);
  assert.equal(step.args.instructions, instructions);
});
