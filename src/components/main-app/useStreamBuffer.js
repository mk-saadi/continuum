import { useEffect, useRef } from 'react';

// IPC callbacks only append to this ref. Only the subscribed live text node
// updates on a frame; the parent chat tree does not render for each flush.
export function useStreamBuffer() {
  const store = useRef(null);
  if (store.current === null) {
    const state = { chunks: [], text: '', timer: null, listeners: new Set(), onFlush: null };
    const flush = () => {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      if (state.chunks.length) {
        state.text += state.chunks.join('');
        state.chunks.length = 0;
        for (const listener of state.listeners) listener();
        state.onFlush?.(state.text);
      }
      return state.text;
    };
    store.current = {
      start(onFlush) {
        flush();
        state.text = '';
        state.onFlush = onFlush;
        for (const listener of state.listeners) listener();
      },
      push(chunk) {
        if (!chunk) return;
        state.chunks.push(chunk);
        if (state.timer === null) state.timer = setTimeout(flush, 32);
      },
      flush,
      subscribe(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      getSnapshot() { return state.text; },
      dispose() {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.chunks.length = 0;
        state.listeners.clear();
        state.onFlush = null;
      },
    };
  }
  useEffect(() => () => store.current?.dispose(), []);
  return store.current;
}
