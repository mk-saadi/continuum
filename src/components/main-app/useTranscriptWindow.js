import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	INITIAL_VISIBLE_MESSAGES,
	OLDER_MESSAGES_PAGE_SIZE,
	SEARCH_CONTEXT_MESSAGES,
	countConversationMessages,
	hasConversationInRange,
	indexOfMessage,
	selectTranscriptWindow,
	selectTranscriptWindowAround,
} from "../../lib/transcriptWindow.mjs";

// How close (px) to an edge of the transcript the user must scroll before the
// next page is revealed (upward for older history, downward when a search
// target sits above the newest messages).
export const OLDER_SCROLL_THRESHOLD_PX = 120;

const MESSAGE_ID_ATTR = "data-message-id";

// Locate the message currently sitting at the top edge of the viewport so its
// on-screen position can be restored after older messages are prepended above
// it. Anchoring to a stable message id (rather than an array index) survives
// React keying across every insert/delete/replace of the canonical history.
function captureAnchor(node) {
	const containerTop = node.getBoundingClientRect().top;
	const elements = node.querySelectorAll(`[${MESSAGE_ID_ATTR}]`);
	for (const element of elements) {
		const rect = element.getBoundingClientRect();
		if (rect.bottom > containerTop) {
			return {
				id: element.getAttribute(MESSAGE_ID_ATTR),
				top: rect.top,
				scrollTop: node.scrollTop,
				scrollHeight: node.scrollHeight,
			};
		}
	}
	return {
		id: null,
		top: 0,
		scrollTop: node.scrollTop,
		scrollHeight: node.scrollHeight,
	};
}

// Keep the anchored message at the same visual position. Falls back to the
// scroll-height difference if the anchor element is gone (for example the
// canonical history changed in the same commit).
function restoreAnchor(node, anchor) {
	if (anchor.id != null) {
		const selector = `[${MESSAGE_ID_ATTR}="${CSS.escape(anchor.id)}"]`;
		const element = node.querySelector(selector);
		if (element) {
			node.scrollTop += element.getBoundingClientRect().top - anchor.top;
			return;
		}
	}
	node.scrollTop += node.scrollHeight - anchor.scrollHeight;
}

// The newest-messages window used at startup and while following the latest
// reply. `start`/`end` are only meaningful in target mode.
function suffixState(sessionId) {
	return {
		sessionId,
		mode: "suffix",
		count: INITIAL_VISIBLE_MESSAGES,
		targetId: null,
		start: null,
		end: null,
	};
}

// A session change resets to the initial suffix window synchronously: a target
// or expanded count from another conversation must never leak in.
function resolveState(state, sessionId) {
	if (state && state.sessionId === sessionId) return state;
	return suffixState(sessionId);
}

// Derives the transcript window from the canonical message collection and
// reveals/extends it on demand. The canonical array is only read, never sliced
// in place or stored as a replacement. Normal operation is a suffix window over
// the newest messages; search navigation can transiently move a bounded window
// to an older region without ever mounting the intervening history.
export function useTranscriptWindow({ messages, sessionId, scrollRef, anchoring = true }) {
	const [windowState, setWindowState] = useState(() => suffixState(sessionId));
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
	// Phase 8: when the transcript is virtualized, the mounted-row hook owns
	// scroll anchoring (it can correct using prefix sums even for rows that are
	// not currently mounted). Disabling this hook's DOM anchoring avoids applying
	// the same correction twice.
	const anchoringRef = useRef(anchoring);
	anchoringRef.current = anchoring;

	const matchesSession = windowState && windowState.sessionId === sessionId;
	const mode = matchesSession ? windowState.mode : "suffix";
	const count = matchesSession ? windowState.count : INITIAL_VISIBLE_MESSAGES;
	const rangeStart = matchesSession ? windowState.start : null;
	const rangeEnd = matchesSession ? windowState.end : null;
	const targetId = matchesSession ? windowState.targetId : null;

	const selection = useMemo(() => {
		const list = Array.isArray(messages) ? messages : [];
		if (mode === "target") {
			if (rangeStart == null || rangeEnd == null)
				return selectTranscriptWindowAround(list, targetId, SEARCH_CONTEXT_MESSAGES);
			const start = Math.min(Math.max(0, rangeStart), list.length);
			const end = Math.min(Math.max(rangeEnd, start), list.length);
			return {
				start,
				end,
				messages: list.slice(start, end),
				hasOlder: hasConversationInRange(list, 0, start),
				hasNewer: hasConversationInRange(list, end, list.length),
				targetIndex: indexOfMessage(list, targetId),
				found: indexOfMessage(list, targetId) !== -1,
			};
		}
		const window = selectTranscriptWindow(list, count);
		return { ...window, end: list.length, hasNewer: false, targetIndex: -1, found: true };
	}, [messages, mode, count, rangeStart, rangeEnd, targetId]);

	// Refs keep the latest values reachable from stable callbacks (the scroll
	// handler) without re-binding listeners or re-creating the observers.
	const hasOlderRef = useRef(selection.hasOlder);
	hasOlderRef.current = selection.hasOlder;
	const hasNewerRef = useRef(selection.hasNewer);
	hasNewerRef.current = selection.hasNewer;
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const expandingRef = useRef(false);
	const anchorRef = useRef(null);

	const loadOlder = useCallback(() => {
		const node = scrollRef.current;
		if (expandingRef.current || !hasOlderRef.current || !node) return false;
		// Capture the viewport anchor *before* the window grows, and mark the
		// expansion in flight so duplicate scroll/observer callbacks in the same
		// frame cannot insert a second page.
		expandingRef.current = true;
		if (anchoringRef.current) anchorRef.current = captureAnchor(node);
		setWindowState((current) => {
			const state = resolveState(current, sessionIdRef.current);
			if (state.mode === "target") {
				const start = Math.max(0, (state.start ?? 0) - OLDER_MESSAGES_PAGE_SIZE);
				return start === state.start ? state : { ...state, start };
			}
			return { ...state, count: state.count + OLDER_MESSAGES_PAGE_SIZE };
		});
		return true;
	}, [scrollRef]);

	// Reveal newer messages below a search-navigation window. Appending at the
	// bottom needs no anchor: the added rows land below the viewport. When the
	// window reaches the newest message it hands back to the suffix window so
	// streaming output and auto-follow resume normally.
	const loadNewer = useCallback(() => {
		if (!hasNewerRef.current) return false;
		setWindowState((current) => {
			const state = resolveState(current, sessionIdRef.current);
			if (state.mode !== "target") return state;
			const list = messagesRef.current;
			const total = Array.isArray(list) ? list.length : 0;
			const end = Math.min(total, (state.end ?? total) + OLDER_MESSAGES_PAGE_SIZE);
			if (end >= total) {
				const eligible = countConversationMessages(list, state.start ?? 0, total);
				return {
					sessionId: sessionIdRef.current,
					mode: "suffix",
					count: Math.max(INITIAL_VISIBLE_MESSAGES, eligible),
					targetId: null,
					start: null,
					end: null,
				};
			}
			return end === state.end ? state : { ...state, end };
		});
		return true;
	}, []);

	// Move a bounded window around a specific message. Used by search
	// navigation so an old hit is shown with local context instead of mounting
	// every message between it and the newest reply.
	const showTarget = useCallback((messageId) => {
		const list = messagesRef.current;
		const index = indexOfMessage(Array.isArray(list) ? list : [], messageId);
		if (index === -1) return false;
		const start = Math.max(0, index - SEARCH_CONTEXT_MESSAGES);
		const end = Math.min(list.length, index + SEARCH_CONTEXT_MESSAGES + 1);
		anchorRef.current = null;
		expandingRef.current = false;
		setWindowState((current) => {
			const state = resolveState(current, sessionIdRef.current);
			if (
				state.mode === "target" &&
				state.targetId === messageId &&
				state.start === start &&
				state.end === end
			)
				return state;
			return {
				sessionId: sessionIdRef.current,
				mode: "target",
				count: state.count,
				targetId: messageId,
				start,
				end,
			};
		});
		return true;
	}, []);

	// Return to the newest messages from a search-navigation window.
	const followLatest = useCallback(() => {
		anchorRef.current = null;
		expandingRef.current = false;
		setWindowState(suffixState(sessionIdRef.current));
	}, []);

	const containsMessage = useCallback((messageId) => {
		if (messageId == null) return false;
		const list = selectionRef.current?.messages ?? [];
		for (const message of list) {
			if (message && message.id === messageId) return true;
		}
		return false;
	}, []);

	// Runs after the (synchronous) DOM update but before paint, so a restored
	// scroll position is never visible as a jump. The `expandingRef` guard is
	// always released when the window changes, whether or not this hook is the
	// one anchoring the scroll position.
	useLayoutEffect(() => {
		const node = scrollRef.current;
		const anchor = anchorRef.current;
		anchorRef.current = null;
		expandingRef.current = false;
		if (!anchoringRef.current || !anchor || !node) return;
		restoreAnchor(node, anchor);
	}, [selection.messages, scrollRef]);

	return {
		visibleMessages: selection.messages,
		hasOlder: selection.hasOlder,
		hasNewer: selection.hasNewer,
		mode,
		visibleCount: mode === "target" ? selection.messages.length : count,
		loadOlder,
		loadNewer,
		showTarget,
		followLatest,
		containsMessage,
	};
}
