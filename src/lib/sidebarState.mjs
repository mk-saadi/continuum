// Each conversation has its own snapshot and subscribers, including when its
// pane stays mounted in the background.
export function createSidebarStore(storage) {
  const entries = new Map();
  return {
    forSession(sessionId) {
      if (entries.has(sessionId)) return entries.get(sessionId);
      const key = `continuum_sidebars:${sessionId}`;
      let initial;
      try { initial = JSON.parse(storage?.getItem(key) || 'null'); } catch { /* Best effort. */ }
      let state = { left: initial?.left === true, right: initial?.right === true };
      const listeners = new Set();
      const entry = {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        setOpen(side, value) {
          const open = typeof value === 'function' ? value(state[side]) : value;
          if (state[side] === open) return;
          state = { ...state, [side]: open };
          try { storage?.setItem(key, JSON.stringify(state)); } catch { /* Best effort. */ }
          listeners.forEach(listener => listener());
        },
      };
      entries.set(sessionId, entry);
      return entry;
    },
  };
}
