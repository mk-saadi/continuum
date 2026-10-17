// Bounded variable-height transcript virtualization (Phase 8).
//
// Phase 2 reveals older history by growing a *logical* suffix window over the
// canonical conversation; every revealed message stayed mounted, so the DOM
// grew with the number of pages the user had visited. This module derives a
// *mounted* sub-range of that logical window from measured row heights plus a
// small overscan region, so the number of mounted rows stays tied to the
// viewport instead of to the length of the conversation.
//
// Everything here is pure: heights in, geometry out. It never touches the
// canonical messages, the logical window, persistence or inference. The
// canonical conversation remains the single source of truth; the height cache
// is only a measurement of already-rendered rows.
//
// Layout model
// ------------
// The transcript is a flex column with `gap: G` between rows. A row's "pitch"
// is `height + G`. Rows are laid out top-to-bottom; the last row has no
// trailing gap. Two spacer elements represent the unmounted portions:
//
//   children = [topSpacer?, ...mounted rows..., bottomSpacer?]
//
// Total height must equal the height the full logical window would have had
// (`content`). Solving that constraint with the flex gap included gives the
// spacer sizes below, which keep the scrollbar, the anchor position and the
// scroll-to-row offsets exact whenever the rows around the viewport have been
// measured.

// Must match the transcript flex column's `gap-7` (1.75rem = 28px). The hook
// reads the live computed `row-gap` at runtime and falls back to this.
export const TRANSCRIPT_GAP_PX = 28;
// Rows above and below the viewport that stay mounted. Roughly one and a half
// transcript viewports of total overscan: enough that ordinary scrolling does
// not out-run the mounted range, small enough that the DOM stays bounded.
export const DEFAULT_OVERSCAN_PX = 480;
// Used for rows that have never been rendered and therefore never measured.
export const DEFAULT_ROW_ESTIMATE_PX = 120;
// Smallest number of measured rows before their median is trusted as the
// estimate for unmeasured rows.
export const MIN_MEASURED_FOR_ESTIMATE = 3;

function toFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Median of the measured heights, used as the estimate for rows that have not
// been rendered yet. A median is robust to a few very tall or very short rows.
export function estimateRowHeight(heights, fallback = DEFAULT_ROW_ESTIMATE_PX) {
	const values = [];
	if (heights && typeof heights.forEach === "function") {
		heights.forEach((value) => {
			const height = toFiniteNumber(value);
			if (height !== null) values.push(height);
		});
	}
	if (values.length < MIN_MEASURED_FOR_ESTIMATE) return fallback;
	values.sort((a, b) => a - b);
	const middle = values.length >> 1;
	return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

// Prefix sums of row pitches: prefix[i] === sum of (size + gap) for rows before
// i, i.e. the top offset of row i. prefix[count] - gap is the full content
// height (the final row contributes no trailing gap).
export function buildPrefix(count, keyAt, heights, estimate, gap) {
	const total = Math.max(0, count | 0);
	const prefix = new Float64Array(total + 1);
	const sizes = new Float64Array(total);
	for (let index = 0; index < total; index += 1) {
		const height = toFiniteNumber(heights?.get?.(keyAt(index)));
		const size = height === null ? estimate : height;
		sizes[index] = size;
		prefix[index + 1] = prefix[index] + size + gap;
	}
	return { prefix, sizes };
}

// First index whose row bottom is below `offset` (upper bound over bottoms).
function firstVisibleIndex(prefix, gap, offset, count) {
	let low = 0;
	let high = count;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (prefix[middle + 1] - gap > offset) high = middle;
		else low = middle + 1;
	}
	return Math.min(low, Math.max(0, count - 1));
}

// Last index whose row top is above `limit` (lower bound over tops minus one).
function lastVisibleIndex(prefix, limit, count) {
	let low = 0;
	let high = count;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (prefix[middle] < limit) low = middle + 1;
		else high = middle;
	}
	return Math.max(0, low - 1);
}

// Given the prefix sums and a scroll position, return the mounted range and the
// spacer heights that make the flex column's total height match the full
// logical content height.
export function computeVirtualLayout({
	prefix,
	count,
	gap = TRANSCRIPT_GAP_PX,
	scrollTop = 0,
	viewportHeight = 0,
	overscan = DEFAULT_OVERSCAN_PX,
}) {
	const total = Math.max(0, count | 0);
	if (total === 0) {
		return { first: 0, last: -1, topSpacer: 0, bottomSpacer: 0, totalHeight: 0, contentHeight: 0 };
	}
	const contentHeight = Math.max(0, prefix[total] - gap);
	const maxScroll = Math.max(0, contentHeight - Math.max(0, viewportHeight));
	const st = Math.min(Math.max(0, scrollTop), maxScroll);
	const top = st - overscan;
	const bottom = st + Math.max(0, viewportHeight) + overscan;

	let first = firstVisibleIndex(prefix, gap, top, total);
	let last = lastVisibleIndex(prefix, bottom, total);
	if (last < first) last = first;
	// A zero-height row at the very edge can push `first` past `last`; keep the
	// range non-empty and, when the viewport is taller than the content, anchor
	// it to the top so nothing is unnecessarily excluded.
	if (first > last) first = last;

	const topSpacer = first > 0 ? Math.max(0, prefix[first] - gap) : 0;
	const bottomSpacer =
		last < total - 1 ? Math.max(0, prefix[total] - prefix[last + 1] - gap) : 0;

	return { first, last, topSpacer, bottomSpacer, totalHeight: contentHeight, contentHeight };
}

// Expand a mounted range so that every pinned index is included, as long as the
// expansion stays within `maxExpansion` extra rows. Pinned rows are the ones
// holding keyboard focus or an open editor: unmounting them would destroy the
// control the user is interacting with. A pin that is too far away is ignored
// (it would defeat the DOM bound); the row simply re-mounts if the user returns.
export function expandRangeForPins(range, pinnedIndices, maxExpansion = 60) {
	if (!range || range.last < range.first || !pinnedIndices || pinnedIndices.length === 0) return range;
	let first = range.first;
	let last = range.last;
	for (const index of pinnedIndices) {
		if (!Number.isInteger(index) || index < 0) continue;
		if (index < first) first = index;
		if (index > last) last = index;
	}
	if (first === range.first && last === range.last) return range;
	if (last - first > range.last - range.first + maxExpansion) return range;
	return { ...range, first, last };
}

// Top offset of a row, for scroll-to-row. Falls back to 0 for out-of-range.
export function offsetOfIndex(prefix, index, count) {
	if (!(index >= 0) || index >= count) return 0;
	return prefix[index];
}
