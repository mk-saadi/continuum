'use strict';
// Phase 1.5 — out-of-process restart-recovery verification.
//
// Unlike the in-process recovery tests, this deliberately splits the child's
// life across two OS processes:
//
//   Process A (tests/fixtures/subagentRestartChild.cjs)
//     opens the shared SQLite dir, runs one real delegated investigation to a
//     finite tool-call stop (`partial` / `tool_limit`), persists the durable
//     continuation record, and exits.
//
//   Process B (this test process)
//     starts from an empty in-memory runtime against the *same* directory and
//     proves the child is listed as recoverable, recovered, renewed and
//     continued — reusing the existing Phase 1.3C control surface only.
//
// Run with: node --test tests/subagentOutOfProcessRecovery.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-restart-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};

const OWNER = 'out-of-process-owner';
const fixture = path.join(__dirname, 'fixtures', 'subagentRestartChild.cjs');

test('a child persisted by another OS process is recovered and continued here', { timeout: 30000 }, async () => {
  // A live local-model stand-in the recovered child will call.
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: 'Recovered: directory listed.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 6 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // ---- Process A: run the child, persist it, exit. -------------------------
    const child = spawnSync(process.execPath, [fixture, directory, directory, OWNER, String(port)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || 'restart fixture failed');
    const match = /CHILD_ID=(\S+)/.exec(child.stdout);
    assert.ok(match, `child id was not reported: ${child.stdout}`);
    const childId = match[1];

    // ---- Process B: a fresh runtime over the same database directory. --------
    const db = require('../src/main/db');
    db.initDatabase(directory);
    const runtime = require('../src/main/subagents');
    try {
      const recoverable = runtime.listRecoverableChildren({});
      const entry = recoverable.find(item => item.childSessionId === childId);
      assert.ok(entry, 'the persisted child is listed as recoverable after a restart');
      assert.equal(entry.status, 'partial');
      assert.equal(entry.stopReason, 'tool_limit');
      assert.equal(entry.eligibility.requiresRenewal, true);
      assert.ok(entry.eligibility.reason.includes('budget') || entry.eligibility.reason === 'budget_exhausted');

      // Recovery rebuilds the child but never executes it.
      const recovered = runtime.recoverChild(childId, {
        parentSessionId: OWNER,
        engine: { provider: 'local', port, modelId: 'fixture', contextLength: 32768 },
      });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.eligibility.requiresRenewal, true);
      assert.equal(recovered.continuable, true);
      assert.equal(recovered.status, 'partial');

      // Continue with an authorized renewal; the same driver and context run.
      const done = once(runtime.backgroundEvents, 'completed');
      const continued = runtime.continueChild(childId, { parentSessionId: OWNER, renewal: { maxToolCalls: 5 } });
      assert.equal(continued.continued, true);
      const [event] = await done;
      assert.equal(event.childSessionId, childId);
      assert.equal(event.status, 'completed');

      const status = runtime.continuationStatus(childId, { parentSessionId: OWNER });
      assert.equal(status.status, 'completed');
      assert.equal(status.result, 'Recovered: directory listed.');
      // Consumption survived the restart and was never reset by recovery.
      assert.equal(status.allowance.consumed.toolCalls, 1);
      assert.equal(status.allowance.renewals.length, 1);
    } finally {
      db.closeDatabase();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
