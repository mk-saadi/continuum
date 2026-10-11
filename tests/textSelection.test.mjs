import test from 'node:test';
import assert from 'node:assert/strict';
import { clampMenuPosition, combineQuotedMessage, extractScopedSelectionText } from '../src/lib/textSelection.mjs';

const scopeContaining = (...nodes) => ({
  contains: (node) => nodes.includes(node),
});

const selection = ({ text, anchorNode = 'a', focusNode = 'b', collapsed = false, rangeCount = 1 }) => ({
  isCollapsed: collapsed,
  rangeCount,
  anchorNode,
  focusNode,
  toString: () => text,
});

test('extractScopedSelectionText returns trimmed text inside the scope', () => {
  const scope = scopeContaining('a', 'b');
  assert.equal(extractScopedSelectionText(scope, selection({ text: '  hello world  ' })), 'hello world');
});

test('extractScopedSelectionText rejects collapsed, empty, and out-of-scope selections', () => {
  const scope = scopeContaining('a', 'b');
  assert.equal(extractScopedSelectionText(scope, selection({ text: 'x', collapsed: true })), '');
  assert.equal(extractScopedSelectionText(scope, selection({ text: '   ' })), '');
  assert.equal(extractScopedSelectionText(scope, selection({ text: 'x', anchorNode: 'elsewhere' })), '');
  assert.equal(extractScopedSelectionText(scope, selection({ text: 'x', focusNode: 'elsewhere' })), '');
  assert.equal(extractScopedSelectionText(scope, selection({ text: 'x', rangeCount: 0 })), '');
  assert.equal(extractScopedSelectionText(null, selection({ text: 'x' })), '');
  assert.equal(extractScopedSelectionText(scope, null), '');
});

test('clampMenuPosition prefers above and clamps to the viewport', () => {  const above = clampMenuPosition({ left: 200, top: 300, bottom: 320, width: 50, height: 20 });
  assert.equal(above.placement, 'above');
  assert.equal(above.top, 300 - 38 - 10);
  assert.equal(above.left, 200);

  const nearTop = clampMenuPosition({ left: 200, top: 20, bottom: 40, width: 50, height: 20 });
  assert.equal(nearTop.placement, 'below');
  assert.equal(nearTop.top, 40 + 10);

  const nearRight = clampMenuPosition({ left: 5000, top: 300, bottom: 320, width: 50, height: 20 });
  assert.ok(nearRight.left <= 1024 - 216 - 8);

  const nearLeft = clampMenuPosition({ left: -50, top: 300, bottom: 320, width: 50, height: 20 });
  assert.equal(nearLeft.left, 8);
});

test('combineQuotedMessage prepends the excerpt as a quote block', () => {
  assert.equal(
    combineQuotedMessage('line one\nline two', 'what does this do?'),
    '> line one\n> line two\n\nwhat does this do?',
  );
});

test('combineQuotedMessage sends a bare quote block when no text is typed', () => {
  assert.equal(combineQuotedMessage('some excerpt', '   '), '> some excerpt');
});

test('combineQuotedMessage returns text untouched when there is no quote', () => {
  assert.equal(combineQuotedMessage('', 'hello'), 'hello');
  assert.equal(combineQuotedMessage('   ', 'hello'), 'hello');
  assert.equal(combineQuotedMessage(null, 'hello'), 'hello');
});
