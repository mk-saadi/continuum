import React from 'react';
import { createRoot } from 'react-dom/client';
import { TabProvider, useTabs } from '../../src/context/TabContext.jsx';

// Mirrors the real App.jsx wiring: ChatInterface receives markTabSaved
// unbound and calls it with only its own session id.
function Probe() {
  const tabs = useTabs();
  window.tabsApi = tabs;
  return null;
}

const seed = [
  { id: 'tab_a', sessionId: 's1', title: 'First chat', modelId: '', projectId: null, permissionMode: 'ask_approval', view: 'chat', saved: false },
  { id: 'tab_b', sessionId: 's2', title: 'Second chat', modelId: '', projectId: null, permissionMode: 'ask_approval', view: 'chat', saved: false },
];

// Simulate the previous session's persisted state only on first load; a reload
// must not clobber the flag under test back to its seeded value.
if (!localStorage.getItem('continuum_open_tabs')) {
  localStorage.setItem('continuum_open_tabs', JSON.stringify({ tabs: seed, activeTabId: 'tab_a' }));
}

window.memoryPalace = { getAllSessions: async () => [{ folder_name: 'General', sessions: [{ id: 's1' }, { id: 's2' }] }] };
window.chatAPI = {};

createRoot(document.getElementById('root')).render(
  <TabProvider>
    <Probe />
  </TabProvider>,
);
