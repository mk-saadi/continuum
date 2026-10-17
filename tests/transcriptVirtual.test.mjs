import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OVERSCAN_PX,
  DEFAULT_ROW_ESTIMATE_PX,
  TRANSCRIPT_GAP_PX,
  buildPrefix,
  computeVirtualLayout,
  estimateRowHeight,
  expandRangeForPins,
  offsetOfIndex,
} from '../src/lib/transcriptVirtual.mjs';

// Height cache stand-in: the module only requires a Map-like `get`.
const heightsFor = (sizes) => {
  const cache = new Map();
  sizes.forEach((size, index) => {
    if (size != null) cache.set(`m${index}`, size);
  });
  return cache;
};
const keysFor = (count) => Array.from({ length: count }, (_, index) => `m${index}`);

// Rebuild the flex column's total height from the derived spacers and the
// mounted rows, including the row-gap between every adjacent pair of children.
// It must equal the height the full (unmounted) content would have had.
function rebuiltHeight(layout, prefix, gap) {
  const mounted = [];
  for (let index = layout.first; index <= layout.last; index += 1) {
    mounted.push(prefix[index + 1] - prefix[index] - gap);
  }
  const children = mounted.length + (layout.topSpacer > 0 ? 1 : 0) + (layout.bottomSpacer > 0 ? 1 : 0);
  const sum = layout.topSpacer + layout.bottomSpacer + mounted.reduce((a, b) => a + b, 0);
  return sum + gap * Math.max(0, children - 1);
}

test('buildPrefix accumulates row pitch and matches the content height definition', () => {
  const keys = keysFor(5);
  const heights = heightsFor([10, 20, 30, 40, 50]);
  const { prefix, sizes } = buildPrefix(5, (index) => keys[index], heights, DEFAULT_ROW_ESTIMATE_PX, 7);
  assert.equal(prefix.length, 6);
  assert.equal(sizes.length, 5);
  // Each step is size + gap.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(prefix[index + 1] - prefix[index], sizes[index] + 7);
  }
  // prefix[count] - gap is the full height with no trailing gap.
  assert.equal(prefix[5] - 7, 10 + 20 + 30 + 40 + 50 + 7 * 4);
});

test('unmeasured rows fall back to the estimate for their slot', () => {
  const keys = keysFor(4);
  const heights = heightsFor([null, 30, null, 30]);
  const { sizes } = buildPrefix(4, (index) => keys[index], heights, 120, TRANSCRIPT_GAP_PX);
  assert.deepEqual(Array.from(sizes), [120, 30, 120, 30]);
});

test('the derived spacers reconstruct the full content height exactly', () => {
  const keys = keysFor(40);
  const heights = heightsFor(Array.from({ length: 40 }, (_, index) => 40 + (index % 5) * 17));
  const { prefix, sizes } = buildPrefix(40, (index) => keys[index], heights, DEFAULT_ROW_ESTIMATE_PX, TRANSCRIPT_GAP_PX);
  for (const scrollTop of [0, 500, 2_000, 1e9]) {
    const layout = computeVirtualLayout({
      prefix,
      count: 40,
      gap: TRANSCRIPT_GAP_PX,
      scrollTop,
      viewportHeight: 611,
      overscan: DEFAULT_OVERSCAN_PX,
    });
    assert.equal(rebuiltHeight(layout, prefix, TRANSCRIPT_GAP_PX), layout.contentHeight);
    assert.equal(layout.totalHeight, layout.contentHeight);
    assert.ok(layout.first >= 0 && layout.last < 40 && layout.last >= layout.first);
    // Spacer sizes are never negative.
    assert.ok(layout.topSpacer >= 0 && layout.bottomSpacer >= 0);
    assert.ok(sizes.length === 40);
  }
});

test('the mounted range tracks the scroll position and stays bounded', () => {
  const count = 300;
  const keys = keysFor(count);
  const heights = heightsFor(Array.from({ length: count }, () => 90));
  const { prefix } = buildPrefix(count, (index) => keys[index], heights, DEFAULT_ROW_ESTIMATE_PX, TRANSCRIPT_GAP_PX);
  const viewport = 611;
  const overscan = DEFAULT_OVERSCAN_PX;
  const maxScroll = prefix[count] - TRANSCRIPT_GAP_PX - viewport;
  const step = (90 + TRANSCRIPT_GAP_PX) * 8;

  let widest = 0;
  for (let scrollTop = 0; scrollTop <= maxScroll; scrollTop += step) {
    const layout = computeVirtualLayout({ prefix, count, gap: TRANSCRIPT_GAP_PX, scrollTop, viewportHeight: viewport, overscan });
    widest = Math.max(widest, layout.last - layout.first + 1);
    // Every row that can be visible in the viewport must be mounted.
    const firstVisible = Math.max(0, Math.ceil(scrollTop / (90 + TRANSCRIPT_GAP_PX)) - 1);
    assert.ok(layout.first <= firstVisible, `row ${firstVisible} should be mounted at scrollTop ${scrollTop}`);
  }
  // Bounded independently of the 300-message window: viewport + overscan fit in
  // roughly (611 + 2*480) / pitch rows, well under 20.
  assert.ok(widest <= 18, `mounted range stayed bounded (${widest})`);
  assert.ok(widest >= 4, 'the mounted range is never degenerate');

  // Scroll to the very top and the very bottom: the range reaches each end.
  const top = computeVirtualLayout({ prefix, count, gap: TRANSCRIPT_GAP_PX, scrollTop: 0, viewportHeight: viewport, overscan });
  assert.equal(top.first, 0);
  const bottom = computeVirtualLayout({ prefix, count, gap: TRANSCRIPT_GAP_PX, scrollTop: 1e9, viewportHeight: viewport, overscan });
  assert.equal(bottom.last, count - 1);
});

test('variable heights are measured, not assumed uniform', () => {
  const count = 60;
  const keys = keysFor(count);
  const sizes = Array.from({ length: count }, (_, index) => (index === 30 ? 900 : 60));
  const heights = heightsFor(sizes);
  const { prefix } = buildPrefix(count, (index) => keys[index], heights, DEFAULT_ROW_ESTIMATE_PX, TRANSCRIPT_GAP_PX);
  // Scroll so the tall row 30 is in the middle of the viewport.
  const scrollTop = prefix[30] - 200;
  const layout = computeVirtualLayout({ prefix, count, gap: TRANSCRIPT_GAP_PX, scrollTop, viewportHeight: 611, overscan: 0 });
  assert.ok(layout.first <= 30 && layout.last >= 30, 'the tall row must be mounted');
  // A uniform estimate would not have used row 30's real height.
  assert.equal(prefix[31] - prefix[30] - TRANSCRIPT_GAP_PX, 900);
});

test('estimateRowHeight uses the median once enough rows are measured', () => {
  assert.equal(estimateRowHeight(new Map()), DEFAULT_ROW_ESTIMATE_PX);
  assert.equal(estimateRowHeight(new Map([['a', 10], ['b', 20]])), DEFAULT_ROW_ESTIMATE_PX);
  const measured = new Map([['a', 10], ['b', 20], ['c', 30], ['d', 400]]);
  // Median of 10, 20, 30, 400 is 25, robust to the outlier.
  assert.equal(estimateRowHeight(measured), 25);
  assert.equal(estimateRowHeight(null, 77), 77);
});

test('expandRangeForPins keeps a focused row mounted but never unboundedly', () => {
  const range = { first: 100, last: 110 };
  assert.deepEqual(expandRangeForPins(range, null), range);
  assert.deepEqual(expandRangeForPins(range, []), range);
  // A row just above/below extends the range.
  assert.deepEqual(expandRangeForPins(range, [98, 113], 60), { first: 98, last: 113 });
  // A pin far away is ignored rather than exploding the DOM bound.
  assert.deepEqual(expandRangeForPins(range, [0], 60), range);
  assert.deepEqual(expandRangeForPins(range, [1000], 60), range);
  // A pin within the range is a no-op.
  assert.deepEqual(expandRangeForPins(range, [105], 60), range);
});

test('offsetOfIndex returns the row top and degrades safely', () => {
  const keys = keysFor(3);
  const heights = heightsFor([10, 20, 30]);
  const { prefix } = buildPrefix(3, (index) => keys[index], heights, DEFAULT_ROW_ESTIMATE_PX, 5);
  assert.equal(offsetOfIndex(prefix, 0, 3), 0);
  assert.equal(offsetOfIndex(prefix, 2, 3), prefix[2]);
  assert.equal(offsetOfIndex(prefix, -1, 3), 0);
  assert.equal(offsetOfIndex(prefix, 9, 3), 0);
});

test('count 0 and tiny windows degrade without throwing', () => {
  const empty = computeVirtualLayout({ prefix: new Float64Array(1), count: 0, viewportHeight: 611 });
  assert.deepEqual(empty, { first: 0, last: -1, topSpacer: 0, bottomSpacer: 0, totalHeight: 0, contentHeight: 0 });
  const keys = keysFor(2);
  const heights = heightsFor([90, 90]);
  const { prefix } = buildPrefix(2, (index) => keys[index], heights, DEFAULT_ROW_ESTIMATE_PX, TRANSCRIPT_GAP_PX);
  const layout = computeVirtualLayout({ prefix, count: 2, scrollTop: 0, viewportHeight: 611, overscan: DEFAULT_OVERSCAN_PX });
  assert.deepEqual({ first: layout.first, last: layout.last }, { first: 0, last: 1 });
  assert.equal(layout.topSpacer, 0);
  assert.equal(layout.bottomSpacer, 0);
});
