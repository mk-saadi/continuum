import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface';
import { useMemoryPalace } from '../../src/components/MemoryPalace';

// Phase 5 measurement fixture.
//
// Two scenarios, both driving the REAL hook/components (nothing here is a stub
// of the code under test):
//   - HookProbe: calls the real `useMemoryPalace` and counts how many times the
//     returned object and each callback CHANGE IDENTITY across forced parent
//     rerenders with unchanged inputs.
//   - ChatParent: mirrors TabPane's wiring — it calls the real
//     `useMemoryPalace` and hands the result to the real `ChatInterface`
//     (like `App.jsx` does). It counts keydown listener registrations and
//     `pendingSkillProposals` calls across forced parent rerenders.
//
// `freshProvider` reproduces TabPane's pre-Phase-5 behavior (a new
// `activeChatProvider` object every render) so the provider-identity
// contribution can be isolated from the palace-object contribution.

// Modified probe: capture page errors for diagnostics.
window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String((event.error && event.error.stack) || event.message || event.error)));
window.addEventListener('unhandledrejection', (event) => window.__errors.push('rejection: ' + String(event.reason && event.reason.message ? event.reason.message : event.reason)));

// Count keydown registrations before React mounts anything.
window.__keydownAdds = 0;
window.__keydownRemoves = 0;
const rawAdd = window.addEventListener.bind(window);
const rawRemove = window.removeEventListener.bind(window);
window.addEventListener = (type, listener, options) => {
  if (type === 'keydown') window.__keydownAdds += 1;
  return rawAdd(type, listener, options);
};
window.removeEventListener = (type, listener, options) => {
  if (type === 'keydown') window.__keydownRemoves += 1;
  return rawRemove(type, listener, options);
};

const noop = () => {};
const STABLE_AVATARS = { showAvatars: false };

window.__sessions = {};
window.installPhase5Api = (sessions = {}) => {
  window.__sessions = sessions;
  window.__skillCalls = 0;
  window.memoryPalace = {
    getContextUsage: async () => ({ totalTokens: 100, messageCount: 1, hasSummary: false, telemetry: null }),
    getCoreMemories: async () => [],
    measureContext: async (sessionId, modelId) => ({
      sessionId,
      modelId,
      measuredAt: 'test',
      messageCount: 1,
      toolCount: 0,
      memoryEnabled: true,
      tokens: 10,
      method: 'approximate-full-request',
      limit: 100,
      budget: 50,
      confidence: 'estimated',
    }),
    prepareChatMessages: async () => [],
    saveMessage: async () => null,
    scheduleIdleCompression: async () => {},
    onCompressionComplete: () => () => {},
    saveSessionMemorySettings: async () => ({}),
    getAllSessions: async () => [],
    loadDisplaySession: async (id) => window.__sessions[id] ?? { id, messages: [] },
    loadSession: async (id) => window.__sessions[id] ?? { id, messages: [] },
    getOrCreateSession: async () => {},
    deleteMessage: async () => [],
    branchChat: async () => ({ sessionId: 'sess-chat' }),
    setActiveVariant: async () => null,
    createFolder: async () => {},
    renameSession: async () => {},
    moveSession: async () => {},
    deleteSession: async () => {},
    selectMessageBranch: async () => [],
  };
  window.api = {
    listAgents: async () => [],
    getSessionAgent: async () => null,
    getEffectiveSettings: async () => ({
      effective: { memoryEnabled: true, compactionEnabled: true, thinkingBudget: -1, allowMidRunQuestions: false, systemPrompt: '' },
      overrides: {},
      params: {},
    }),
    getAttachmentPolicy: async () => ({ accept: '*', tooltip: 'Attach files' }),
    saveSkill: async () => ({ id: 'saved' }),
  };
  window.mcpAPI = { onChanged: () => () => {}, getStatus: async () => ({ servers: [], pluginTokens: 0, toolTokens: 0 }) };
  window.chatAPI = {};
};

// --- Hook identity probe ---------------------------------------------------
const TRACKED = [
  'setSessionId',
  'refresh',
  'schedule',
  'prepareMessages',
  'finishMessage',
  'toggle',
  'measure',
  'noteLivePhase',
  'clearLiveTelemetry',
];

function HookProbe() {
  const [tick, setTick] = useState(0);
  window.__probeTick = () => setTick((value) => value + 1);
  const palace = useMemoryPalace('model-1', { contextLength: 100000 }, 'sess-probe', noop, {
    engineReady: false,
    isActive: false,
    pollIntervalMs: 100000,
  });
  if (window.__probeLast) {
    if (window.__probeLast.obj !== palace) window.__probeChanges.obj += 1;
    for (const name of TRACKED) {
      if (window.__probeLast[name] !== palace[name]) window.__probeChanges[name] += 1;
    }
  }
  window.__probeLast = { obj: palace, ...Object.fromEntries(TRACKED.map((name) => [name, palace[name]])) };
  window.__palaceProbe = palace;
  return null;
}

// --- ChatInterface churn probe --------------------------------------------
function ChatParent({ freshProvider, saved }) {
  const [tick, setTick] = useState(0);
  window.__chatTick = () => setTick((value) => value + 1);
  const palace = useMemoryPalace('model-1', { contextLength: 100000 }, 'sess-chat', noop, {
    engineReady: false,
    isActive: false,
    pollIntervalMs: 100000,
  });
  const memoProvider = useMemo(() => ({ type: 'local' }), []);
  const activeChatProvider = freshProvider ? { type: 'local' } : memoProvider;
  window.__chatPalace = palace;
  return (
    <ChatInterface
      tabActive
      view="chat"
      projects={[]}
      activeProjectId={null}
      onProjects={noop}
      onProject={noop}
      onCreateProject={noop}
      onChat={noop}
      renderWorkspace={() => null}
      selectedModel="model-1"
      baseUrl="http://127.0.0.1:9999"
      activeChatProvider={activeChatProvider}
      engineRunning
      activeModel={null}
      palace={palace}
      isSidebarOpen={false}
      avatarSettings={STABLE_AVATARS}
      isRightSidebarOpen={false}
      onCloseRightSidebar={noop}
      models={[]}
      onSelectModel={noop}
      onTabUpdate={noop}
      tabPermissionMode="ask_approval"
      tabSaved={saved}
      onTabSaved={noop}
    />
  );
}

const root = createRoot(document.getElementById('root'));

window.mountProbe = () => {
  window.__probeChanges = { obj: 0, ...Object.fromEntries(TRACKED.map((name) => [name, 0])) };
  window.__probeLast = null;
  window.__palaceProbe = null;
  root.render(<HookProbe />);
};

window.mountChat = ({ freshProvider = false, saved = false } = {}) => {
  root.render(<ChatParent key={`${freshProvider}-${saved}`} freshProvider={freshProvider} saved={saved} />);
};
