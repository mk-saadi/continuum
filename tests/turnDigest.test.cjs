'use strict';
// Phase 1: pure per-turn work-digest builder (no DB, no prompt, no UI, no IPC).
// Run with: node --test tests/turnDigest.test.cjs
// Temp dirs are not needed: the builder is pure (steps in, digest out).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIGEST_VERSION,
  DIGEST_CHAR_CAP,
  WORKLOG_CHAR_CAP,
  LEDGER_ISSUE_CAP,
  estimateTokens,
  redactSecrets,
  classifyTool,
  reconcileIssues,
  buildTurnDigest,
} = require('../src/main/turnDigest');

const HASH40 = '0123456789abcdef0123456789abcdef01234567';
assert.match(HASH40, /^[0-9a-f]{40}$/);

// Steps mirror persisted execution_steps rows: {id, type, toolName, status,
// serverName?, args?, result?, error?, childSessionId?}. Results mirror the
// tool return shapes (displayResult): objects stay objects, text stays text.
const step = (overrides) => ({
  id: `step-${Math.random().toString(36).slice(2)}`,
  type: 'tool_call',
  status: 'complete',
  ...overrides,
});
const ctx = (overrides) => ({ turnSeq: 1, ...overrides });

test('classifies tools into stable kinds', () => {
  assert.equal(classifyTool('str_replace_editor'), 'edit');
  assert.equal(classifyTool('git_commit'), 'edit');
  assert.equal(classifyTool('read_project_file'), 'read');
  assert.equal(classifyTool('git_diff'), 'read');
  assert.equal(classifyTool('execute_command'), 'command');
  assert.equal(classifyTool('spawn_sub_agent'), 'delegate');
  assert.equal(classifyTool('get_single_web_page_content'), 'web');
  assert.equal(classifyTool('take_screenshot'), 'other');
  assert.equal(classifyTool('no_such_tool'), 'other');
});

test('extracts evidence per tool family without leaking content bytes', () => {
  const secretContent = 'line one\nline two\npassword=hunter2\n';
  const digest = buildTurnDigest(
    [
      step({ toolName: 'read_project_file', args: { relative_path: 'src/x.js' }, result: { content: secretContent } }),
      step({
        toolName: 'str_replace_editor',
        args: { relative_path: 'src/x.js', old_str: 'a\nb\n', new_str: 'a\nB\nc\n' },
        result: { success: true },
      }),
      step({
        toolName: 'execute_command',
        args: { command: 'npm test' },
        result: { stdout: 'ok\n', stderr: '', exitCode: 0 },
      }),
      step({
        toolName: 'git_commit',
        args: { message: 'fix x\n\nlong body' },
        result: { output: '[main abc1234]', hash: HASH40 },
      }),
      step({
        toolName: 'search_project_content',
        args: { query: 'TODO', relative_path: 'src' },
        result: { matches: [{}, {}, {}] },
      }),
    ],
    ctx({ turnSeq: 3 }),
  );
  assert.equal(digest.version, DIGEST_VERSION);
  assert.equal(digest.partial, false);
  assert.equal(digest.openIssues.length, 0);
  const byTool = Object.fromEntries(digest.entries.map((entry) => [entry.tool, entry]));
  assert.equal(byTool.read_project_file.summary, 'read src/x.js (35 chars)');
  assert.equal(byTool.str_replace_editor.summary, 'edited src/x.js (+3/-2)');
  assert.deepEqual([byTool.str_replace_editor.linesAdded, byTool.str_replace_editor.linesRemoved], [3, 2]);
  assert.equal(byTool.execute_command.summary, 'tests passed: npm test (exit 0)');
  assert.equal(byTool.execute_command.exitCode, 0);
  assert.equal(byTool.git_commit.hash, HASH40);
  assert.match(byTool.git_commit.summary, /\(0123456\)/);
  assert.match(byTool.search_project_content.summary, /3 match\(es\)/);
  // Content bytes never cross into the digest; the secret inside them neither.
  assert.doesNotMatch(digest.text, /line one/);
  assert.doesNotMatch(digest.text, /hunter2/);
  assert.doesNotMatch(JSON.stringify(digest.entries), /hunter2/);
});

test('never infers exit codes, hashes, or verdicts without evidence', () => {
  const digest = buildTurnDigest(
    [
      step({ toolName: 'execute_command', args: { command: 'ls -la' }, result: 'all good (plain string)' }),
      step({ toolName: 'git_commit', args: { message: 'wip' }, result: { output: '[main x]' } }),
      step({ toolName: 'execute_command', args: { command: 'ls' }, result: { stdout: '', stderr: '', exitCode: 0 } }),
    ],
    ctx(),
  );
  const [plain, noHash, plainExit] = digest.entries;
  assert.doesNotMatch(plain.summary, /exit/);
  assert.equal(plain.exitCode, null);
  assert.equal(plain.kind, 'command');
  assert.equal(noHash.hash, null);
  assert.doesNotMatch(noHash.summary, /\(/);
  assert.equal(plainExit.summary, 'ran \'ls\' (exit 0)');
  assert.equal(plainExit.kind, 'command');
  // A failing check is recorded as failed, not passed.
  const failed = buildTurnDigest(
    [step({ toolName: 'execute_command', args: { command: 'npm test' }, status: 'error', error: 'exit 1' })],
    ctx(),
  );
  assert.equal(failed.entries[0].kind, 'check');
  assert.match(failed.entries[0].summary, /tests failed/);
  assert.equal(failed.openIssues.length, 1);
  assert.equal(failed.openIssues[0].kind, 'check-failure');
});

test('treats explicit failure flags as errors even with a complete status', () => {
  const digest = buildTurnDigest(
    [step({ toolName: 'write_project_file', args: { relative_path: 'a.txt' }, result: { success: false, error: 'denied' } })],
    ctx(),
  );
  assert.equal(digest.entries[0].status, 'error');
  assert.equal(digest.openIssues.length, 1);
  assert.equal(digest.openIssues[0].kind, 'edit-failure');
});

test('prioritizes edits over reads and drops the lowest value first under cap pressure', () => {
  const reads = Array.from({ length: 40 }, (_, i) =>
    step({
      toolName: 'read_project_file',
      args: { relative_path: `src/deeply/nested/directory/file-number-${i}.javascript` },
      result: { content: 'x'.repeat(100) },
    }),
  );
  const digest = buildTurnDigest(
    [...reads, step({ toolName: 'str_replace_editor', args: { relative_path: 'a.txt', old_str: 'x', new_str: 'y' }, result: { success: true } })],
    ctx(),
  );
  assert.ok(digest.text.length <= DIGEST_CHAR_CAP, `cap exceeded: ${digest.text.length}`);
  assert.ok(digest.tokens <= 500, `token estimate exceeded: ${digest.tokens}`);
  assert.match(digest.text, /edited a\.txt/);
  assert.ok(digest.omitted.entries > 0, 'expected omissions under pressure');
  const rendered = digest.entries.length - digest.omitted.entries;
  assert.ok(rendered >= 1, 'at least the edit renders');
  assert.match(digest.text, /Omitted: \d+ entr/);
  // Open issues always outrank entries.
  const withIssue = buildTurnDigest(
    [
      ...reads.slice(0, 40),
      step({ toolName: 'execute_command', args: { command: 'npm test' }, status: 'error', error: 'boom' }),
    ],
    ctx(),
  );
  assert.ok(withIssue.text.length <= DIGEST_CHAR_CAP);
  assert.match(withIssue.text, /Open issues/);
  assert.match(withIssue.text, /tests failed/);
});

test('redacts secrets everywhere and preserves evidence hashes', () => {
  const digest = buildTurnDigest(
    [
      step({
        toolName: 'execute_command',
        args: { command: 'export GH_TOKEN=ghp_abc123DEF456 && curl https://user:s3cret@example.com/api' },
        status: 'error',
        error: 'auth failed, token expired',
      }),
      step({
        toolName: 'spawn_sub_agent',
        args: { task_description: 'use password=hunter2 to log in' },
        childSessionId: 'child-1',
        result: { text: 'done' },
      }),
      step({
        toolName: 'git_commit',
        args: { message: 'fix' },
        result: { output: 'ok', hash: HASH40 },
      }),
    ],
    ctx({ resolveChild: () => null }),
  );
  assert.doesNotMatch(digest.text, /ghp_abc123DEF456/);
  assert.doesNotMatch(digest.text, /s3cret@example/);
  assert.doesNotMatch(digest.text, /hunter2/);
  assert.match(digest.text, /\[redacted\]/);
  assert.match(digest.text, /\(0123456\)/);
  assert.match(digest.text, /\[redacted\]@example\.com/);
});

test('resolves delegated results through the injected resolver, never inventing them', () => {
  const withAnswer = buildTurnDigest(
    [step({ toolName: 'spawn_sub_agent', args: { task_description: 'survey auth' }, childSessionId: 'c1', result: {} })],
    ctx({ resolveChild: (id) => (id === 'c1' ? 'auth lives in lib/auth.js' : null) }),
  );
  assert.match(withAnswer.entries[0].summary, /auth lives in lib\/auth\.js/);
  const withoutAnswer = buildTurnDigest(
    [step({ toolName: 'spawn_sub_agent', args: { task_description: 'survey auth' }, childSessionId: 'c1', result: {} })],
    ctx({ resolveChild: () => null }),
  );
  assert.match(withoutAnswer.entries[0].summary, /result unavailable/);
  const throwing = buildTurnDigest(
    [step({ toolName: 'spawn_sub_agent', args: { task_description: 'survey auth' }, childSessionId: 'c1', result: {} })],
    ctx({
      resolveChild: () => {
        throw new Error('store gone');
      },
    }),
  );
  assert.match(throwing.entries[0].summary, /result unavailable/);
  // Evidence already on the step wins over the resolver.
  const direct = buildTurnDigest(
    [step({ toolName: 'delegate_task', args: { task_description: 'x' }, result: 'direct answer here' })],
    ctx({ resolveChild: () => 'ignored' }),
  );
  assert.match(direct.entries[0].summary, /direct answer here/);
});

test('issue lifecycle: open, resolve on matching evidence, stay open otherwise', () => {
  const failed = step({
    toolName: 'str_replace_editor',
    args: { relative_path: 'a.txt', old_str: 'x', new_str: 'y' },
    status: 'error',
    error: 'no match',
  });
  const first = buildTurnDigest([failed], ctx({ turnSeq: 1 }));
  assert.equal(first.openIssues.length, 1);
  assert.equal(first.openIssues[0].id, 'iss-1');
  assert.equal(first.openIssues[0].kind, 'edit-failure');
  assert.equal(first.openIssues[0].status, 'open');
  assert.equal(first.resolvedThisTurn, 0);
  assert.match(first.text, /edit failed: edit:a\.txt/);

  // Same-path success resolves.
  const fixed = buildTurnDigest(
    [step({ toolName: 'str_replace_editor', args: { relative_path: 'a.txt', old_str: 'x', new_str: 'y' }, result: { success: true } })],
    ctx({ turnSeq: 2, prevLedger: first.ledger }),
  );
  assert.equal(fixed.openIssues.length, 0);
  assert.equal(fixed.resolvedThisTurn, 1);
  assert.equal(fixed.ledger.issues[0].status, 'resolved');
  assert.equal(fixed.ledger.issues[0].resolvedTurn, 2);
  assert.equal(fixed.ledger.nextId, 2);

  // Unrelated success leaves it open (still-open transition).
  const other = buildTurnDigest(
    [step({ toolName: 'str_replace_editor', args: { relative_path: 'b.txt', old_str: 'x', new_str: 'y' }, result: { success: true } })],
    ctx({ turnSeq: 2, prevLedger: first.ledger }),
  );
  assert.equal(other.openIssues.length, 1);
  assert.equal(other.openIssues[0].status, 'open');
  assert.equal(other.resolvedThisTurn, 0);
  assert.match(other.text, /edit failed: edit:a\.txt/);

  // An empty turn carries the ledger through byte-identically.
  const quiet = buildTurnDigest([], ctx({ turnSeq: 3, prevLedger: first.ledger }));
  assert.deepEqual(quiet.ledger, first.ledger);
  assert.match(quiet.text, /edit failed: edit:a\.txt/);
});

test('command and check issues resolve only on the same command with exit 0', () => {
  const failed = buildTurnDigest(
    [step({ toolName: 'execute_command', args: { command: 'npm test' }, result: { stdout: '', stderr: 'fail', exitCode: 1 }, status: 'error' })],
    ctx({ turnSeq: 1 }),
  );
  assert.equal(failed.openIssues[0].kind, 'check-failure');
  const prev = failed.ledger;
  // Different passing command does NOT resolve (strict, documented).
  const other = buildTurnDigest(
    [step({ toolName: 'execute_command', args: { command: 'npm run lint' }, result: { stdout: '', stderr: '', exitCode: 0 } })],
    ctx({ turnSeq: 2, prevLedger: prev }),
  );
  assert.equal(other.openIssues.length, 1);
  // Same command passing resolves.
  const fixed = buildTurnDigest(
    [step({ toolName: 'execute_command', args: { command: '  npm   test ' }, result: { stdout: '', stderr: '', exitCode: 0 } })],
    ctx({ turnSeq: 2, prevLedger: prev }),
  );
  assert.equal(fixed.openIssues.length, 0);
  assert.equal(fixed.resolvedThisTurn, 1);
});

test('reconcileIssues is a pure deterministic reducer', () => {
  const entries = [
    { kind: 'edit', tool: 'write_project_file', status: 'error', paths: ['a.txt'], summary: 'x', exitCode: null, hash: null, linesAdded: null, linesRemoved: null, issueId: null, stepIndex: 0 },
  ];
  const first = reconcileIssues(undefined, entries, 4);
  const second = reconcileIssues({ version: 1, nextId: 1, issues: [] }, entries, 4);
  assert.deepEqual(first.ledger, second.ledger);
  assert.equal(first.ledger.issues[0].id, 'iss-1');
  assert.equal(first.ledger.issues[0].openedTurn, 4);
  assert.equal(first.resolvedThisTurn, 0);
  assert.equal(first.evicted, 0);
});

test('ledger eviction keeps the cap with explicit accounting', () => {
  const failures = Array.from({ length: 25 }, (_, i) =>
    step({ toolName: 'write_project_file', args: { relative_path: `f${i}.txt` }, status: 'error', error: `bad ${i}` }),
  );
  const digest = buildTurnDigest(failures, ctx());
  assert.equal(digest.ledger.issues.length, LEDGER_ISSUE_CAP);
  assert.ok(digest.omitted.issues >= 5, `expected evictions, got ${JSON.stringify(digest.omitted)}`);
  assert.ok(digest.text.length <= DIGEST_CHAR_CAP);
  assert.match(digest.text, /Omitted: .*issue/);
});

test('partial turns record unfinished work without classifying it', () => {
  const digest = buildTurnDigest(
    [
      step({ toolName: 'apply_patch', status: 'running', args: { patch: '--- a\n+++ b\n@@\n-x\n+y\n' } }),
      step({ toolName: 'read_project_file', status: 'pending', args: { relative_path: 'a.txt' } }),
      step({ toolName: 'git_commit', args: { message: 'done' }, result: { output: 'ok', hash: HASH40 } }),
    ],
    ctx({ partial: true, turnSeq: 9 }),
  );
  assert.equal(digest.partial, true);
  assert.match(digest.text, /partial/);
  const unfinished = digest.entries.filter((entry) => entry.status === 'unfinished');
  assert.equal(unfinished.length, 2);
  assert.equal(digest.openIssues.length, 0);
  assert.match(digest.text, /Unfinished:/);
  assert.match(digest.text, /started apply_patch — unfinished/);
  // Completed work in a partial turn is still recorded normally.
  assert.match(digest.text, /committed 'done'/);
});

test('partial flag with prior open issue still reconciles on completed evidence', () => {
  const first = buildTurnDigest(
    [step({ toolName: 'str_replace_editor', args: { relative_path: 'a.txt', old_str: 'x', new_str: 'y' }, status: 'error', error: 'miss' })],
    ctx({ turnSeq: 1 }),
  );
  const second = buildTurnDigest(
    [
      step({ toolName: 'read_project_file', status: 'running', args: { relative_path: 'a.txt' } }),
      step({ toolName: 'str_replace_editor', args: { relative_path: 'a.txt', old_str: 'x', new_str: 'y' }, result: { success: true } }),
    ],
    ctx({ turnSeq: 2, partial: true, prevLedger: first.ledger }),
  );
  assert.equal(second.openIssues.length, 0);
  assert.equal(second.resolvedThisTurn, 1);
});

test('empty and thought-only turns render honestly', () => {
  const empty = buildTurnDigest([], ctx({ turnSeq: 5 }));
  assert.match(empty.text, /No tool operations recorded/);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.openIssues, []);
  assert.equal(empty.omitted.entries, 0);
  const thoughts = buildTurnDigest(
    [{ id: 't', type: 'thought', content: 'hmm', durationMs: 10 }],
    ctx({ turnSeq: 6 }),
  );
  assert.match(thoughts.text, /No tool operations recorded/);
});

test('identical inputs produce byte-identical output', () => {
  const steps = [
    step({ id: 's1', toolName: 'execute_command', args: { command: 'npm test' }, status: 'error', error: 'boom', result: { exitCode: 1 } }),
    step({ id: 's2', toolName: 'read_project_file', args: { relative_path: 'a.txt' }, result: { content: 'hi\n' } }),
  ];
  const ledgers = [
    { version: 1, nextId: 4, issues: [{ id: 'iss-2', kind: 'op-failure', tool: 'x', sig: 'op:x:', status: 'open', excerpt: 'e', openedTurn: 1, resolvedTurn: null }] },
    { version: 1, nextId: 4, issues: [{ id: 'iss-2', kind: 'op-failure', tool: 'x', sig: 'op:x:', status: 'open', excerpt: 'e', openedTurn: 1, resolvedTurn: null }] },
  ];
  const first = buildTurnDigest(structuredClone(steps), { turnSeq: 7, prevLedger: ledgers[0], resolveChild: () => null });
  const second = buildTurnDigest(structuredClone(steps), { turnSeq: 7, prevLedger: ledgers[1], resolveChild: () => null });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.text.length <= DIGEST_CHAR_CAP, true);
});

test('web sources record URLs, never content', () => {
  const digest = buildTurnDigest(
    [
      step({
        toolName: 'get_single_web_page_content',
        args: { url: 'https://example.com/docs', query: 'auth' },
        result: { content: 'A'.repeat(9000) },
      }),
      step({
        toolName: 'extract_web_page_data',
        args: { url: 'https://user:pw@example.com/a' },
        status: 'error',
        error: 'timeout',
      }),
    ],
    ctx(),
  );
  assert.match(digest.text, /fetched https:\/\/example\.com\/docs/);
  assert.doesNotMatch(digest.text, /AAAA/);
  assert.doesNotMatch(digest.text, /:pw@/);
  assert.match(digest.text, /\[redacted\]@example\.com/);
  assert.equal(digest.openIssues[0].kind, 'web-failure');
});

test('git and move verbs stay specific with evidence only', () => {
  const digest = buildTurnDigest(
    [
      step({ toolName: 'git_stage', args: { paths: ['a.txt', 'b.txt'] }, result: { output: '', staged: ['a.txt', 'b.txt'] } }),
      step({ toolName: 'move_project_file', args: { source_path: 'a.txt', destination_path: 'b.txt' }, result: { success: true } }),
      step({ toolName: 'git_create_branch', args: { name: 'feat' }, result: { output: '', branch: 'feat', switched: true } }),
    ],
    ctx(),
  );
  assert.match(digest.text, /staged a\.txt, b\.txt/);
  assert.match(digest.text, /moved a\.txt → b\.txt/);
  assert.match(digest.text, /created branch feat/);
});

test('input validation is strict and junk steps are skipped', () => {
  assert.throws(() => buildTurnDigest('nope', ctx()), /steps must be an array/);
  assert.throws(() => buildTurnDigest([], {}), /turnSeq/);
  assert.throws(() => buildTurnDigest([], ctx({ turnSeq: -1 })), /turnSeq/);
  assert.throws(() => buildTurnDigest([], ctx({ turnSeq: 1.5 })), /turnSeq/);
  assert.throws(() => buildTurnDigest([], ctx({ resolveChild: 42 })), /resolveChild/);
  const junk = buildTurnDigest([null, 42, 'x', { type: 'banana' }, { id: 'ok', toolName: 'git_status', status: 'complete', args: {}, result: { output: '' } }], ctx());
  assert.equal(junk.entries.length, 1);
  assert.match(junk.text, /status: clean/);
});

test('structured output carries typed fields for the future UI', () => {
  const digest = buildTurnDigest(
    [step({ toolName: 'execute_command', args: { command: 'npm test', cwd: '/tmp/x' }, result: { stdout: '', stderr: '', exitCode: 0 } })],
    ctx({ turnSeq: 2 }),
  );
  const entry = digest.entries[0];
  assert.deepEqual(Object.keys(entry), ['kind', 'tool', 'status', 'paths', 'summary', 'exitCode', 'hash', 'linesAdded', 'linesRemoved', 'issueId']);
  assert.equal(entry.kind, 'check');
  assert.equal(digest.ledger.version, 1);
  assert.ok(digest.tokens <= 500, `per-digest token budget exceeded: ${digest.tokens}`);
  assert.ok(WORKLOG_CHAR_CAP >= 4 * DIGEST_CHAR_CAP, 'global budget must admit four capped digests');
});

test('estimateTokens documents its approximate nature', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(null), 0);
});
