'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectTap, mayMaskExit } = require('../src/main/testVerification');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = (failed = false) => `TAP version 13\n# Subtest: outer\n    # Subtest: nested\n    ok 1 - nested\n    1..1\n${failed ? 'not ok' : 'ok'} 1 - outer\n1..1\n# tests 2\n# suites 0\n# pass ${failed ? 1 : 2}\n# fail ${failed ? 1 : 0}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
test('complete TAP uses top-level numbering and nested summary counts independently', () => {
 assert.equal(inspectTap(fixture()).complete, true);
 assert.equal(inspectTap(fixture(true)).failures, 1);
 assert.equal(inspectTap(fixture(true)).complete, true);
});
test('filtered, contradictory, duplicate and truncated TAP never establish success', () => {
 for (const text of [fixture().replace('TAP version 13\n', ''), fixture().replace('# pass 2', '# pass 7'), fixture() + '# fail 0\n', fixture().replace('ok 1 - outer\n', '')]) assert.equal(inspectTap(text).complete, false);
 assert.equal(inspectTap(fixture(), true).complete, false);
 assert.equal(inspectTap(fixture(true).split('\n').slice(-9).join('\n')).failures, 1);
 assert.equal(inspectTap('prose not ok 1 is only a string').failures, 0);
});
test('masking constructs detected without treating quoted data as pipelines', () => {
 for (const cmd of ['node --test x | tail -20', 'node --test x || true', 'node --test x; exit 0', 'node --test x && echo done']) assert.equal(mayMaskExit(cmd), true);
 assert.equal(mayMaskExit("printf 'a|b'"), false);
});
test('real failing Node pipeline exits zero while TAP establishes failure', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-pipeline-'));
 try {
  fs.writeFileSync(path.join(dir, 'fail.cjs'), "require('node:test')('r4 failure', () => { throw Error('expected'); });");
  const result = cp.spawnSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} --test --test-reporter=tap fail.cjs | tail -100`], { cwd: dir, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });
  assert.equal(result.status, 0);
  assert.equal(inspectTap(result.stdout).failures, 1);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
