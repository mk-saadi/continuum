import { useCallback, useState, useSyncExternalStore } from "react";
import { readRowUiState, subscribeRowUiState, writeRowUiState } from "../lib/rowUiState.mjs";

// Persistent, identity-keyed primitive row state. `key` must be stable across
// mount/unmount cycles (message id + block type + index). A null key degrades
// to ordinary component-local state, for records that have no stable identity.
export function useRowUiState(key, fallback) {
	const [localValue, setLocalValue] = useState(fallback);
	const subscribe = useCallback(
		(notify) => (key ? subscribeRowUiState(key, notify) : () => {}),
		[key],
	);
	const getSnapshot = useCallback(
		() => (key ? readRowUiState(key, fallback) : localValue),
		[key, fallback, localValue],
	);
	const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const setValue = useCallback(
		(next) => {
			if (!key) {
				setLocalValue((previous) => (typeof next === "function" ? next(previous) : next));
				return;
			}
			const resolved = typeof next === "function" ? next(readRowUiState(key, fallback)) : next;
			writeRowUiState(key, resolved);
		},
		[key, fallback],
	);
	return [value, setValue];
}
