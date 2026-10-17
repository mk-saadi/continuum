import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	DEFAULT_OVERSCAN_PX,
	TRANSCRIPT_GAP_PX,
	buildPrefix,
	computeVirtualLayout,
	estimateRowHeight,
	expandRangeForPins,
} from "../../lib/transcriptVirtual.mjs";

// Phase 8: bound the mounted transcript rows to the viewport plus overscan.
//
// The logical window (`messages`) is still produced by useTranscriptWindow and
// still grows by older pages; this hook only decides which slice of it is
// mounted. Heights are keyed by stable message identity and cached for the
// lifetime of the conversation (bounded by MAX_CACHED_MEASUREMENTS), so a row
// that scrolls out and back keeps its measured size instead of re-measuring to
// a guess.
//
// Three things keep the scroll position exact:
//   1. `beginHold()` before a deliberate geometry change (older page prepended)
//      captures the top visible row and restores its content offset from prefix
//      sums, so prepended rows never shift the reader.
//   2. A scroll-driven range change measures the rows that just mounted and
//      compensates for the difference between their estimate and their real
//      height, so content under the viewport never shifts.
//   3. Continuous height changes (streaming, images, a resized transcript) are
//      left to the browser's native scroll anchoring, which keeps the anchor row
//      stable before paint; this hook only records the new heights.

const MESSAGE_ID_ATTR = "data-message-id";
const HEIGHT_EPSILON = 0.5;
// Ceiling on retained per-row measurements. Comfortably above any realistic
// revealed window while still bounding long sessions.
const MAX_CACHED_MEASUREMENTS = 1500;
// Maximum extra rows a focus/edit pin may keep mounted beyond the virtual
// range. A pin further away is ignored rather than exploding the DOM bound.
const MAX_PIN_EXPANSION = 60;

// Top visible mounted row (by stable id) plus its content-space top offset and
// the container's scroll metrics. Recording the content-space offset (rather
// than only the viewport offset) lets the row be restored from prefix sums even
// after a prepend moves it to a new window index. The container's top padding is
// subtracted so the offset lives in the same coordinate space as the prefix
// sums (which start at 0 for the first logical row, with no padding).
function captureAnchor(node) {
	if (!node) return null;
	const containerTop = node.getBoundingClientRect().top;
	const paddingTop = parseFloat(getComputedStyle(node).paddingTop) || 0;
	for (const element of node.querySelectorAll(`[${MESSAGE_ID_ATTR}]`)) {
		const rect = element.getBoundingClientRect();
		if (rect.bottom > containerTop) {
			return {
				id: element.getAttribute(MESSAGE_ID_ATTR),
				contentTop: node.scrollTop + (rect.top - containerTop) - paddingTop,
				scrollTop: node.scrollTop,
				scrollHeight: node.scrollHeight,
			};
		}
	}
	return {
		id: null,
		contentTop: node.scrollTop,
		scrollTop: node.scrollTop,
		scrollHeight: node.scrollHeight,
	};
}

// Keep the anchored message at the same visual position. The row's new
// content-space offset is read from the (possibly grown) prefix sums, so the
// correction is exact even when the anchor moved to a new window index after
// older messages were prepended, and it needs no mounted DOM. It falls back to
// the scroll-height difference only when the anchor row left the window.
function restoreAnchor(node, anchor, keys, prefix) {
	if (!node || !anchor) return;
	if (anchor.id != null) {
		const index = keys.indexOf(String(anchor.id));
		if (index !== -1) {
			node.scrollTop += prefix[index] - anchor.contentTop;
			return;
		}
	}
	node.scrollTop += node.scrollHeight - anchor.scrollHeight;
}

export function useTranscriptVirtual({
	messages,
	sessionId,
	scrollRef,
	pinnedIds = null,
	overscanPx = DEFAULT_OVERSCAN_PX,
}) {
	const list = useMemo(() => (Array.isArray(messages) ? messages : []), [messages]);
	// Stable identity per row. Production messages always carry `msg.id`; the
	// positional fallback only applies to transient records without one.
	const keys = useMemo(
		() =>
			list.map((message, index) =>
				message && message.id != null
					? String(message.id)
					: `__vt_${message?.role ?? "m"}_${index}`,
			),
		[list],
	);

	const heightsRef = useRef(new Map());
	const observedRef = useRef(new Map());
	const elementKeyRef = useRef(new WeakMap());
	const refCallbacksRef = useRef(new Map());
	const roRef = useRef(null);
	const prefixRef = useRef({ prefix: new Float64Array(1), sizes: new Float64Array(0) });
	const layoutRef = useRef(null);
	const viewportRef = useRef({ height: 0, width: 0 });
	const gapRef = useRef(TRANSCRIPT_GAP_PX);
	const overscanRef = useRef(overscanPx);
	const keysRef = useRef(keys);
	const handleEntriesRef = useRef(() => {});
	const prevGeometryRef = useRef(null);
	const holdAnchorRef = useRef(null);
	const skipCompensationRef = useRef(false);

	const [heightsVersion, setHeightsVersion] = useState(0);
	const [scrollTopState, setScrollTopState] = useState(null);
	const [viewport, setViewport] = useState({ height: 0, width: 0 });
	const [gap, setGap] = useState(TRANSCRIPT_GAP_PX);

	keysRef.current = keys;
	overscanRef.current = overscanPx;
	viewportRef.current = viewport;

	const trimCache = useCallback(() => {
		const cache = heightsRef.current;
		while (cache.size > MAX_CACHED_MEASUREMENTS) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}, []);

	// --- measurement cache ---------------------------------------------------
	const recordHeight = useCallback(
		(key, height) => {
			const rounded = Math.round(height);
			if (!Number.isFinite(rounded)) return false;
			const cache = heightsRef.current;
			const previous = cache.get(key);
			if (previous != null && Math.abs(previous - rounded) <= HEIGHT_EPSILON) return false;
			cache.set(key, rounded);
			trimCache();
			return true;
		},
		[trimCache],
	);

	// Continuous height changes (streaming text, images, a resized transcript
	// after a sidebar toggle) are handled by the browser's native scroll
	// anchoring: the anchor row stays put because it is a real DOM node, and the
	// compensating adjustment happens before paint. This handler only records the
	// new heights so spacer geometry stays accurate; the sparse, deliberate jumps
	// this hook owns itself (prepend, scroll-to-row) are corrected explicitly.
	handleEntriesRef.current = (entries) => {
		let changed = false;
		for (const entry of entries) {
			const key = elementKeyRef.current.get(entry.target);
			if (key == null) continue;
			const box = entry.borderBoxSize && entry.borderBoxSize[0];
			const height = box ? box.blockSize : entry.contentRect.height;
			const rounded = Math.round(height);
			if (!Number.isFinite(rounded)) continue;
			const previous = heightsRef.current.get(key);
			if (previous != null && Math.abs(previous - rounded) <= HEIGHT_EPSILON) continue;
			if (recordHeight(key, rounded)) changed = true;
		}
		if (changed) setHeightsVersion((version) => version + 1);
	};

	// Stable per-key ref callback: mounting a row registers it with the shared
	// ResizeObserver, unmounting unregisters it.
	const getMeasureRef = useCallback((key) => {
		let callback = refCallbacksRef.current.get(key);
		if (!callback) {
			callback = (element) => {
				const ro = roRef.current;
				const previous = observedRef.current.get(key);
				if (previous && previous !== element && ro) {
					ro.unobserve(previous);
					observedRef.current.delete(key);
				}
				if (element) {
					elementKeyRef.current.set(element, key);
					observedRef.current.set(key, element);
					ro?.observe(element);
				} else {
					observedRef.current.delete(key);
				}
			};
			refCallbacksRef.current.set(key, callback);
		}
		return callback;
	}, []);

	useLayoutEffect(() => {
		const ro = new ResizeObserver((entries) => handleEntriesRef.current(entries));
		roRef.current = ro;
		for (const element of observedRef.current.values()) ro.observe(element);
		return () => {
			ro.disconnect();
			roRef.current = null;
			observedRef.current.clear();
			elementKeyRef.current = new WeakMap();
			refCallbacksRef.current.clear();
		};
	}, []);

	// --- geometry ------------------------------------------------------------
	const estimate = useMemo(() => {
		// Recomputed when measurements change; cheap for the bounded window.
		return estimateRowHeight(heightsRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [heightsVersion]);

	const keyAt = useCallback((index) => keys[index], [keys]);

	const prefixData = useMemo(
		() => buildPrefix(keys.length, keyAt, heightsRef.current, estimate, gap),
		[keyAt, keys.length, heightsVersion, estimate, gap],
	);
	prefixRef.current = prefixData;
	gapRef.current = gap;

	const layout = useMemo(
		() =>
			computeVirtualLayout({
				prefix: prefixData.prefix,
				count: keys.length,
				gap,
				scrollTop: scrollTopState === null ? Infinity : scrollTopState,
				viewportHeight: viewport.height,
				overscan: overscanPx,
			}),
		[prefixData, keys.length, gap, scrollTopState, viewport.height, overscanPx],
	);
	layoutRef.current = layout;

	const pinnedIndices = useMemo(() => {
		if (!pinnedIds || pinnedIds.size === 0) return null;
		const found = [];
		for (let index = 0; index < keys.length; index += 1) {
			if (pinnedIds.has(keys[index])) found.push(index);
		}
		return found.length ? found : null;
	}, [pinnedIds, keys]);

	const range = useMemo(
		() => expandRangeForPins(layout, pinnedIndices, MAX_PIN_EXPANSION),
		[layout, pinnedIndices],
	);

	// Unobserve rows that left the mounted range so the observer and the ref
	// callback cache never retain detached elements.
	useLayoutEffect(() => {
		const ro = roRef.current;
		if (!ro) return;
		const active = new Set();
		for (let index = range.first; index <= range.last; index += 1) active.add(keys[index]);
		for (const [key, element] of observedRef.current) {
			if (!active.has(key)) {
				ro.unobserve(element);
				observedRef.current.delete(key);
				refCallbacksRef.current.delete(key);
			}
		}
	});

	// --- scroll --------------------------------------------------------------
	const onScroll = useCallback((node) => {
		if (!node) return;
		const scrollTop = node.scrollTop;
		const { prefix } = prefixRef.current;
		const count = keysRef.current.length;
		const prospective = computeVirtualLayout({
			prefix,
			count,
			gap: gapRef.current,
			scrollTop,
			viewportHeight: viewportRef.current.height,
			overscan: overscanRef.current,
		});
		const current = layoutRef.current;
		if (!current || prospective.first !== current.first || prospective.last !== current.last) {
			setScrollTopState(scrollTop);
		}
	}, []);

	// Capture the top visible row before a deliberate geometry change (older
	// page prepended) so it can be restored in the same frame.
	const beginHold = useCallback(() => {
		const node = scrollRef.current;
		if (node) holdAnchorRef.current = captureAnchor(node);
	}, [scrollRef]);

	// Measure mounted rows and keep the visible content fixed across a
	// scroll-driven range change. Runs after every commit.
	useLayoutEffect(() => {
		const node = scrollRef.current;
		const previous = prevGeometryRef.current;
		const current = range;
		const sameWindow = previous && previous.count === keys.length && previous.firstKey === keys[0];

		if (node && previous && sameWindow && !skipCompensationRef.current) {
			if (current.first < previous.first || current.last > previous.last) {
				// Rows that just mounted substitute their real height for the
				// estimate used while they were unmounted. Any such row that sits
				// entirely above the viewport pushes everything below it, so shift
				// the scroll position by the height it gained or lost. Rows at or
				// below the viewport need no shift.
				const containerTop = node.getBoundingClientRect().top;
				let compensation = 0;
				let measured = false;
				for (let index = current.first; index <= current.last; index += 1) {
					if (index >= previous.first && index <= previous.last) continue;
					const element = observedRef.current.get(keys[index]);
					if (!element) continue;
					const rect = element.getBoundingClientRect();
					const real = Math.round(rect.height);
					if (!Number.isFinite(real)) continue;
					const estimated =
						index < previous.sizes.length ? previous.sizes[index] : previous.estimate;
					if (rect.bottom - containerTop <= 0.5) compensation += real - estimated;
					if (recordHeight(keys[index], real)) measured = true;
				}
				if (compensation !== 0) node.scrollTop += compensation;
				if (measured) setHeightsVersion((version) => version + 1);
			}
		}

		if (node && holdAnchorRef.current) {
			const anchor = holdAnchorRef.current;
			holdAnchorRef.current = null;
			restoreAnchor(node, anchor, keys, prefixData.prefix);
			// Re-derive the mounted range from the corrected scroll position so
			// the anchor row stays mounted in the same commit, without a frame
			// where the wrong slice is painted.
			if (scrollTopState !== node.scrollTop) setScrollTopState(node.scrollTop);
		}
		holdAnchorRef.current = null;
		skipCompensationRef.current = false;

		prevGeometryRef.current = {
			first: current.first,
			last: current.last,
			count: keys.length,
			firstKey: keys[0],
			sizes: prefixData.sizes,
			estimate,
		};
	});

	// --- viewport + gap ------------------------------------------------------
	useLayoutEffect(() => {
		const node = scrollRef.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const measure = () => {
			const height = node.clientHeight;
			const width = node.clientWidth;
			setViewport((current) =>
				Math.abs(current.height - height) < 1 && Math.abs(current.width - width) < 1
					? current
					: { height, width },
			);
			const wrapper = node.querySelector("[data-transcript-list]");
			const computed = parseFloat(getComputedStyle(wrapper ?? node).rowGap);
			if (Number.isFinite(computed) && Math.abs(computed - gapRef.current) > 0.01) setGap(computed);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [scrollRef]);

	// --- imperative navigation ----------------------------------------------
	const scrollToKey = useCallback(
		(messageId, { align = "start" } = {}) => {
			const node = scrollRef.current;
			if (!node || messageId == null) return false;
			const key = String(messageId);
			const index = keysRef.current.indexOf(key);
			if (index === -1) return false;
			const { prefix } = prefixRef.current;
			const top = prefix[index];
			const viewportHeight = viewportRef.current.height;
			const offset =
				align === "center"
					? Math.max(0, top - Math.max(0, viewportHeight - estimateRowHeight(heightsRef.current)) / 2)
					: top;
			skipCompensationRef.current = true;
			node.scrollTop = offset;
			setScrollTopState(offset);
			return true;
		},
		[scrollRef],
	);

	const resetToStart = useCallback(() => {
		const node = scrollRef.current;
		skipCompensationRef.current = true;
		if (node) node.scrollTop = 0;
		setScrollTopState(0);
	}, [scrollRef]);

	const resetToEnd = useCallback(() => {
		skipCompensationRef.current = true;
		setScrollTopState(null);
	}, []);

	// A new conversation must never reuse the previous one's measurements.
	useEffect(() => {
		heightsRef.current = new Map();
		prevGeometryRef.current = null;
		holdAnchorRef.current = null;
		setScrollTopState(null);
		setHeightsVersion((version) => version + 1);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionId]);

	const mountedMessages = useMemo(
		() => list.slice(range.first, range.last + 1),
		[list, range.first, range.last],
	);

	return {
		first: range.first,
		last: range.last,
		mountedCount: range.last >= range.first ? range.last - range.first + 1 : 0,
		topSpacer: layout.topSpacer,
		bottomSpacer: layout.bottomSpacer,
		totalHeight: layout.totalHeight,
		mountedMessages,
		heightsVersion,
		onScroll,
		beginHold,
		getMeasureRef,
		scrollToKey,
		resetToStart,
		resetToEnd,
	};
}
