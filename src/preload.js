'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getEngineStatus: () => ipcRenderer.invoke('engine:get-status'),
});

contextBridge.exposeInMainWorld('api', {
  getCloudProviders: () => ipcRenderer.invoke('cloud:get'),
  getCloudProviderDefaults: () => ipcRenderer.invoke('cloud:defaults:get'),
  saveCloudProviderDefaults: defaults => ipcRenderer.invoke('cloud:defaults:save', defaults),
  setNotificationPrefs: prefs => ipcRenderer.invoke('settings:set-notification-prefs', prefs),
  fetchCloudModels: settings => ipcRenderer.invoke('cloud:models', settings),
  saveCloudProvider: settings => ipcRenderer.invoke('cloud:save', settings),
  deleteCloudProvider: id => ipcRenderer.invoke('cloud:delete', id),
  getTokenHistory: options => ipcRenderer.invoke('tokens:history', options),
  setTokenRetention: months => ipcRenderer.invoke('tokens:retention', { months }),
  exportChat: (chatId, format) => ipcRenderer.invoke('chat:export', { chatId, format }),
  openPath: filePath => ipcRenderer.invoke('shell:open-path', filePath),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setEngineIdleTimeout: minutes => ipcRenderer.invoke('config:set-idle-timeout', minutes),
  pickDirectory: () => ipcRenderer.invoke('config:pick-directory'),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  setModelDirectory: directory => ipcRenderer.invoke('config:set-model-directory', { directory }),
  migrateAppData: directory => ipcRenderer.invoke('config:migrate-app-data', { directory }),
  getAvatarSettings: () => ipcRenderer.invoke('avatars:get'),
  saveAvatarSettings: settings => ipcRenderer.invoke('avatars:save', settings),
  getProfileSettings: () => ipcRenderer.invoke('settings:profiles'),
  saveProfileSettings: (modelPath, patch) => ipcRenderer.invoke('settings:save-profile', { modelPath, patch }),
  getEffectiveSettings: (sessionId, modelPath) => ipcRenderer.invoke('settings:effective', { sessionId, modelPath }),
  saveSessionMemorySettings: (sessionId, modelId, patch) => ipcRenderer.invoke('settings:save-memory', { sessionId, modelId, patch }),
  saveSessionPrompt: (sessionId, prompt, modelId) => ipcRenderer.invoke('agents:save-session-prompt', { sessionId, prompt, modelId }),
  createProject: project => ipcRenderer.invoke('project:create', project),
  updateProject: (id, patch) => ipcRenderer.invoke('project:update', { ...patch, id }),
  deleteProject: id => ipcRenderer.invoke('project:delete', { id }),
  listProjects: () => ipcRenderer.invoke('project:list'),
  getProject: id => ipcRenderer.invoke('project:get_by_id', { id }),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  saveSkill: skill => ipcRenderer.invoke('skills:save', skill),
  deleteSkill: id => ipcRenderer.invoke('skills:delete', { id }),
  importSkill: projectId => ipcRenderer.invoke('skills:import', { projectId }),
  // The native dialog cannot offer file and folder selection at once (on Linux
  // it becomes a folder picker), so folder import is its own picker mode over
  // the same skills:import handler.
  importSkillFolder: projectId => ipcRenderer.invoke('skills:import', { projectId, kind: 'folder' }),
  importProjectFiles: (projectId, files) => ipcRenderer.invoke('project:import_files', { project_id: projectId, file_paths: Array.from(files, file => webUtils.getPathForFile(file)) }),
  addProjectFile: (projectId, file) => ipcRenderer.invoke('project:add_file', { ...file, project_id: projectId }),
  removeProjectFile: id => ipcRenderer.invoke('project:remove_file', { id }),
  setProjectPinned: (id, isPinned) => ipcRenderer.invoke('project:set_pinned', { id, is_pinned: isPinned }),
  getAgentTools: () => ipcRenderer.invoke('agent:get-tools'),
  executeAgentTool: data => ipcRenderer.invoke('agent:execute-tool', data),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  createAgent: agent => ipcRenderer.invoke('agents:create', agent),
  updateAgent: (id, agent) => ipcRenderer.invoke('agents:update', { id, agent }),
  duplicateAgent: id => ipcRenderer.invoke('agents:duplicate', { id }),
  deleteAgent: id => ipcRenderer.invoke('agents:delete', { id }),
  getSessionAgent: sessionId => ipcRenderer.invoke('agents:session', { sessionId }),
  applyAgent: (sessionId, agentId, modelId) => ipcRenderer.invoke('agents:apply',
    sessionId && typeof sessionId === 'object' ? sessionId : { sessionId, agentId, modelId }),
  getSamplingParams: (sessionId, modelId) => ipcRenderer.invoke('sampling:get', { sessionId, modelId }),
  saveSamplingParams: (sessionId, modelId, params) => ipcRenderer.invoke('sampling:save', { sessionId, modelId, params }),
  getRagSettings: () => ipcRenderer.invoke('rag:get-settings'),
  saveRagSettings: settings => ipcRenderer.invoke('rag:save-settings', settings),
  indexDocuments: payload => ipcRenderer.invoke('rag:index', payload),
  getAppSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveAppSettings: settings => ipcRenderer.invoke('app:save-settings', settings),
  // Sub-agent model selection: null follows the chat's model, { type: 'local' }
  // is the local model server, { type: 'cloud', provider, model } a saved
  // cloud provider (see src/main/subagents/modelSelection.js).
  getSubagentModel: () => ipcRenderer.invoke('subagent:get-model'),
  saveSubagentModel: selection => ipcRenderer.invoke('subagent:save-model', selection),
  getMcpConfig: () => ipcRenderer.invoke('mcp:get-config'),
  saveMcpConfig: config => ipcRenderer.invoke('mcp:save-config', config),
  getModelLoadConfig: (modelId) => ipcRenderer.invoke('engine:get-load-config', { modelId }),
  launchEngine: (modelId, config) => ipcRenderer.invoke('engine:launch', { modelId, config }),
  processUploads: (files) => {
    const paths = Array.from(files, (file) => {
      if (typeof file?.dataUrl === 'string') return { name: file.name, dataUrl: file.dataUrl };
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) throw new Error('Choose a file from disk.');
      return filePath;
    });
    return ipcRenderer.invoke('file:process-uploads', paths);
  },
});

contextBridge.exposeInMainWorld('memoryPalace', {
  regenerateLast: payload => ipcRenderer.invoke('session:regenerate-last', payload),
  setActiveVariant: (sessionId, messageId, index) => ipcRenderer.invoke('session:set-active-variant', { sessionId, messageId, index }),
  selectMessageBranch: (sessionId, messageId) => ipcRenderer.invoke('session:select-message-branch', { sessionId, messageId }),
  getAllSessions: () => ipcRenderer.invoke('session:get-all'),
  createFolder: (folderName) => ipcRenderer.invoke('session:create-folder', { folderName }),
  loadSession: (sessionId) => ipcRenderer.invoke('session:load', { sessionId }),
  renameSession: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title }),
  generateSessionTitle: payload => ipcRenderer.invoke('session:generate-title', payload),
  moveSession: (sessionId, folderName) => ipcRenderer.invoke('session:move-to-folder', { sessionId, folderName }),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', { sessionId }),
  deleteMessage: (sessionId, messageId) => ipcRenderer.invoke('session:delete-message', { sessionId, messageId }),
  branchChat: (sourceSessionId, targetMessageId) => ipcRenderer.invoke('session:branch-chat', { sourceSessionId, targetMessageId }),
  editMessage: (messageId, newContent) => ipcRenderer.invoke('session:edit-message', { messageId, newContent }),
  getMemoryTools: () => ipcRenderer.invoke('memory:get-tools'),
  executeMemoryTool: (data) => ipcRenderer.invoke('memory:execute-tool', data),
  prepareChatMessages: (sessionId, modelId, userText, memoryEnabled = true, regenerate = false, attachments = []) =>
    ipcRenderer.invoke('session:prepare-messages', { sessionId, modelId, userText, memoryEnabled, regenerate, attachments }),
  getCoreMemories: (modelId) => ipcRenderer.invoke('memory:get-core', { modelId }),
  searchPermanentMemories: (query, modelId) => ipcRenderer.invoke('memory:search', { query, modelId }),
  addPermanentMemory: (data) => ipcRenderer.invoke('memory:add', data),
  getAllActiveMemories: () => ipcRenderer.invoke('memory:all'),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  getOrCreateSession: (sessionId, modelId, projectId) => ipcRenderer.invoke('session:get-or-create', { sessionId, modelId, projectId }),
  saveMessage: (sessionId, role, content, attachments = [], stats = null, toolCalls = null, thinking = null, messageId = null, identity = null, executionSteps = null) => ipcRenderer.invoke('session:save-message', { sessionId, role, content, attachments, stats, toolCalls, thinking, messageId, identity, displayName: identity?.displayName, executionSteps }),
  loadDisplaySession: sessionId => ipcRenderer.invoke('session:load-display', { sessionId }),
  getContextUsage: (sessionId, modelId) => ipcRenderer.invoke('session:get-usage', { sessionId, modelId }),
  getActiveMessages: (sessionId) => ipcRenderer.invoke('session:get-messages', { sessionId }),
  getSessionSummary: (sessionId) => ipcRenderer.invoke('session:get-summary', { sessionId }),
  onCompressionComplete: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('session:compression-complete', listener);
    return () => ipcRenderer.removeListener('session:compression-complete', listener);
  },
  scheduleIdleCompression: (sessionId, modelId, contextWindowLimit) =>
    ipcRenderer.invoke('session:trigger-compression', { sessionId, modelId, contextWindowLimit }),
});

contextBridge.exposeInMainWorld('mcpAPI', {
  getStatus: () => ipcRenderer.invoke('mcp:get-status'),
  getTools: () => ipcRenderer.invoke('mcp:get-tools'),
  setServerEnabled: (serverName, enabled) => ipcRenderer.invoke('mcp:set-server-enabled', { serverName, enabled }),
  setToolEnabled: (name, enabled, serverName) => ipcRenderer.invoke('mcp:set-tool-enabled', { name, enabled, serverName }),
  setAllToolsEnabled: (serverName, enabled) => ipcRenderer.invoke('mcp:set-all-tools-enabled', { serverName, enabled }),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('mcp:changed', listener);
    return () => ipcRenderer.removeListener('mcp:changed', listener);
  },
});
contextBridge.exposeInMainWorld('chatAPI', {
  onStreamStatus: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:stream-status', listener);
    return () => ipcRenderer.removeListener('engine:stream-status', listener);
  },
  onStreamChunk: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:stream-chunk', listener);
    return () => ipcRenderer.removeListener('engine:stream-chunk', listener);
  },
  respondToToolApproval: (requestId, approvalId, action) => ipcRenderer.invoke('engine:tool-approval-response', { requestId, approvalId, action }),
  onToolApproval: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:request-tool-approval', listener);
    return () => ipcRenderer.removeListener('engine:request-tool-approval', listener);
  },
  respondToAskUser: (requestId, questionId, answer) => ipcRenderer.invoke('engine:ask-user-response', { requestId, questionId, answer }),
  onAskUser: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:ask-user', listener);
    return () => ipcRenderer.removeListener('engine:ask-user', listener);
  },
  respondToLoop: (requestId, action) => ipcRenderer.invoke('loop:respond', { requestId, action }),
  respondToToolLimit: (requestId, action) => ipcRenderer.invoke('engine:tool-limit-response', { requestId, action }),
  onToolLimitReached: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:tool-limit-reached', listener);
    return () => ipcRenderer.removeListener('engine:tool-limit-reached', listener);
  },
  onLoopPaused: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('loop:paused', listener);
    return () => ipcRenderer.removeListener('loop:paused', listener);
  },
  onStepUpdate: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('stream:step-update', listener);
    return () => ipcRenderer.removeListener('stream:step-update', listener);
  },
  run: payload => ipcRenderer.invoke('engine:chat', payload),
  branchAndExecute: payload => ipcRenderer.invoke('engine:branch-and-execute', payload),
  cancel: requestId => ipcRenderer.invoke('engine:cancel-chat', { requestId }),
  cancelSession: sessionId => ipcRenderer.invoke('engine:cancel-session', { sessionId }),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:chat-event', listener);
    return () => ipcRenderer.removeListener('engine:chat-event', listener);
  },
});
