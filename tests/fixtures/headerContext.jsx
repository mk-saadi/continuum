import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Header from '../../src/components/main-app/Header.jsx';
import { workspaceHeaderFor } from '../../src/lib/headerWorkspace.mjs';
import { parseTabState } from '../../src/lib/tabState.mjs';

// Both tabs come from a persisted-state round trip, so the header context is
// asserted against RESTORED tabs, not hand-made props.
const restored = parseTabState(JSON.stringify({
  tabs: [
    { id: 'casual', sessionId: 's-casual', title: 'Casual chat', modelId: '', projectId: null, view: 'chat', saved: false },
    { id: 'ws', sessionId: 's-ws', title: 'llm chat', modelId: '', projectId: 'p_llm', view: 'chat', saved: false },
  ],
  activeTabId: 'casual',
}));
const projects = [{ id: 'p_llm', name: 'llm-electron' }];
window.navLog = [];
window.clicks = { models: 0, settings: 0, sidebar: 0, right: 0 };

// Mirrors App.jsx TabPane: update(patch) is bound to the active tab and the
// workspace block comes from the same helper App.jsx uses.
function Harness() {
  const [tabs, setTabs] = useState(restored.tabs);
  const [activeTabId, setActiveTabId] = useState(restored.activeTabId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const tab = tabs.find((entry) => entry.id === activeTabId) || tabs[0];
  const update = (patch) => setTabs((current) => current.map((entry) => entry.id === tab.id ? { ...entry, ...patch } : entry));
  const workspace = workspaceHeaderFor(tab, projects, (patch) => {
    window.navLog.push({ tabId: tab.id, ...patch });
    update(patch);
  });
  return (
    <div>
      <div>
        {tabs.map((entry) => (
          <button key={entry.id} aria-label={`switch-${entry.id}`} onClick={() => setActiveTabId(entry.id)}>
            {entry.id}
          </button>
        ))}
      </div>
      <div data-view={tab.projectId ? `${tab.view}:${tab.projectId}` : tab.view}>
        view:{tab.view}{tab.projectId ? ` pid:${tab.projectId}` : ''}
      </div>
      <Header
        isSidebarOpen={sidebarOpen}
        onToggleSidebar={() => { window.clicks.sidebar += 1; setSidebarOpen((open) => !open); }}
        isRightSidebarOpen={rightOpen}
        onToggleRightSidebar={() => { window.clicks.right += 1; setRightOpen((open) => !open); }}
        modelName="Qwen 3.8"
        isCloud={false}
        engineRunning
        contextStatus="ready"
        onOpenModels={() => { window.clicks.models += 1; }}
        palace={{ totalTokens: null, limit: null, pluginTokens: 0, error: null }}
        onOpenSettings={() => { window.clicks.settings += 1; }}
        workspace={workspace}
      />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
