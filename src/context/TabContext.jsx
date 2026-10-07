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
} from '../lib/tabState.mjs';
import { PERMISSION_MODE_DEFAULTS } from '../lib/permissionModes.mjs';

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
  // Written inside the updater so the value hits disk in the same tick as the
  // mutation, before React re-renders or any awaited IPC can run.
  const stateRef = useRef(state);

  const commit = useCallback(updater => {
    setState(current => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      if (next === current) return current;
      stateRef.current = next;
      try {
        localStorage.setItem(TAB_STORAGE_KEY, serializeTabState(next));
      } catch {
        /* Persistence is best-effort; the app stays usable without it. */
      }
      return next;
    });
  }, []);

  const updateTab = useCallback((id, patch) => commit(current => ({
    ...current,
    tabs: current.tabs.map(tab => tab.id === id ? { ...tab, ...patch } : tab),
  })), [commit]);

  useEffect(() => {
    const bySession = (sessionId, patch) => commit(current => ({ ...current,
      tabs: current.tabs.map(tab => tab.sessionId === sessionId ? { ...tab, ...patch } : tab),
    }));
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
  const activateTab = useCallback(id => commit(current => current.tabs.some(tab => tab.id === id)
    ? { ...current, activeTabId: id } : current), [commit]);
  const moveTab = useCallback((fromIndex, toIndex) =>
    commit(current => moveTabState(current, fromIndex, toIndex)), [commit]);
  // Called once the tab's chat is known to exist in the database, so a restart
  // can tell a real session from a blank tab that was never sent. Matched by
  // session id because callers only ever know their own session — binding a
  // tab id at every call site is how this flag silently stopped persisting.
  const markTabSaved = useCallback(sessionId => commit(current => ({ ...current,
    tabs: current.tabs.map(tab => tab.sessionId === sessionId ? { ...tab, saved: true } : tab),
  })), [commit]);

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
        const groups = await window.memoryPalace?.getAllSessions?.();
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

  // Backstop for writes made outside commit (e.g. React fast-refresh).
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(TAB_STORAGE_KEY, serializeTabState(stateRef.current));
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