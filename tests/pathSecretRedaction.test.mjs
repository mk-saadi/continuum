import test from 'node:test';
import assert from 'node:assert/strict';
import redaction from '../src/lib/secretRedaction.cjs';
import { formatToolResult } from '../src/lib/toolResultFormatter.mjs';
import { runMemoryChat, sanitizeChatMessages } from '../src/lib/memoryChat.mjs';
import digest from '../src/main/turnDigest.js';
const { redactSecrets } = redaction;
const root = '/home/mk_saadi/projects/test-projects/test-project-1';
const mixed = 'Abc123'.repeat(8);
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123';
const secret = 'ghp_' + 'x'.repeat(36);
const paths = [root, root + '/src', '/' + mixed, './' + mixed, '../' + mixed, '~/' + mixed,
  'src/' + 'a'.repeat(70), 'src/' + mixed + '.js', 'src/' + mixed + '-build',
  'src/' + mixed + '_build', 'build/app.3f9a2c1d7e.js', 'src/123e4567-e89b-12d3-a456-426614174000/x.js',
  'src/foo.js:123:5', root + ':123', 'a/src/x.js', 'b/src/x.js'];
for (const path of paths) test(`preserves path ${path}`, () => assert.equal(redactSecrets(path), path));
for (const wrap of [x => `"${x}"`, x => `'${x}'`, x => `(${x})`, x => `[${x}],`, x => `location=${x}`,
  x => JSON.stringify({ stdout: x }), x => `diff --git a/src/x.js b/src/x.js\n--- ${x}\n+++ ${x}`]) {
  test(`preserves wrapped paths ${wrap(root).slice(0, 22)}`, () => assert.equal(redactSecrets(wrap(root)), wrap(root)));
}
test('pwd, echo PWD, find and git outputs stay readable without marker', () => {
  for (const stdout of [root + '\n', `${root}\n${root}/src\n${root}/src/x.js\n`, ` M ${root}/src/x.js\ndiff --git a/src/x.js b/src/x.js`]) {
    const result = formatToolResult({ stdout }, 'execute_command', { workspaceRoot: root });
    assert.equal(JSON.parse(result.content).stdout, stdout);
    assert.equal(result.redacted, false);
  }
});
test('bare mixed segments are redacted at 32 characters, only that segment', () => {
  for (const segment of ['Abc123'.repeat(5) + 'Ab', mixed]) {
    assert.equal(redactSecrets(`src/${segment}/x.js`), 'src/[redacted token]/x.js');
  }
  const short = 'Abc123'.repeat(5) + 'A';
  assert.equal(redactSecrets(`src/${short}/x.js`), `src/${short}/x.js`);
});
test('nonpath base64 with slash remains redacted with and without padding', () => {
  const base64 = 'Abc123+/'.repeat(9);
  for (const suffix of ['', '=', '==']) assert.equal(redactSecrets(base64 + suffix), '[redacted token]');
  assert.equal(redactSecrets('Abc123/'.repeat(9) + '='), '[redacted token]');
});
test('generic threshold remains 48 and requires letters and digits', () => {
  assert.equal(redactSecrets('a'.repeat(46) + '1'), 'a'.repeat(46) + '1');
  assert.equal(redactSecrets('a'.repeat(47) + '1'), '[redacted token]');
  assert.equal(redactSecrets('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(redactSecrets('a1'.repeat(32)), '[redacted token]');
});
test('explicit signatures always win inside paths and workspace roots', () => {
  for (const token of [secret, 'sk-' + 'a'.repeat(36), jwt]) {
    assert.equal(redactSecrets(`/tmp/${token}/x`), '/tmp/[redacted]/x');
    assert.equal(redactSecrets(`/tmp/${token}/x`, { workspaceRoot: `/tmp/${token}` }), '/tmp/[redacted]/x');
  }
});
test('all existing secret families retain markers', () => {
  for (const token of [secret, 'gho_1234567890', 'github_pat_1234567890', 'gsk_1234567890',
    'sk-1234567890', 'xoxb-1234567890', 'AKIA1234567890ABCDEF']) assert.equal(redactSecrets(token), '[redacted]');
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), '[redacted private key]');
  assert.equal(redactSecrets('https://user:pass@example.com'), 'https://[redacted]@example.com');
  assert.equal(redactSecrets('api_key=/tmp/ordinary-path'), 'api_key=[redacted]');
  assert.equal(redactSecrets('Bearer abcdefgh1234'), 'bearer [redacted]');
});
test('JWT and Authorization values are redacted; prose is unchanged', () => {
  assert.equal(redactSecrets(jwt), '[redacted]');
  assert.equal(JSON.parse(formatToolResult({ Authorization: 'Basic abc123' }).content).Authorization, '[redacted]');
  assert.equal(JSON.parse(formatToolResult('{"Authorization":"Basic abc123"}').content).Authorization, '[redacted]');
  for (const text of ['Authorization: Basic abc123', 'Authorization=abcdef', '"Authorization": "Basic abc123"']) {
    assert.ok(!redactSecrets(text).includes('abc'));
    assert.match(redactSecrets(text), /\[redacted\]/);
  }
  for (const text of ['Authorization is required', 'Read the Authorization documentation']) assert.equal(redactSecrets(text), text);
});
test('workspace roots with spaces and separator boundaries', () => {
  const workspaceRoot = '/tmp/my workspace/' + mixed;
  const path = workspaceRoot + '/' + mixed + '/x.js';
  assert.equal(redactSecrets(path, { workspaceRoot }), path);
  assert.equal(redactSecrets(workspaceRoot + ':123:5', { workspaceRoot }), workspaceRoot + ':123:5');
  assert.equal(redactSecrets(`location="${path}:123:5"`, { workspaceRoot }), `location="${path}:123:5"`);
  const other = workspaceRoot + '-other/' + mixed;
  assert.match(redactSecrets(other, { workspaceRoot }), /redacted token/);
});
test('recursive JSON, tool results, replay and user cards agree', () => {
  const workspaceRoot = '/tmp/my workspace/' + mixed;
  const path = workspaceRoot + '/' + mixed;
  const raw = { stdout: path, nested: [{ path, token: 'sensitive-value', text: `/tmp/${jwt}` }] };
  const formatted = formatToolResult(raw, 'execute_command', { workspaceRoot });
  assert.equal(JSON.parse(formatted.content).stdout, path);
  assert.equal(JSON.parse(formatted.content).nested[0].text, '/tmp/[redacted]');
  assert.equal(formatted.displayResult.stdout, path);
  assert.equal(formatted.displayResult.nested[0].token, 'sensitive-value');
  assert.equal(formatted.displayResult.modelOutputRedacted, true);
  const history = sanitizeChatMessages([
    { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'execute_command', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call', content: JSON.stringify(raw) },
  ], undefined, { workspaceRoot });
  assert.equal(history.at(-1).content, formatted.content);
});
test('digests share the rootless recognizer', () => {
  assert.equal(digest.redactSecrets(root), root);
  assert.equal(digest.redactSecrets(`/tmp/${secret}`), '/tmp/[redacted]');
});

test('parent loop preserves workspace paths and redacts command, Git and subagent reports', async () => {
  const workspaceRoot = '/tmp/my workspace/' + mixed;
  const path = workspaceRoot + '/' + mixed;
  const names = ['execute_command', 'git_status', 'spawn_subagent'];
  const calls = names.map((name, i) => ({ id: `call-${i}`, type: 'function', function: { name, arguments: '{}' } }));
  const requests = [];
  let steps;
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'test', workspaceRoot,
    messages: [{ role: 'system', content: 'Helpful assistant' }],
    chatTools: names.map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    executeTool: async () => ({ stdout: path, report: `/tmp/${secret}` }),
    onExecutionSteps: value => { steps = value; },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: requests.length === 1 ? { tool_calls: calls } : { content: 'Done [TASK COMPLETE]' },
        finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] });
    },
  });
  const results = requests[1].messages.filter(message => message.role === 'tool');
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(JSON.parse(result.content).stdout, path);
    assert.equal(JSON.parse(result.content).report, '/tmp/[redacted]');
  }
  for (const step of steps) {
    assert.equal(step.result.stdout, path);
    assert.equal(step.result.report, `/tmp/${secret}`);
    assert.equal(step.result.modelOutputRedacted, true);
  }
});
