'use strict';

// Out-of-process fixture for tests/subagentOutOfProcessRecovery.test.cjs.
//
// This runs in its OWN OS process: it opens the shared SQLite directory, runs
// one real delegated investigation to a finite tool-call stop (so the child
// settles `partial` with a durable continuation record), prints the child id,
// closes the database and exits. A *different* process then verifies that the
// child is listed as recoverable and can be recovered and continued — the
// restart-recovery behavior Phase 1.5 must preserve.
//
// Args: <sqlite directory> <project root> <owner parent session id> <model port>

const Module = require('node:module');
const [directory, rootPath, owner, port] = process.argv.slice(2);

const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};

const db = require('../../src/main/db');
db.initDatabase(directory);
const settings = require('../../src/main/subagents/budgetSettings');
const runtime = require('../../src/main/subagents');

// A finite tool-call allowance of 1 makes the run stop with `partial` /
// `tool_limit`, which is exactly the renewable, durable continuation case.
settings.saveBudgetSettings({ mode: 'custom', maxInputTokens: null, maxOutputTokens: null,
  maxToolCalls: 1, maxTurns: null, maxAggregateToolCalls: null,
  maxRuntimeMs: null, requestTimeoutMs: null, requestInactivityMs: null });

const engine = { provider: 'local', port: Number(port) || 9, modelId: 'fixture', contextLength: 32768 };
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
let calls = 0;
const fetchImpl = async () => {
  calls += 1;
  if (calls === 1) {
    return Response.json({ choices: [{ finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [toolCall('t1', 'list_directory', { relative_path: '.' })] } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 } });
  }
  return Response.json({ choices: [{ finish_reason: 'stop',
    message: { content: 'Partial: listed the project directory.' } }],
    usage: { prompt_tokens: 60, completion_tokens: 8 } });
};

(async () => {
  let childId = null;
  await runtime.runInvestigation({
    parentSessionId: owner,
    task: 'List the project directory.',
    rootPath,
    engine,
    fetchImpl,
    onSpawn: id => { childId = id; },
  });
  process.stdout.write(`CHILD_ID=${childId}\n`);
  db.closeDatabase();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
