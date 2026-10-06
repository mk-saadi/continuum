const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSubagentTool, executeSpawnSubagent } = require('../src/main/tools/subagent');
const runner = require('../src/main/subAgentRunner');

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
  const original = runner.extractWebPageData;
  let call;
  runner.extractWebPageData = async options => { call = options; return 'Score: 68.0'; };
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
  } finally { runner.extractWebPageData = original; }
});

test('file invocation delegates exactly one absolute path to the isolated runner', async () => {
  const original = runner.runSubAgent;
  let call;
  runner.runSubAgent = async options => { call = options; return 'File summary'; };
  try {
    const answer = await executeSpawnSubagent({ task: 'Inspect error logs', target_file: '/abs/logs/app.log' });
    assert.equal(answer, 'File summary');
    assert.deepEqual(call.target_files, ['/abs/logs/app.log']);
    assert.match(call.task_description, /Inspect error logs/);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs', target_file: '' }), /target_file must be a non-empty absolute path/);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs' }), /Provide a url or target_file parameter/);
  } finally { runner.runSubAgent = original; }
});
