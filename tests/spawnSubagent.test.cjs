const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSubagentTool, executeSpawnSubagent } = require('../src/main/tools/subagent');
const runner = require('../src/main/subAgentRunner');

test('spawn_subagent schema matches the prompt invocation', () => {
  const schema = spawnSubagentTool.function;
  assert.equal(schema.name, 'spawn_subagent');
  assert.deepEqual(schema.parameters.required, ['task']);
  for (const field of ['task', 'constraint', 'expected_output', 'url', 'target_files']) {
    assert.ok(schema.parameters.properties[field]);
  }
  assert.match(schema.description, /isolated, throwaway context/);
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

test('file invocation passes project-relative paths and returns a bounded summary', async () => {
  const original = runner.runSubAgent;
  let call;
  runner.runSubAgent = async options => { call = options; return 'x'.repeat(3000); };
  try {
    const answer = await executeSpawnSubagent({ task: 'Inspect error logs', target_files: ['logs/app.log'],
      constraint: 'Return only relevant errors.', rootPath: '/project', engine: { port: 4321, modelId: 'model' } });
    assert.deepEqual(call.target_files, ['logs/app.log']);
    assert.equal(call.rootPath, '/project');
    assert.match(call.task_description, /Return only relevant errors/);
    assert.ok(answer.length <= 1800);
    await assert.rejects(executeSpawnSubagent({ task: 'Inspect logs' }), /URL or target_files/);
  } finally { runner.runSubAgent = original; }
});
