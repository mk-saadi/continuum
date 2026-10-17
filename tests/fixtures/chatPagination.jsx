import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface';

// Fresh session store per scenario. The store holds the CANONICAL messages the
// renderer loads; ChatInterface must never shorten or replace these.
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

function Fixture({ initialSessionId, messages, tabSaved }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  if (!store.has(initialSessionId)) store.set(initialSessionId, { id: initialSessionId, messages });
  window.__setSessionId = setSessionId;

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
      isSidebarOpen={false}
      avatarSettings={{ showAvatars: false }}
      isRightSidebarOpen={false}
      onCloseRightSidebar={() => {}}
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

window.renderScenario = ({ key, sessionId, messages, tabSaved = true }) => {
  store.clear();
  nextId = 1000;
  window.__api = createApi();
  store.set(sessionId, { id: sessionId, messages });
  window.__canonical = messages;
  root.render(<Fixture key={key} initialSessionId={sessionId} messages={messages} tabSaved={tabSaved} />);
};

window.seedSession = (id, messages) => {
  store.set(id, { id, messages });
  return messages;
};

window.sessionMessageCount = (id) => store.get(id)?.messages.length ?? 0;

window.switchSession = (id) => window.__setSessionId?.(id);
