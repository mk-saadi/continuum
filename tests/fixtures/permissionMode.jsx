import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatInputBar from '../../src/components/ChatInputBar.jsx';
import ProjectWorkspace from '../../src/components/ProjectWorkspace.jsx';
import {
  availablePermissionModes,
  defaultPermissionMode,
} from '../../src/lib/permissionModes.mjs';

// The composer and the project settings panel must read the same catalog:
// casual chats offer three modes, workspace chats four, and a project without
// a connected root can neither select nor default to Workspace Write.
const records = {
  p_workspace: {
    id: 'p_workspace', name: 'Workspace project', description: 'Goal',
    root_path: '/tmp/permission-mode-ui/workspace', permission_mode: 'workspace_write',
    custom_instructions: '', enabledSkills: [], files: [],
  },
  p_rootless: {
    id: 'p_rootless', name: 'Rootless project', description: 'Goal',
    root_path: '', permission_mode: 'workspace_write',
    custom_instructions: '', enabledSkills: [], files: [],
  },
};

window.updateCalls = [];
window.api = {
  getProject: async id => structuredClone(records[id]),
  updateProject: async (id, patch) => {
    window.updateCalls.push({ id, patch });
    const record = records[id];
    Object.assign(record, patch);
    if (patch.permissionMode) {
      record.permission_mode = patch.permissionMode;
      delete record.permissionMode;
    }
    return structuredClone(record);
  },
  setProjectPinned: async (id, value) => ({ ...records[id], is_pinned: Number(value) }),
  selectDirectory: async () => null,
  importProjectFiles: async () => [],
  removeProjectFile: () => {},
  listSkills: async () => [],
  importSkill: async () => null,
  getEffectiveSettings: async () => ({ effective: { thinkingBudget: -1 } }),
  saveSamplingParams: async () => {},
  saveProfileSettings: async () => {},
};

const noop = () => {};

function Composer({ id, project }) {
  return (
    <div id={id}>
      <ChatInputBar
        sessionId={`${id}-session`}
        modelId="model-a"
        permissionMode={defaultPermissionMode(project)}
        permissionModes={availablePermissionModes(project)}
        onSubmit={noop}
        canSubmit
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <>
    <Composer id="casual" project={null} />
    <Composer id="workspace" project={records.p_workspace} />
    <div id="panel-workspace">
      <ProjectWorkspace projectId="p_workspace" onBack={noop} onUpdated={noop} onLoadChat={noop} onStartChat={noop} />
    </div>
    <div id="panel-rootless">
      <ProjectWorkspace projectId="p_rootless" onBack={noop} onUpdated={noop} onLoadChat={noop} onStartChat={noop} />
    </div>
  </>,
);
