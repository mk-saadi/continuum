// B2 fixture: ChatInterface mounted with `activeProjectId` (the selected tab's
// project) deliberately different from the project on the chat's own session
// row. Each case is a separate session holding one completed propose_skill
// step, so Register must send the *chat's* project id.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface';

const proposal = name => ({ name, description: 'Suggested workflow', instructions: 'Do the thing.' });
const messageWithProposal = name => ({
  id: `msg-${name}`,
  role: 'assistant',
  content: 'Proposed a skill.',
  executionSteps: [{
    id: `step-${name}`,
    type: 'tool_call',
    toolName: 'propose_skill',
    serverName: 'native',
    status: 'complete',
    args: proposal(name),
  }],
});

// The chat's own project differs from the tab's in the first case and matches
// it in the second; the third session belongs to no project at all.
const sessions = {
  'session-rebound': { id: 'session-rebound', project_id: 'session-project', title: 'Rebound chat', messages: [messageWithProposal('rebound-skill')] },
  'session-normal': { id: 'session-normal', project_id: 'tab-project', title: 'Normal chat', messages: [messageWithProposal('normal-skill')] },
  'session-casual': { id: 'session-casual', project_id: null, title: 'Casual chat', messages: [messageWithProposal('casual-skill')] },
};

window.savedSkills = [];
window.api = {
  listAgents: async () => [],
  getSessionAgent: async () => null,
  getEffectiveSettings: async () => ({ effective: { memoryEnabled: false, allowMidRunQuestions: false }, params: {} }),
  saveSkill: payload => { window.savedSkills.push(payload); return Promise.resolve({ id: 'saved' }); },
};
window.chatAPI = { onEvent: () => () => {} };

const api = {
  getAllSessions: async () => [{
    folder_name: 'Uncategorized',
    sessions: Object.values(sessions).map(({ id, project_id, title }) => ({ id, project_id, title })),
  }],
  onCompressionComplete: () => () => {},
  loadSession: async id => sessions[id],
};

function Fixture() {
  const [sessionId, setSessionId] = useState('session-rebound');
  window.switchSession = setSessionId;
  const palace = {
    api,
    sessionId,
    setSessionId,
    setDraftTokens: () => {},
    refresh: async () => {},
    schedule: () => {},
    prepareMessages: async () => [],
    finishMessage: async () => ({ id: 2 }),
  };
  return (
    <ChatInterface
      palace={palace}
      selectedModel="model"
      baseUrl="http://localhost"
      engineRunning
      models={[]}
      view="chat"
      activeProjectId="tab-project"
      projects={[
        { id: 'tab-project', name: 'Tab project', is_pinned: 0 },
        { id: 'session-project', name: 'Session project', is_pinned: 0 },
      ]}
      avatarSettings={{ showAvatars: false }}
      tabSaved
    />
  );
}

createRoot(document.getElementById('root')).render(<Fixture />);
