const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSubagentTool, executeSpawnSubagent } = require('../src/main/tools/subagent');
const runtime = require('../src/main/subagents');

test('spawn_sub_agent schema matches the prompt invocation', () => {
  const schema = spawnSubagentTool.function;
  assert.equal(schema.name, 'spawn_sub_agent');
  assert.deepEqual(schema.parameters.required, ['task']);
  for (const field of ['task', 'constraint', 'expected_output', 'url']) {
    assert.ok(schema.parameters.properties[field]);
  }
  assert.ok(schema.parameters.properties.target_file);
  assert.equal(schema.parameters.properties.target_files, undefined);
  assert.match(schema.description, /isolated web research/);
  assert.ok(require('../src/main/tools/agentTools').agentTools.includes(spawnSubagentTool));
});

test('web invocation passes one URL and constraints to the isolated extractor', async () => {
  const original = runtime.runWebExtraction;
  let call;
  runtime.runWebExtraction = async options => { call = options; return 'Score: 68.0'; };
  try {
    const answer = await executeSpawnSubagent({
      task: 'Inspect https://example.com/benchmarks and extract MMLU.',
      constraint: 'No raw HTML.', expected_output: 'One-row markdown table.',
      engine: { port: 4321, modelId: 'model' },
    });
    assert.equal(answer, 'Score: 68.0');
    assert.equal(call.url, 'https://example.com/benchmarks');
    assert.match(call.query, /No raw HTML/);
    assert.match(call.query, /One-row markdown table/);
    await assert.rejects(executeSpawnSubagent({ task: 'Compare https://a.example/a and https://b.example/b' }), /one web URL/);
  } finally { runtime.runWebExtraction = original; }
});

test('file invocation delegates exactly one absolute path to the isolated runtime', async () => {
  const original = runtime.runFileAnalysis;
  let call;
  runtime.runFileAnalysis = async options => { call = options; return 'File summary'; };
  try {
    const answer = await executeSpawnSubagent({ task: 'Inspect error logs', target_file: '/abs/logs/app.log' });
    assert.equal(answer, 'File summary');
    assert.deepEqual(call.target_files, ['/abs/logs/app.log']);
    assert.match(call.task_description, /Inspect error logs/);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs', target_file: '' }), /target_file must be a non-empty absolute path/);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs' }), /Provide a url or target_file parameter/);
  } finally { runtime.runFileAnalysis = original; }
});

test('investigate routes a task-only delegation to the child agent loop', async () => {
  const original = runtime.runInvestigation;
  let call;
  runtime.runInvestigation = async options => { call = options; return 'Investigation report'; };
  try {
    const answer = await executeSpawnSubagent({
      task: 'Investigate how authentication works.',
      expected_output: 'A markdown summary.', constraint: 'No speculation.',
      investigate: true, rootPath: '/project', engine: { port: 4321, modelId: 'model' },
      parentSessionId: 'parent-loop',
    });
    assert.equal(answer, 'Investigation report');
    assert.match(call.task, /Investigate how authentication works\./);
    assert.match(call.task, /Expected output: A markdown summary\./);
    assert.match(call.task, /Constraint: No speculation\./);
    assert.equal(call.rootPath, '/project');
    assert.equal(call.parentSessionId, 'parent-loop');
    // The additive option is validated and exclusive with the one-shot paths.
    await assert.rejects(executeSpawnSubagent({ task: 'x', investigate: 'yes' }), /investigate must be a boolean/);
    await assert.rejects(executeSpawnSubagent({ task: 'x', investigate: true, url: 'https://example.com' }), /not both/);
    await assert.rejects(executeSpawnSubagent({ task: 'x', investigate: true, target_file: '/abs/a.txt' }), /not both/);
    // Existing callers keep the exact pre-existing behavior.
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs' }), /Provide a url or target_file parameter/);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs', investigate: false }), /Provide a url or target_file parameter/);
  } finally { runtime.runInvestigation = original; }
});

test('the investigate option stays additive to the spawn schema', () => {
  const schema = spawnSubagentTool.function;
  assert.equal(schema.parameters.properties.investigate.type, 'boolean');
  assert.ok(schema.parameters.properties.investigate.description.includes('investigate autonomously'));
  assert.deepEqual(schema.parameters.required, ['task']);
  assert.equal(schema.parameters.additionalProperties, false);
  assert.match(schema.description, /isolated web research/);
  assert.match(schema.description, /investigate=true/);
});
