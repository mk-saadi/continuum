import React from 'react';
import { createRoot } from 'react-dom/client';
import AssistantMessage from '../../src/components/AssistantMessage';
const root = createRoot(document.getElementById('root'));
window.renderMessages = messages => root.render(<div>{messages.map(message =>
  <article key={message.id} data-message-id={message.id}>
    {message.role === 'assistant' ? <AssistantMessage message={message} onSelectVariant={index => window.renderMessages(messages.map(row => row.id === message.id ? { ...row, active_variant_index: index } : row))} /> : message.content}
  </article>
)}</div>);

// Exercise the real branding store and settings panel, including storage reload.
import AvatarSettings from '../../src/components/AvatarSettings';
import useAvatarSettings from '../../src/hooks/useAvatarSettings';
function BrandingFixture() {
  const avatars = useAvatarSettings();
  return <AvatarSettings avatars={avatars} models={[{ id: '/models/raw.gguf', modelPath: '/models/raw.gguf', name: 'raw.gguf' }]} />;
}
window.renderBrandingSettings = () => root.render(<BrandingFixture />);

import RightSidebar from '../../src/components/RightSidebar';
function AgentSidebarFixture() {
  const [profile, setProfile] = React.useState(null);
  const preset = { id: 'agent-one', name: 'Test Agent', system_prompt: 'Reply with two bullets.' };
  return <RightSidebar open agents={[preset]} sessionId={null} sessionAgent={profile}
    onSelectAgent={payload => {
      window.agentPayload = payload;
      return new Promise(resolve => { window.finishAgentSelection = () => {
        setProfile(payload.agentId ? preset : null); resolve({ success: true, pending: true });
      }; });
    }} onSavePrompt={async prompt => { window.savedAgentPrompt = prompt; return true; }} />;
}
window.renderAgentSidebar = () => root.render(<AgentSidebarFixture />);

window.renderSettingsSidebar = modelId => root.render(<RightSidebar open agents={[]} sessionId="hierarchy-chat" modelId={modelId}
  onSelectAgent={async () => { window.settingsOverridden = false; return true; }} />);
