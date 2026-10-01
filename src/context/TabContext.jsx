import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const TabContext = createContext(null);
const newTab = (modelId = '', projectId = null) => ({
  id: `tab_${crypto.randomUUID()}`,
  sessionId: crypto.randomUUID(),
  title: 'New chat',
  modelId,
  projectId,
  permissionMode: projectId ? 'workspace_write' : 'ask_approval',
  status: 'idle',
});

export function TabProvider({ children }) {
  const [state, setState] = useState(() => {
    const tab = newTab(localStorage.getItem('lastSelectedModelPath') || '');
    return { tabs: [tab], activeTabId: tab.id };
  });
  const updateTab = useCallback((id, patch) => setState(current => ({
    ...current,
    tabs: current.tabs.map(tab => tab.id === id ? { ...tab, ...patch } : tab),
  })), []);
  useEffect(() => {
    const bySession = (sessionId, patch) => setState(current => ({ ...current,
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
  }, []);
  const openTab = useCallback((modelId = '', projectId = null) => {
    const tab = newTab(modelId, projectId);
    setState(current => ({ tabs: [...current.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  }, []);
  const closeTab = useCallback(id => {
    const sessionId = state.tabs.find(tab => tab.id === id)?.sessionId;
    if (sessionId) void window.chatAPI?.cancelSession?.(sessionId).catch(console.error);
    setState(current => {
    const index = current.tabs.findIndex(tab => tab.id === id);
    if (index < 0) return current;
    const tabs = current.tabs.filter(tab => tab.id !== id);
    if (!tabs.length) tabs.push(newTab(current.tabs[index].modelId));
    const activeTabId = current.activeTabId === id
      ? tabs[Math.min(index, tabs.length - 1)].id : current.activeTabId;
    return { tabs, activeTabId };
    });
  }, [state.tabs]);
  const activateTab = useCallback(id => setState(current => current.tabs.some(tab => tab.id === id)
    ? { ...current, activeTabId: id } : current), []);
  const value = useMemo(() => ({ ...state, activeTab: state.tabs.find(tab => tab.id === state.activeTabId),
    updateTab, openTab, closeTab, activateTab }), [state, updateTab, openTab, closeTab, activateTab]);
  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}

export function useTabs() {
  const value = useContext(TabContext);
  if (!value) throw new Error('TabProvider is required.');
  return value;
}
