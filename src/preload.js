'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// One native listener across every mounted tab; session-scoped fan-out.
const compactionSubscribers = new Map();
const dispatchCompactionActivity = (_event, record) => {
  for (const callback of [...(compactionSubscribers.get(record?.session_id) ?? [])]) {
    try { callback(record); } catch { /* A closed/broken pane cannot starve siblings. */ }
  }
};
function subscribeCompactionActivity(sessionId, callback) {
  if (!compactionSubscribers.size) ipcRenderer.on('workspace:compaction-activity', dispatchCompactionActivity);
  const callbacks = compactionSubscribers.get(sessionId) ?? new Set();
  // Wrap so independent subscriptions using the same function clean up separately.
  const listener = record => callback(record);
  callbacks.add(listener); compactionSubscribers.set(sessionId, callbacks);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    callbacks.delete(listener);
    if (!callbacks.size) compactionSubscribers.delete(sessionId);
    if (!compactionSubscribers.size) ipcRenderer.removeListener('workspace:compaction-activity', dispatchCompactionActivity);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  getEngineStatus: () => ipcRenderer.invoke('engine:get-status'),
});

contextBridge.exposeInMainWorld('api', {
  getCapabilityOverrides: () => ipcRenderer.invoke('models:capability-overrides'),
  saveCapabilityOverrides: (target, overrides) => ipcRenderer.invoke('models:save-capability-overrides', { target, overrides }),
  getModelCapabilities: modelId => ipcRenderer.invoke('engine:capabilities', { modelId }),
  getCloudProviders: () => ipcRenderer.invoke('cloud:get'),
  getCloudModelMetadata: () => ipcRenderer.invoke('cloud:model-metadata'),
  getCloudProviderDefaults: () => ipcRenderer.invoke('cloud:defaults:get'),
  saveCloudProviderDefaults: defaults => ipcRenderer.invoke('cloud:defaults:save', defaults),
  setNotificationPrefs: prefs => ipcRenderer.invoke('settings:set-notification-prefs', prefs),
  fetchCloudModels: settings => ipcRenderer.invoke('cloud:models', settings),
  saveCloudProvider: settings => ipcRenderer.invoke('cloud:save', settings),
  deleteCloudProvider: id => ipcRenderer.invoke('cloud:delete', id),
  getTokenHistory: options => ipcRenderer.invoke('tokens:history', options),
  setTokenRetention: months => ipcRenderer.invoke('tokens:retention', { months }),
  getSpendingDashboard: options => ipcRenderer.invoke('usage:dashboard', options),
  getSpendingAttribution: options => ipcRenderer.invoke('usage:attribution', options),
  getSpendingRecords: options => ipcRenderer.invoke('usage:records', options),
  getPricingHistory: options => ipcRenderer.invoke('usage:pricing-history', options),
  getUsageModelDetail: options => ipcRenderer.invoke('usage:model-detail', options),
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
  getBackgroundSettings: () => ipcRenderer.invoke('background:get'),
  pickBackgroundImage: () => ipcRenderer.invoke('background:pick'),
  setBackgroundOpacity: opacity => ipcRenderer.invoke('background:set-opacity', { opacity }),
  removeBackgroundImage: () => ipcRenderer.invoke('background:remove'),
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
  getAgentTools: (sessionId = null, permissionMode) => ipcRenderer.invoke('agent:get-tools', { sessionId, permissionMode }),
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
  // Capability-resolved reasoning view for the composer. The renderer shows
  // only controls this model/provider can honor; saved-but-unsupported intents
  // come back as warnings instead of a coerced value.
  getReasoningCapabilities: payload => ipcRenderer.invoke('reasoning:capabilities', payload),
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
  getSubagentBudgets: () => ipcRenderer.invoke('subagent:get-budgets'),
  saveSubagentBudgets: patch => ipcRenderer.invoke('subagent:save-budgets', patch),
  getChildTranscript: childSessionId => ipcRenderer.invoke('subagent:get-transcript', { childSessionId }),
  // Phase 1.3C continuation control. `describeChild`/`continuationStatus` are
  // read-only; `renewChildBudget`/`continueChild` require the owning
  // parentSessionId. `listRecoverableChildren`/`recoverChild` surface work that
  // survived an application restart; recovery never auto-executes.
  describeChild: childSessionId => ipcRenderer.invoke('subagent:describe', { childSessionId }),
  // Phase 1.5 minimal child control: interrupt the active turn at a safe
  // boundary (keeps the child resumable). Continue/renew use the Phase 1.3C
  // calls below and require the owning parentSessionId.
  interruptChild: (childSessionId, options = {}) => ipcRenderer.invoke('subagent:interrupt', { childSessionId, ...options }),
  getContinuationStatus: (childSessionId, parentSessionId) => ipcRenderer.invoke('subagent:continuation-status', { childSessionId, parentSessionId }),
  renewChildBudget: (childSessionId, renewal, options = {}) => ipcRenderer.invoke('subagent:renew-budget', { childSessionId, renewal, ...options }),
  continueChild: (childSessionId, options = {}) => ipcRenderer.invoke('subagent:continue', { childSessionId, ...options }),
  listRecoverableChildren: parentSessionId => ipcRenderer.invoke('subagent:list-recoverable', { parentSessionId }),
  recoverChild: (childSessionId, options = {}) => ipcRenderer.invoke('subagent:recover', { childSessionId, ...options }),
  getRecoveryOverview: sessionId => ipcRenderer.invoke('recovery:overview', { sessionId }),
  getRecoveryHistory: (sessionId, limit) => ipcRenderer.invoke('recovery:history', { sessionId, limit }),
  getRecoveryDetail: (sessionId, checkpointId) => ipcRenderer.invoke('recovery:detail', { sessionId, checkpointId }),
  previewRecoveryRestore: (sessionId, checkpointId, options) => ipcRenderer.invoke('recovery:preview', { sessionId, checkpointId, ...(options ?? {}) }),
  restoreRecoveryCheckpoint: (sessionId, checkpointId, options) => ipcRenderer.invoke('recovery:restore', { sessionId, checkpointId, ...(options ?? {}) }),
  pinRecoveryCheckpoint: (sessionId, checkpointId, pinned) => ipcRenderer.invoke('recovery:pin', { sessionId, checkpointId, pinned }),
  getRecoveryChangedFiles: sessionId => ipcRenderer.invoke('recovery:changed-files', { sessionId }),
  getRecoveryFileDiff: (sessionId, relPath) => ipcRenderer.invoke('recovery:file-diff', { sessionId, relPath }),
  getRecoveryCoveringCheckpoint: (sessionId, relPath) => ipcRenderer.invoke('recovery:covering-checkpoint', { sessionId, relPath }),
  getRecoveryStats: () => ipcRenderer.invoke('recovery:stats'),
  pruneRecoveryStore: () => ipcRenderer.invoke('recovery:prune'),
  getMcpConfig: () => ipcRenderer.invoke('mcp:get-config'),
  saveMcpConfig: config => ipcRenderer.invoke('mcp:save-config', config),
  getModelLoadConfig: (modelId) => ipcRenderer.invoke('engine:get-load-config', { modelId }),
  launchEngine: (modelId, config) => ipcRenderer.invoke('engine:launch', { modelId, config }),
  getAttachmentPolicy: target => ipcRenderer.invoke('file:attachment-policy', target),
  processUploads: (files, target) => {
    const paths = Array.from(files, (file) => {
      if (typeof file?.dataUrl === 'string') return { name: file.name, dataUrl: file.dataUrl };
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) throw new Error('Choose a file from disk.');
      return filePath;
    });
    return ipcRenderer.invoke('file:process-uploads', target ? { ...target, files: paths } : paths);
  },
});

contextBridge.exposeInMainWorld('memoryPalace', {
  listCompactionActivity: sessionId => ipcRenderer.invoke('workspace:compaction-activity-list', { sessionId }),
  onCompactionActivity: subscribeCompactionActivity,

  regenerateLast: payload => ipcRenderer.invoke('session:regenerate-last', payload),
  setActiveVariant: (sessionId, messageId, index) => ipcRenderer.invoke('session:set-active-variant', { sessionId, messageId, index }),
  selectMessageBranch: (sessionId, messageId) => ipcRenderer.invoke('session:select-message-branch', { sessionId, messageId }),
  getAllSessions: () => ipcRenderer.invoke('session:get-all'),
  createFolder: (folderName) => ipcRenderer.invoke('session:create-folder', { folderName }),
  loadSession: (sessionId) => ipcRenderer.invoke('session:load', { sessionId }),
  renameSession: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title }),
  generateSessionTitle: payload => ipcRenderer.invoke('session:generate-title', payload),
  moveSession: (sessionId, folderName) => ipcRenderer.invoke('session:move-to-folder', { sessionId, folderName }),
  onSessionDeleted: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('session:deleted', listener);
    return () => ipcRenderer.removeListener('session:deleted', listener);
  },
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
  measureContext: (sessionId, modelId, options) => ipcRenderer.invoke('session:measure-context', { sessionId, modelId, ...(options ?? {}) }),
  getActiveMessages: (sessionId) => ipcRenderer.invoke('session:get-messages', { sessionId }),
  getSessionSummary: (sessionId) => ipcRenderer.invoke('session:get-summary', { sessionId }),
  getCheckpoint: (sessionId) => ipcRenderer.invoke('session:get-checkpoint', { sessionId }),
  getCheckpointHistory: (sessionId, limit) => ipcRenderer.invoke('session:get-checkpoint-history', { sessionId, limit }),
  getBriefs: (sessionId) => ipcRenderer.invoke('session:get-briefs', { sessionId }),
  getBackgroundCommands: sessionId => ipcRenderer.invoke('session:get-background-commands', { sessionId }),
  onBackgroundCommand: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('session:background-command', listener);
    return () => ipcRenderer.removeListener('session:background-command', listener);
  },
  getPlan: (sessionId) => ipcRenderer.invoke('session:get-plan', { sessionId }),
  generateCompactCandidate: (sessionId, modelId) => ipcRenderer.invoke('session:generate-compact-candidate', { sessionId, modelId }),
  onPlanUpdated: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('session:plan-updated', listener);
    return () => ipcRenderer.removeListener('session:plan-updated', listener);
  },
  getArchivedMessages: (sessionId, options) => ipcRenderer.invoke('session:get-archived-messages', { sessionId, ...(options ?? {}) }),
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
  setPermissionMode: (sessionId, permissionMode) => ipcRenderer.invoke('engine:set-permission-mode', { sessionId, permissionMode }),
  branchAndExecute: payload => ipcRenderer.invoke('engine:branch-and-execute', payload),
  cancel: requestId => ipcRenderer.invoke('engine:cancel-chat', { requestId }),
  cancelSession: sessionId => ipcRenderer.invoke('engine:cancel-session', { sessionId }),
  // Phase 2.1 live steering. `runId` always comes from the main-process
  // generating status event; it is never invented by the renderer.
  steer: ({ sessionId, runId, content, idempotencyKey }) =>
    ipcRenderer.invoke('steering:submit', { sessionId, runId, content, idempotencyKey }),
  getActiveRun: sessionId => ipcRenderer.invoke('steering:active', { sessionId }),
  getSteeringHistory: (sessionId, limit) => ipcRenderer.invoke('steering:history', { sessionId, limit }),
  cancelSteering: ({ sessionId, runId, steeringId }) =>
    ipcRenderer.invoke('steering:cancel', { sessionId, runId, steeringId }),
  onSteering: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('steering:updated', listener);
    return () => ipcRenderer.removeListener('steering:updated', listener);
  },
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:chat-event', listener);
    return () => ipcRenderer.removeListener('engine:chat-event', listener);
  },
});

// Window and engine controls share the same sandbox-compatible Electron import.
contextBridge.exposeInMainWorld("windowAPI", {
	minimize: () => ipcRenderer.send("window:minimize"),
	maximize: () => ipcRenderer.send("window:maximize"),
	close: () => ipcRenderer.send("window:close"),
});

contextBridge.exposeInMainWorld("terminalAPI", {
	spawn: (command) => ipcRenderer.invoke("terminal:spawn", command),
	kill: () => ipcRenderer.invoke("terminal:kill"),
	status: () => ipcRenderer.invoke("terminal:status"),
	onOutput: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("terminal:output", listener);
		return () => ipcRenderer.removeListener("terminal:output", listener);
	},
	onStatus: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("terminal:status", listener);
		return () => ipcRenderer.removeListener("terminal:status", listener);
	},
});

contextBridge.exposeInMainWorld("modelsAPI", {
	scanLocalModels: (scanPath) => ipcRenderer.invoke("models:scanLocal", scanPath),
	getActiveModels: () => ipcRenderer.invoke("get-active-models"),
});

contextBridge.exposeInMainWorld("engineAPI", {
	getConfig: () => ipcRenderer.invoke("terminal:getConfig"),
});
