import React from 'react';
import { useTabs } from '../context/TabContext.jsx';

export default function TabBar() {
  const { tabs, activeTabId, activateTab, closeTab, openTab, activeTab } = useTabs();
  return <nav aria-label="Chat tabs" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-raised)] px-2">
    {tabs.map(tab => <div key={tab.id} className={`group flex max-w-56 min-w-32 items-center gap-2 rounded-t-lg border border-b-0 px-2 py-1.5 text-xs ${tab.id === activeTabId ? 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'}`}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }}>
      <button type="button" onClick={() => activateTab(tab.id)} aria-current={tab.id === activeTabId ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={tab.title}>
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${tab.status === 'awaiting_approval' ? 'bg-amber-500' : tab.status === 'generating' ? 'animate-pulse bg-[var(--accent)]' : 'bg-[var(--text-muted)]'}`} />
        <span className="truncate">{tab.title}</span>
        {tab.status === 'awaiting_approval' && <span aria-label="Needs attention" title="Needs attention">⚠️</span>}
      </button>
      <button type="button" onClick={() => closeTab(tab.id)} aria-label={`Close ${tab.title}`} className="rounded px-1 hover:bg-[var(--surface-hover)]">×</button>
    </div>)}
    <button type="button" onClick={() => openTab(activeTab?.modelId || '')} aria-label="New chat tab" title="New chat tab" className="mb-1 rounded px-2 py-1 text-lg hover:bg-[var(--surface-hover)]">+</button>
  </nav>;
}
