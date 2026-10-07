export const TAB_STORAGE_KEY = 'continuum_open_tabs';

// A corrupt or hostile payload must not be able to grow without bound or
// resurrect duplicate tabs that would collide in the status/session routing.
const MAX_PERSISTED_TABS = 50;
const TAB_VIEWS = ['chat', 'project', 'projects'];
const PERMISSION_MODES = ['ask_approval', 'workspace_write'];

export function cycleActiveTabState(state, direction) {
  const { tabs, activeTabId } = state;
  if (!tabs.length || ![1, -1].includes(direction)) return state;
  const index = tabs.findIndex(tab => tab.id === activeTabId);
  const nextIndex = ((index < 0 ? 0 : index) + direction + tabs.length) % tabs.length;
  return { ...state, activeTabId: tabs[nextIndex].id };
}

export function closeTabState(state, id, createDefaultTab) {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  if (!tabs.length) {
    const tab = createDefaultTab();
    return { tabs: [tab], activeTabId: tab.id };
  }
  const activeTabId = state.activeTabId === id
    ? tabs[index > 0 ? index - 1 : 0].id
    : state.activeTabId;
  return { tabs, activeTabId };
}

export function closeAllTabsState(createDefaultTab) {
  const tab = createDefaultTab();
  return { tabs: [tab], activeTabId: tab.id };
}

export function moveTabState(state, fromIndex, toIndex) {
  const { tabs, activeTabId } = state;
  if (fromIndex === toIndex) return state;
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return state;
  if (fromIndex < 0 || fromIndex >= tabs.length) return state;
  if (toIndex < 0 || toIndex >= tabs.length) return state;
  const reordered = [...tabs];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  // Reordering never changes which tab is in front.
  return { tabs: reordered, activeTabId };
}

// Only durable, serialisable identity survives a restart. `status` is
// deliberately excluded: a crash mid-generation leaves 'generating' on disk,
// and no generation is running on the next launch, so the restored tab must
// read as idle rather than pulse forever.
export function sanitizeTab(tab) {
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return null;
  const id = typeof tab.id === 'string' && tab.id ? tab.id : null;
  const sessionId = typeof tab.sessionId === 'string' && tab.sessionId ? tab.sessionId : null;
  if (!id || !sessionId) return null;
  return {
    id,
    sessionId,
    title: typeof tab.title === 'string' && tab.title ? tab.title : 'New chat',
    modelId: typeof tab.modelId === 'string' ? tab.modelId : '',
    projectId: typeof tab.projectId === 'string' && tab.projectId ? tab.projectId : null,
    permissionMode: PERMISSION_MODES.includes(tab.permissionMode)
      ? tab.permissionMode
      : (typeof tab.projectId === 'string' && tab.projectId ? 'workspace_write' : 'ask_approval'),
    view: TAB_VIEWS.includes(tab.view) ? tab.view : 'chat',
    // False means "created but never written to the database yet".
    saved: tab.saved === true,
    status: 'idle',
  };
}

export function serializeTabState(state) {
  return JSON.stringify({
    tabs: state.tabs.map(tab => {
      const clean = sanitizeTab(tab);
      return { ...clean, status: undefined };
    }),
    activeTabId: state.activeTabId,
  });
}

// Returns null for anything unusable so the caller can fall back to a single
// default tab rather than booting into a half-restored, broken window.
export function parseTabState(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.tabs;
  if (!Array.isArray(entries)) return null;
  const seen = new Set();
  const tabs = [];
  for (const entry of entries.slice(0, MAX_PERSISTED_TABS)) {
    const tab = sanitizeTab(entry);
    // Two tabs bound to one session would make stream status ambiguous.
    if (!tab || seen.has(tab.id) || seen.has(tab.sessionId)) continue;
    seen.add(tab.id);
    seen.add(tab.sessionId);
    tabs.push(tab);
  }
  if (!tabs.length) return null;
  const requested = Array.isArray(parsed) ? null : parsed?.activeTabId;
  const activeTabId = tabs.some(tab => tab.id === requested) ? requested : tabs[0].id;
  return { tabs, activeTabId };
}

// `saved` is the only signal that separates a never-used tab from a chat that
// was deleted while the app was closed: an unsaved tab legitimately has no
// database row, so dropping it would lose a blank tab the user expects back.
export function dropOrphanTabs(state, isLiveSession) {
  if (!state) return null;
  const tabs = state.tabs.filter(tab => !tab.saved || isLiveSession(tab.sessionId));
  if (!tabs.length) return null;
  const activeTabId = tabs.some(tab => tab.id === state.activeTabId)
    ? state.activeTabId
    : tabs[0].id;
  return { tabs, activeTabId };
}