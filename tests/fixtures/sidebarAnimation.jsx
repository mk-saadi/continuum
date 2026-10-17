import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface';

// Fixture for the Phase 3 sidebar layout/animation suite. It renders the REAL
// ChatInterface (both sidebars included) against a deterministic in-memory
// session store, and exposes explicit open/closed controls so a test can drive
// the two panels independently, including rapid toggling.
const store = new Map();
let nextId = 1000;

window.chatAPI = {};
window.api = {
  listAgents: async () => [],
  getSessionAgent: async () => null,
  getEffectiveSettings: async () => ({
    effective: {
      thinkingBudget: -1,
      memoryEnabled: true,
      compactionEnabled: true,
      systemPrompt: '',
    },
    overrides: {},
    params: {},
  }),
  getAttachmentPolicy: async () => ({ accept: '*', tooltip: 'Attach files' }),
};

function createApi() {
  return {
    getAllSessions: async () => [
      { folder_name: 'Uncategorized', sessions: [...store.values()].map((session) => ({ id: session.id })) },
    ],
    onCompressionComplete: () => () => {},
    getOrCreateSession: async () => {},
    loadDisplaySession: async (id) => store.get(id),
    loadSession: async (id) => store.get(id),
    deleteMessage: async (id, messageId) => {
      const session = store.get(id);
      const retained = session.messages.filter((message) => message.id !== messageId);
      session.messages = retained;
      return retained;
    },
  };
}

function Fixture({ initialSessionId, messages, tabSaved, initialLeft, initialRight, scenarioKey }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [leftOpen, setLeftOpen] = useState(!!initialLeft);
  const [rightOpen, setRightOpen] = useState(!!initialRight);
  if (!store.has(initialSessionId)) store.set(initialSessionId, { id: initialSessionId, messages });
  // Marks which scenario's component currently owns the exposed controls, so a
  // test can never drive the previous (unmounting) fixture by mistake.
  window.__scenarioKey = scenarioKey;
  window.__setSessionId = setSessionId;
  window.__setLeftOpen = (value) => setLeftOpen(!!value);
  window.__setRightOpen = (value) => setRightOpen(!!value);
  window.__toggleLeft = () => setLeftOpen((value) => !value);
  window.__toggleRight = () => setRightOpen((value) => !value);

  const palace = {
    api: window.__api,
    sessionId,
    setSessionId,
    enabled: false,
    limit: null,
    usage: null,
    error: null,
    toast: null,
    refresh: async () => {},
    schedule: () => {},
    setDraftTokens: () => {},
    measure: () => {},
    measured: null,
    measureError: null,
    toggle: async () => {},
    noteLivePhase: () => {},
    clearLiveTelemetry: () => {},
    liveTelemetry: null,
    turnTelemetry: null,
    contextTokens: null,
    contextMethod: 'legacy-estimate',
    contextConfidence: 'estimated',
    fallbackTokens: null,
    totalTokens: null,
    toolTokens: 0,
    pluginTokens: 0,
    mcpStatus: null,
    prepareMessages: async (text) => {
      // Mirrors the main-process contract: the model context is built from the
      // full canonical history, never from what is currently mounted.
      const session = store.get(sessionId);
      const userMessage = { id: (nextId += 1), role: 'user', content: text };
      session.messages = [...session.messages, userMessage];
      window.__inferencePrepared = { sessionId, count: session.messages.length };
      return session.messages.map((message) => ({ role: message.role, content: message.content }));
    },
    finishMessage: async (text) => {
      const session = store.get(sessionId);
      const message = { id: (nextId += 1), role: 'assistant', content: text };
      session.messages = [...session.messages, message];
      return message;
    },
  };

  return (
    <ChatInterface
      tabActive
      view="chat"
      projects={[]}
      activeProjectId={null}
      onProjects={() => {}}
      onProject={() => {}}
      onCreateProject={() => {}}
      onChat={() => {}}
      renderWorkspace={() => null}
      selectedModel="test-model"
      baseUrl="http://localhost:9999"
      activeChatProvider={{ type: 'local' }}
      engineRunning
      activeModel={null}
      palace={palace}
      isSidebarOpen={leftOpen}
      avatarSettings={{ showAvatars: false }}
      isRightSidebarOpen={rightOpen}
      onCloseRightSidebar={() => setRightOpen(false)}
      models={[]}
      onSelectModel={() => {}}
      onTabUpdate={() => {}}
      tabPermissionMode="ask_approval"
      tabSaved={tabSaved}
      onTabSaved={() => {}}
    />
  );
}

const root = createRoot(document.getElementById('root'));

window.renderSidebarScenario = ({ key, sessionId, messages, tabSaved = true, left = false, right = false }) => {
  store.clear();
  nextId = 1000;
  window.__api = createApi();
  store.set(sessionId, { id: sessionId, messages });
  window.__canonical = messages;
  root.render(
    <Fixture
      key={key}
      scenarioKey={key}
      initialSessionId={sessionId}
      messages={messages}
      tabSaved={tabSaved}
      initialLeft={left}
      initialRight={right}
    />,
  );
};

window.seedSession = (id, messages) => {
  store.set(id, { id, messages });
  return messages;
};

window.sessionMessageCount = (id) => store.get(id)?.messages.length ?? 0;

window.switchSession = (id) => window.__setSessionId?.(id);
