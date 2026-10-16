import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, SIDE_BY_SIDE_ROW_CAP } from '../src/lib/diffView.mjs';

test('pairs deletions with additions and tracks line numbers', () => {
  const text = [
    'diff --git a/f.txt b/f.txt',
    'index 111..222 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,4 +1,4 @@',
    ' same',
    '-old one',
    '-old two',
    '+new one',
    ' same2',
  ].join('\n');
  const parsed = parseUnifiedDiff(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hunks, 1);
  const kinds = parsed.rows.map((row) => row.type);
  assert.deepEqual(kinds, ['hunk', 'context', 'change', 'del', 'context']);
  const changed = parsed.rows[2];
  assert.equal(changed.left, 'old one');
  assert.equal(changed.right, 'new one');
  assert.equal(changed.leftNo, 2);
  assert.equal(changed.rightNo, 2);
  const leftover = parsed.rows[3];
  assert.equal(leftover.right, null);
  assert.equal(leftover.rightNo, null);
});

test('handles pure additions, multiple hunks, and no-newline markers', () => {
  const text = [
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    '\\ No newline at end of file',
    '@@ -10,2 +12,2 @@',
    ' ctx',
    '-gone',
    '+here',
  ].join('\n');
  const parsed = parseUnifiedDiff(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hunks, 2);
  assert.equal(parsed.rows[1].type, 'add');
  assert.equal(parsed.rows[1].leftNo, null);
  assert.equal(parsed.rows[3].type, 'note');
  const changed = parsed.rows.find((row) => row.type === 'change');
  assert.equal(changed.left, 'gone');
  assert.equal(changed.right, 'here');
});

test('rejects garbage and oversized input for unified fallback', () => {
  assert.equal(parseUnifiedDiff('').ok, false);
  assert.equal(parseUnifiedDiff(null).ok, false);
  assert.equal(parseUnifiedDiff('Binary files a/b and b/b differ\n').ok, false);
  assert.equal(parseUnifiedDiff('@@ -1,1 +1,1 @@\n?not a diff marker\n').ok, false);
  const big = `@@ -1 +1 @@\n ${'x'.repeat(10)}\n`.repeat(SIDE_BY_SIDE_ROW_CAP + 10);
  const capped = parseUnifiedDiff(big);
  assert.equal(capped.ok, false);
  assert.equal(capped.capped, true);
});
