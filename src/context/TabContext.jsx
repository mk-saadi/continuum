import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  TAB_STORAGE_KEY,
  closeAllTabsState,
  closeTabState,
  cycleActiveTabState,
  dropOrphanTabs,
  moveTabState,
  parseTabState,
  serializeTabState,
  updateTabState,
  updateTabsBySessionState,
} from '../lib/tabState.mjs';
import { PERMISSION_MODE_DEFAULTS } from '../lib/permissionModes.mjs';
import { fetchSessionGroups } from '../lib/sessionGroups.mjs';

const TabContext = createContext(null);
const newTab = (modelId = '', projectId = null) => ({
  id: `tab_${crypto.randomUUID()}`,
  sessionId: crypto.randomUUID(),
  title: 'New chat',
  modelId,
  projectId,
  permissionMode: projectId
    ? PERMISSION_MODE_DEFAULTS.workspace
    : PERMISSION_MODE_DEFAULTS.casual,
  view: 'chat',
  saved: false,
  status: 'idle',
});
const newDefaultTab = () => newTab(localStorage.getItem('lastSelectedModelPath') || '');
const singleTab = (tab) => ({ tabs: [tab], activeTabId: tab.id });

function readStoredState() {
  let raw = null;
  try {
    raw = localStorage.getItem(TAB_STORAGE_KEY);
  } catch {
    return null; // Storage can be unavailable (disabled, quota, private mode).
  }
  return raw ? parseTabState(raw) : null;
}

export function TabProvider({ children }) {
  // Restore synchronously during the first render so the very first paint
  // already shows the previous session layout — no empty-shell flash.
  const [state, setState] = useState(() => readStoredState() ?? singleTab(newDefaultTab()));
  const hydrated = useRef(false);
  // Latest committed state, kept current for the unload backstop and for the
  // close handlers, which need the live tab list before the next render.
  const stateRef = useRef(state);
  // The last tab-state payload known to be on disk. Seeded with the state we
  // just restored/created so mounting never rewrites unchanged storage, and
  // advanced only after a write actually succeeds (a failed write is retried).
  const persistedRef = useRef(null);
  // The state whose durability `persistedRef` describes. On mount this is the
  // state we just restored, so the first effect pass skips a redundant
  // re-serialization of the value we serialized during initialization.
  const persistedStateRef = useRef(state);
  if (persistedRef.current === null) {
    persistedRef.current = serializeTabState(state);
  }

  // Pure: computes and returns the next state only. Persistence runs in the
  // effect below, so React may safely re-run this updater (StrictMode) and may
  // batch several updates into one commit without duplicating side effects.
  const commit = useCallback(updater => {
    setState(current => (typeof updater === 'function' ? updater(current) : updater));
  }, []);

  const updateTab = useCallback((id, patch) => commit(current => updateTabState(current, id, patch)), [commit]);

  useEffect(() => {
    const bySession = (sessionId, patch) => commit(current => updateTabsBySessionState(current, sessionId, patch));
    const offStatus = window.chatAPI?.onStreamStatus?.(({ sessionId, status }) => bySession(sessionId, { status }));
    const offApproval = window.chatAPI?.onToolApproval?.(({ sessionId, resolved }) =>
      bySession(sessionId, { status: resolved ? 'generating' : 'awaiting_approval' }));
    const offLimit = window.chatAPI?.onToolLimitReached?.(({ sessionId, resolved }) =>
      bySession(sessionId, { status: resolved ? 'generating' : 'awaiting_approval' }));
    const offLoop = window.chatAPI?.onLoopPaused?.(({ sessionId, executionState }) =>
      bySession(sessionId, { status: executionState === 'paused_turn_limit' ? 'awaiting_approval' : 'generating' }));
    return () => { offStatus?.(); offApproval?.(); offLimit?.(); offLoop?.(); };
  }, [commit]);
  const openTab = useCallback((modelId = '', projectId = null) => {
    const tab = newTab(modelId, projectId);
    commit(current => ({ tabs: [...current.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  }, [commit]);
  const closeTab = useCallback(id => {
    const sessionId = stateRef.current.tabs.find(tab => tab.id === id)?.sessionId;
    if (sessionId) void window.chatAPI?.cancelSession?.(sessionId)?.catch(console.error);
    // commit() overwrites the key with the shortened array, so the closed
    // tab's data is purged immediately rather than lingering.
    commit(current => closeTabState(current, id, newDefaultTab));
  }, [commit]);
  const closeAllTabs = useCallback(() => {
    for (const tab of stateRef.current.tabs) void window.chatAPI?.cancelSession?.(tab.sessionId)?.catch(console.error);
    commit(closeAllTabsState(newDefaultTab));
  }, [commit]);
  const cycleTab = useCallback(direction => commit(current => cycleActiveTabState(current, direction)), [commit]);
  // Re-selecting the already-active tab is a no-op: returning the same state
  // avoids re-rendering every subscriber and rewriting disk for nothing.
  const activateTab = useCallback(id => commit(current =>
    current.activeTabId === id || !current.tabs.some(tab => tab.id === id)
      ? current
      : { ...current, activeTabId: id }), [commit]);
  const moveTab = useCallback((fromIndex, toIndex) =>
    commit(current => moveTabState(current, fromIndex, toIndex)), [commit]);
  // Called once the tab's chat is known to exist in the database, so a restart
  // can tell a real session from a blank tab that was never sent. Matched by
  // session id because callers only ever know their own session — binding a
  // tab id at every call site is how this flag silently stopped persisting.
  const markTabSaved = useCallback(sessionId =>
    commit(current => updateTabsBySessionState(current, sessionId, { saved: true })), [commit]);

  // Persist exactly one write per committed change, and only when the durable
  // representation actually changed. Moving the write out of the updater keeps
  // the updater pure; the dedupe means a `status`-only update (streaming,
  // approval routing) serializes identically and is skipped rather than
  // rewriting the whole tab list. Coalescing falls out of React batching:
  // several mutations in one tick commit once and persist once, the latest.
  useEffect(() => {
    stateRef.current = state;
    // Mount adopts the state serialized during initialization; every later
    // change is serialized once to compare against what is already on disk.
    if (state === persistedStateRef.current) return;
    persistedStateRef.current = state;
    const serialized = serializeTabState(state);
    if (serialized === persistedRef.current) return;
    try {
      localStorage.setItem(TAB_STORAGE_KEY, serialized);
      persistedRef.current = serialized;
    } catch {
      /* Persistence is best-effort; a failed write is retried on the next change. */
    }
  }, [state]);

  // Validate restored tabs against the database, then drop the orphaned ones.
  // Runs after first paint so a chat sidebar render never waits on this.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    let active = true;
    (async () => {
      const parsed = readStoredState();
      if (!parsed) return;
      let live = null;
      try {
        // Shares the in-flight listing with mounting panes (dedup only; errors
        // still fall through to keeping tabs).
        const groups = await fetchSessionGroups(window.memoryPalace);
        live = new Set(groups?.flatMap(group => group.sessions ?? []).map(session => session.id));
      } catch {
        return; // Unknown: keep tabs rather than discard the user's workspace.
      }
      if (!active || !live) return;
      commit(current => dropOrphanTabs(
        { tabs: current.tabs, activeTabId: current.activeTabId },
        sessionId => live.has(sessionId),
      ) ?? singleTab(newDefaultTab()));
    })();
    return () => { active = false; };
  }, [commit]);

  useEffect(() => window.memoryPalace?.onSessionDeleted?.(({ sessionId }) => {
    commit(current => {
      const tab = current.tabs.find(item => item.sessionId === sessionId);
      return tab ? closeTabState(current, tab.id, newDefaultTab) : current;
    });
  }), [commit]);

  // Best-effort flush when the window is going away. The persistence effect
  // above already writes on every committed change, so this only matters if
  // the effect has not flushed yet; it writes the same deduped payload and
  // never resurrects a state older than the last successful write.
  useEffect(() => {
    const flush = () => {
      const serialized = serializeTabState(stateRef.current);
      if (serialized === persistedRef.current) return;
      try {
        localStorage.setItem(TAB_STORAGE_KEY, serialized);
        persistedRef.current = serialized;
      } catch { /* Best effort. */ }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  const value = useMemo(() => ({ ...state, activeTab: state.tabs.find(tab => tab.id === state.activeTabId),
    updateTab, openTab, closeTab, closeAllTabs, cycleTab, activateTab, moveTab, markTabSaved }),
    [state, updateTab, openTab, closeTab, closeAllTabs, cycleTab, activateTab, moveTab, markTabSaved]);
  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}

export function useTabs() {
  const value = useContext(TabContext);
  if (!value) throw new Error('TabProvider is required.');
  return value;
}