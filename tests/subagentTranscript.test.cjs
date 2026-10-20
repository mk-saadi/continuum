'use strict';
// Sub-agent activity observability: child-session linkage and bounded
// read-only transcripts. Run with: node --test tests/subagentTranscript.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-transcript-'));
const originalLoad = Module._load;
// Mock only the transport: the child loop, runtime, and tool registry run for
// real against a temporary project root.
const turns = [];
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => directory },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
  };
  if (name === './localEngineFetch' || name.endsWith('/localEngineFetch')) {
    return { localEngineFetch: async (url) => {
      // Context measurement probes the local server's native endpoints. This
      // mock serves only inference turns, so answer probes as an older server
      // would (404) and let measurement fall back instead of consuming a turn.
      if (/\/(props|apply-template|tokenize)$/.test(String(url))) return Response.json({}, { status: 404 });
      return turns.shift() ?? Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    } };
  }
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase, db } = require('../src/main/db');
initDatabase();
const { createSession, completeSession, failSession } = require('../src/main/subagents/sessionManager');
const { createExecution, completeExecution } = require('../src/main/subagents/executionStore');
const runtime = require('../src/main/subagents');
const { normalizeExecutionSteps } = require('../src/main/executionSteps');

const toolTurn = (calls) => Response.json({
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: calls } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const answerTurn = (content) => Response.json({
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
});

async function main() {
  await test('unknown children report found:false instead of throwing', () => {
    assert.deepEqual(runtime.getChildTranscript('nope'), { found: false });
    assert.deepEqual(runtime.getChildTranscript(null), { found: false });
  });

  await test('transcript exposes bounded turns, usage, and terminal state', () => {
    const session = createSession({ parentSessionId: 'parent', model: 'm', provider: 'local' });
    const attempt = createExecution({ sessionId: session.id, kind: 'investigation', background: false, controller: new AbortController() });
    session.context = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"relative_path":"."}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: `ok${'x'.repeat(9000)}` },
    ];
    completeExecution(attempt, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, result: 'done' });
    const { completeSession: finish } = require('../src/main/subagents/sessionManager');
    const started = { ...session, status: 'running' };
    Object.assign(session, started);
    finish(session, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, result: 'Final answer text.' });
    const transcript = runtime.getChildTranscript(session.id);
    assert.equal(transcript.found, true);
    assert.equal(transcript.status, 'completed');
    assert.equal(transcript.turnCount, 1);
    assert.equal(transcript.turns.length, 4);
    assert.equal(transcript.turns[2].toolCalls[0].name, 'list_directory');
    const toolTurnView = transcript.turns[3];
    assert.equal(toolTurnView.role, 'tool');
    assert.equal(toolTurnView.text.truncated, true);
    assert.ok(toolTurnView.text.text.length <= 3000);
    assert.equal(transcript.result.text, 'Final answer text.');
    assert.equal(transcript.error, null);
  });

  await test('saved transcripts remain readable without an in-memory child', () => {
    for (const status of ['completed', 'failed']) {
      const id = `saved-${status}`;
      db.prepare(`INSERT INTO subagent_runs(child_session_id, status, task_text, output_text, error_text,
        thoughts_text, tools_json, turns_json, total_tokens, duration_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, status, 'Saved task',
          status === 'completed' ? 'Saved answer' : null, status === 'failed' ? 'Saved error' : null,
          'Saved thinking', JSON.stringify([{ name: 'read_file', calls: 1 }]),
          JSON.stringify([{ role: 'assistant', text: { text: 'Saved turn' }, toolCalls: [] }]),
          42, 1000, new Date().toISOString());
      const transcript = runtime.getChildTranscript(id);
      assert.equal(transcript.found, true);
      assert.equal(transcript.persisted, true);
      assert.equal(transcript.status, status);
      assert.equal(transcript.task, 'Saved task');
      assert.equal(transcript.totalTokens, 42);
      assert.equal(transcript.turns[0].text.text, 'Saved turn');
      assert.equal(transcript.activity[0].text, 'Saved thinking');
      assert.equal(transcript.toolsUsed[0].name, 'read_file');
      assert.equal(transcript.result?.text ?? null, status === 'completed' ? 'Saved answer' : null);
      assert.equal(transcript.error, status === 'failed' ? 'Saved error' : null);
    }
  });

  await test('failed children surface the error', () => {
    const session = createSession({ parentSessionId: 'p' });
    Object.assign(session, { ...session, status: 'running' });
    failSession(session, new Error('boom'));
    const transcript = runtime.getChildTranscript(session.id);
    assert.equal(transcript.found, true);
    assert.equal(transcript.status, 'failed');
    assert.equal(transcript.error, 'boom');
    assert.deepEqual(transcript.turns, []);
  });

  await test('spawn reports the child session before finishing and links the transcript', async () => {
    const { executeAgentTool } = require('../src/main/tools/agentTools');
    const root = path.join(directory, 'proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    turns.push(
      toolTurn([{ id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"relative_path":"."}' } }]),
      answerTurn('Saw a.txt.'),
    );
    const seen = [];
    const output = await executeAgentTool({ name: 'spawn_sub_agent', sessionId: null, permissionMode: 'workspace_write',
      arguments: JSON.stringify({ task: 'What is in this directory?', investigate: true }),
      engine: { provider: 'local', port: 1, modelId: 'm', contextLength: 8192 },
      rootPath: root, onChildSession: (id) => seen.push(id) });
    assert.equal(typeof output, 'string');
    assert.match(output, /a\.txt/);
    assert.equal(seen.length, 1);
    const transcript = runtime.getChildTranscript(seen[0]);
    assert.equal(transcript.found, true);
    assert.equal(transcript.status, 'completed');
    assert.ok(transcript.turns.some(t => t.toolCalls.some(c => c.name === 'list_directory')));
  });

  await test('childSessionId survives step persistence round-trips', () => {
    const steps = normalizeExecutionSteps([{ id: 'c1', type: 'tool_call', toolName: 'spawn_sub_agent',
      status: 'complete', childSessionId: 'parent_child_123', args: {}, result: 'done' }]);
    assert.equal(steps[0].childSessionId, 'parent_child_123');
  });

  await test('activity feed is bounded and null-safe', () => {
    const { pushActivity, ACTIVITY_LIMIT, createSession } = require('../src/main/subagents/sessionManager');
    assert.equal(pushActivity(null, { type: 'turn' }), null);
    const session = createSession({});
    assert.deepEqual(session.activity, []);
    for (let i = 0; i < ACTIVITY_LIMIT + 10; i++) pushActivity(session, { type: 'turn', turn: i });
    assert.equal(session.activity.length, ACTIVITY_LIMIT);
    assert.equal(session.activity[0].turn, 10);
    assert.ok(typeof session.activity[0].t === 'number');
    pushActivity(session, { type: 'thought', text: 'x'.repeat(2000) });
    assert.ok(session.activity.at(-1).text.length <= 601);
  });

  await test('the loop records activity without changing its outcome', async () => {
    const { runInvestigationExecution } = require('../src/main/subagents/agentLoop');
    const root = path.join(directory, 'loop-proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
    const engine = { provider: 'local', port: 9, modelId: 'm', contextLength: 8192 };
    const messageWith = (message) => Response.json({ choices: [{ message }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    let calls = 0;
    const fetchImpl = async () => (++calls === 1
      ? messageWith({ content: null, reasoning_content: 'I should list the directory first.',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"relative_path":"."}' } }] })
      : messageWith({ content: 'Found a.txt.' }));
    const session = {};
    const { output } = await runInvestigationExecution({ session, task: 'What is here?',
      rootPath: root, engine, fetchImpl });
    assert.equal(output, 'Found a.txt.');
    assert.deepEqual(session.activity.map(event => event.type), ['turn', 'queued', 'generating', 'thought', 'tool', 'tool-result', 'turn', 'queued', 'generating']);
    assert.equal(session.activity[3].text, 'I should list the directory first.');
    assert.equal(session.activity[4].name, 'list_directory');
    assert.equal(session.activity[5].ok, true);
  });

  await test('transcript carries the activity feed for the modal poller', () => {
    const { createSession } = require('../src/main/subagents/sessionManager');
    const { pushActivity } = require('../src/main/subagents/sessionManager');
    const session = createSession({ parentSessionId: 'p' });
    pushActivity(session, { type: 'turn', turn: 1 });
    pushActivity(session, { type: 'tool', turn: 1, name: 'list_directory' });
    const transcript = runtime.getChildTranscript(session.id);
    assert.equal(transcript.found, true);
    assert.equal(transcript.activity.length, 2);
    assert.equal(transcript.activity[1].name, 'list_directory');
  });

  await test('completed runs persist input, output, thoughts, tools, and metadata', async () => {
    const mainSessions = require('../src/main/sessionManager');
    mainSessions.getOrCreateSession('px', 'm');
    db.prepare("UPDATE sessions SET agent_profile = ? WHERE id = 'px'")
      .run(JSON.stringify({ name: 'Tester' }));
    const { executeAgentTool } = require('../src/main/tools/agentTools');
    const big = 'Y'.repeat(5000);
    turns.push(
      toolTurn([{ id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"relative_path":"."}' } }]),
      Response.json({ choices: [{ finish_reason: 'stop',
        message: { content: big, reasoning_content: 'I listed the files.' } }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }),
    );
    const root = path.join(directory, 'persist-proj');
    fs.mkdirSync(root, { recursive: true });
    const output = await executeAgentTool({ id: 'call-7', name: 'spawn_sub_agent', sessionId: 'px',
      permissionMode: 'workspace_write', arguments: JSON.stringify({ task: 'What is here?', investigate: true }),
      engine: { provider: 'local', port: 9, modelId: 'm', contextLength: 8192 }, rootPath: root });
    assert.equal(typeof output, 'string');
    const row = db.prepare('SELECT * FROM subagent_runs WHERE parent_tool_call_id = ?').get('call-7');
    assert.ok(row, 'run persisted with parent linkage');
    assert.equal(row.parent_session_id, 'px');
    assert.equal(row.kind, 'investigation');
    assert.equal(row.agent_name, 'Tester');
    assert.equal(row.status, 'completed');
    assert.match(row.task_text, /What is here\?/);
    assert.equal(row.output_text.length, 5000);
    assert.match(row.thoughts_text, /I listed the files/);
    const tools = JSON.parse(row.tools_json);
    assert.ok(tools.some(t => t.name === 'list_directory' && t.calls >= 1));
    assert.equal(row.total_tokens, 50 + 15);
    assert.ok(row.duration_ms == null || row.duration_ms >= 0);
    assert.ok(row.created_at && row.started_at && row.completed_at && row.updated_at);
    assert.ok(!('tokens_per_second' in row) && !('tokensPerSecond' in row));
    const storedTurns = JSON.parse(row.turns_json);
    assert.ok(storedTurns.length >= 3);
  });

  await test('failed runs persist the error and upsert on resume', async () => {
    const { executeAgentTool } = require('../src/main/tools/agentTools');
    turns.push(new Response('err', { status: 500 }));
    const failed = await executeAgentTool({ id: 'call-8', name: 'spawn_sub_agent', sessionId: null,
      permissionMode: 'read_only', arguments: JSON.stringify({ task: 'Will fail', investigate: true }),
      engine: { provider: 'local', port: 9, modelId: 'm', contextLength: 8192 }, rootPath: directory });
    assert.match(failed?.error ?? JSON.stringify(failed), /HTTP 500/);
    let row = db.prepare('SELECT * FROM subagent_runs WHERE parent_tool_call_id = ?').get('call-8');
    assert.ok(row);
    assert.equal(row.status, 'failed');
    assert.match(row.error_text, /HTTP 500/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subagent_runs WHERE parent_tool_call_id = ?').get('call-8').n, 1);
    // Resume → re-complete upserts the same row instead of inserting (driven
    // through the interrupt path, since failed sessions are terminal).
    const { waitSession, resumeSession, startSession, interruptSession, completeSession, createSession, getSession } =
      require('../src/main/subagents/sessionManager');
    void getSession;
    const resumed = createSession({ parentSessionId: 'px2' });
    startSession(resumed);
    interruptSession(resumed);
    const interrupted = db.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(resumed.id);
    assert.equal(interrupted.status, 'interrupted');
    waitSession(resumed); resumeSession(resumed);
    completeSession(resumed, { result: 'recovered answer' });
    row = db.prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?').get(resumed.id);
    assert.equal(row.status, 'completed');
    assert.equal(row.output_text, 'recovered answer');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subagent_runs WHERE child_session_id = ?').get(resumed.id).n, 1);
  });

  await test('one-shot runs persist input detail and file activity', async () => {
    const { executeAgentTool } = require('../src/main/tools/agentTools');
    const root = path.join(directory, 'oneshot-persist');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'c.txt'), 'see this');
    turns.push(answerTurn('Saw it.'));
    await executeAgentTool({ id: 'call-9', name: 'spawn_sub_agent', sessionId: null,
      permissionMode: 'read_only', arguments: JSON.stringify({ task: 'Read it', target_file: path.join(root, 'c.txt') }),
      engine: { provider: 'local', port: 9, modelId: 'm', contextLength: 8192 }, rootPath: root });
    const row = db.prepare('SELECT * FROM subagent_runs WHERE parent_tool_call_id = ?').get('call-9');
    assert.ok(row);
    assert.match(row.task_text, /Read it/);
    assert.match(row.task_text, /c\.txt/);
    assert.ok(JSON.parse(row.tools_json).some(t => t.name.startsWith('read:')));
  });


  const { runFileAnalysisExecution, runWebExtractionExecution } = require('../src/main/subagents/executionManager');
  const engine = { provider: 'local', port: 9, modelId: 'm', contextLength: 32768 };
  const answerWith = (content, reasoning) => Response.json({ choices: [{ message: { content, reasoning_content: reasoning } }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });

  await test('file analysis records file and thinking activity', async () => {
    const root = path.join(directory, 'oneshot-proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'b.txt'), 'file body');
    const session = {};
    const fetchImpl = async () => answerWith('Summary of b.', 'Considering the file content.');
    const { output } = await runFileAnalysisExecution({ session, task_description: 'Summarize.', target_files: ['b.txt'],
      rootPath: root, engine, fetchImpl });
    assert.equal(output, 'Summary of b.');
    const kinds = session.activity.map(event => event.type);
    assert.deepEqual(kinds, ['file', 'turn', 'queued', 'generating', 'thought']);
    assert.equal(session.activity.find(event => event.type === 'file').path, 'b.txt');
    assert.ok(session.activity.find(event => event.type === 'file').chars > 0);
    assert.equal(session.activity[4].text, 'Considering the file content.');
  });

  await test('web extraction records fetch activity', async () => {
    const session = {};
    const pageFetchImpl = async () => new Response('<html><body>page text here</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } });
    const fetchImpl = async () => answerWith('Page says hi.');
    const { output } = await runWebExtractionExecution({ session, url: 'https://example.com/x', query: 'What?',
      engine, pageFetchImpl, fetchImpl });
    assert.equal(output, 'Page says hi.');
    const kinds = session.activity.map(event => event.type);
    assert.deepEqual(kinds, ['note', 'fetch', 'turn', 'queued', 'generating']);
    assert.equal(session.activity[1].url, 'https://example.com/x');
  });

  console.log('Sub-agent transcript: linkage, bounds, terminal states, persistence, and one-shot activity passed.');
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


