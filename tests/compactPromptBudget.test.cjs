'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/audits/compactPromptBudget.cjs');
test('fixed prompt budget is repeatable across timezone/profile environments and flags growth', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-budget-test-'));
  try {
    const environment = { ...process.env, NODE_ENV: 'production' };
    delete environment.NODE_TEST_CONTEXT;
    const results = [];
    for (const [index, TZ] of ['UTC', 'Asia/Dhaka'].entries()) {
      const output = path.join(directory, `${index}.json`);
      const child = spawnSync(process.execPath, [script, '--output', output], {
        env: { ...environment, TZ, CONTINUUM_NATIVE_TOOL_PROFILE: index ? 'full' : 'compact' },
        encoding: 'utf8', timeout: 30000,
      });
      assert.equal(child.status, 0, child.stderr + child.stdout);
      results.push(JSON.parse(fs.readFileSync(output)).records);
    }
    assert.deepEqual(results[0], results[1]);
    assert.ok(results[0][1].normalizedBytes < results[0][0].normalizedBytes);
    const tinyBaseline = path.join(directory, 'tiny.json');
    fs.writeFileSync(tinyBaseline, JSON.stringify({ normalizedBytes: { full: 1, compact: 1 } }));
    const growthOutput = path.join(directory, 'growth.json');
    const growth = spawnSync(process.execPath, [script, '--baseline', tinyBaseline, '--output', growthOutput], { env: environment, encoding: 'utf8', timeout: 30000 });
    assert.equal(growth.status, 1);
    const check = JSON.parse(fs.readFileSync(growthOutput)).budgetCheck;
    assert.equal(check.passed, false); assert.equal(check.failures.length, 2);
    assert.match(check.failures[0], /10% growth budget/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
