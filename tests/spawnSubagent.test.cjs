const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSubagentTool, executeSpawnSubagent } = require('../src/main/tools/subagent');
const runner = require('../src/main/subAgentRunner');

test('spawn_subagent schema matches the prompt invocation', () => {
  const schema = spawnSubagentTool.function;
  assert.equal(schema.name, 'spawn_subagent');
  assert.deepEqual(schema.parameters.required, ['task']);
  for (const field of ['task', 'constraint', 'expected_output', 'url']) {
    assert.ok(schema.parameters.properties[field]);
  }
  assert.equal(schema.parameters.properties.target_files, undefined);
  assert.match(schema.description, /DO NOT use this tool to search, read, inspect, or parse local workspace files/);
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

test('file invocation is rejected before launching a worker', async () => {
  const original = runner.runSubAgent;
  let called = false;
  runner.runSubAgent = async () => { called = true; return 'unexpected'; };
  try {
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect error logs', target_files: ['logs/app.log'] }), /Do NOT use sub-agents for file inspection/);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs' }), /Provide one public web URL/);
    assert.equal(called, false);
  } finally { runner.runSubAgent = original; }
});
