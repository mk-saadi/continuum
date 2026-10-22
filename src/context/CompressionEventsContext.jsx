import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

// Every mounted tab pane owns a `useMemoryPalace` instance and a
// ChatInterface, and the Context panel adds one more. Subscribing to the
// `session:compression-complete` IPC channel from each of them put one
// ipcRenderer listener per tab on the same channel, which trips Node's
// default 10-listener warning once enough tabs are open and delivers every
// event to every tab just to have N-1 of them discard it on a sessionId check.
//
// This provider subscribes to the channel exactly once and fans the payload
// out to per-session listeners. Components register through
// `useCompressionEvents(sessionId, handler)`.

const CompressionEventsContext = createContext(null);

export function CompressionEventsProvider({ api, children }) {
	// sessionId -> Set<listener>. A Map keeps ids from colliding with the set's
	// own prototype keys and lets empty sets be dropped as tabs close.
	const listeners = useRef(new Map());

	useEffect(() => {
		const source = api ?? (typeof window === "undefined" ? null : window.memoryPalace);
		const register = source?.onCompressionComplete;
		if (typeof register !== "function") return undefined;
		const unsubscribe = register((result) => {
			const sessionId = result?.sessionId;
			if (!sessionId) return;
			const set = listeners.current.get(sessionId);
			if (!set) return;
			// Copy before iterating: a handler may unsubscribe itself or a
			// sibling while we are dispatching.
			for (const listener of Array.from(set)) {
				try {
					listener(result);
				} catch (error) {
					// One broken subscriber must not starve the others.
					console.error("compression listener failed", error);
				}
			}
		});
		return typeof unsubscribe === "function" ? unsubscribe : undefined;
	}, [api]);

	const subscribe = useCallback((sessionId, listener) => {
		if (!sessionId || typeof listener !== "function") return () => {};
		const map = listeners.current;
		let set = map.get(sessionId);
		if (!set) {
			set = new Set();
			map.set(sessionId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0 && map.get(sessionId) === set) map.delete(sessionId);
		};
	}, []);

	const value = useMemo(() => subscribe, [subscribe]);
	return <CompressionEventsContext.Provider value={value}>{children}</CompressionEventsContext.Provider>;
}

export function useCompressionEvents(sessionId, handler) {
	const subscribe = useContext(CompressionEventsContext);
	// Handlers close over frequently-changing props (refresh callbacks,
	// messages, toasts). Keep the latest one in a ref so a new closure never
	// forces a resubscribe; the subscription only changes with the session.
	const handlerRef = useRef(handler);
	useEffect(() => {
		handlerRef.current = handler;
	});

	useEffect(() => {
		if (!sessionId) return undefined;
		const listener = (result) => {
			if (!result || result.sessionId !== sessionId) return;
			handlerRef.current?.(result);
		};
		if (subscribe) return subscribe(sessionId, listener);
		// Standalone mount (fixtures, Storybook-style rendering, or a test that
		// renders one component without the app providers): fall back to a
		// direct subscription rather than going silently deaf.
		const unsubscribe = window.memoryPalace?.onCompressionComplete?.(listener);
		return typeof unsubscribe === "function" ? unsubscribe : undefined;
	}, [subscribe, sessionId]);
}
