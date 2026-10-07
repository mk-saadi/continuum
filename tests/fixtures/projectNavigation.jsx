import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface';
const saved = new Map();
window.api = { listAgents: async () => [], getSessionAgent: async () => null,
  getEffectiveSettings: async () => ({ effective: { memoryEnabled: true }, params: {} }) };
const api = {
  getAllSessions: async () => [{ folder_name: 'Uncategorized', sessions: [...saved.values()] }],
  onCompressionComplete: () => () => {},
  getOrCreateSession: async (id, modelId, projectId) => { window.linked = { id, modelId, projectId }; saved.set(id, { id, project_id: projectId, messages: [] }); },
  loadSession: async id => saved.get(id),
};
window.chatAPI = { onEvent: () => () => {}, run: async payload => { window.generation = payload; return {}; } };
function Fixture() {
  const [sessionId, setSessionId] = useState('draft');
  const [view, setView] = useState('project');
  const palace = { api, sessionId, setSessionId, setDraftTokens: () => {}, refresh: async () => {}, schedule: () => {},
    prepareMessages: async text => { window.prepared = { sessionId, text }; saved.get(sessionId).messages = [{ id: 1, role: 'user', content: text }]; return [{ role: 'user', content: text }]; },
    finishMessage: async () => ({ id: 2 }),
  };
  return <ChatInterface palace={palace} selectedModel="model" baseUrl="http://localhost" engineRunning models={[]}
    view={view} isSidebarOpen activeProjectId="p1" projects={[{ id: 'p1', name: 'Project', is_pinned: 0 }]} avatarSettings={{ showAvatars: false }}
    onProjects={() => setView('project')} onProject={() => setView('project')} onChat={() => setView('chat')}
    renderWorkspace={({ startProjectChat, busy }) => view !== 'chat' && <button id="start" disabled={busy} onClick={() => startProjectChat('p1', 'Project prompt')}>Start</button>} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);
