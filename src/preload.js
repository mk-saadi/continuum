'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
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
  getAllSessions: () => ipcRenderer.invoke('session:get-all'),
  loadSession: (sessionId) => ipcRenderer.invoke('session:load', { sessionId }),
  renameSession: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title }),
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
  getOrCreateSession: (sessionId, modelId) => ipcRenderer.invoke('session:get-or-create', { sessionId, modelId }),
  saveMessage: (sessionId, role, content, attachments = [], stats = null, toolCalls = null, thinking = null, messageId = null) => ipcRenderer.invoke('session:save-message', { sessionId, role, content, attachments, stats, toolCalls, thinking, messageId }),
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
  run: payload => ipcRenderer.invoke('engine:chat', payload),
  cancel: requestId => ipcRenderer.invoke('engine:cancel-chat', { requestId }),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('engine:chat-event', listener);
    return () => ipcRenderer.removeListener('engine:chat-event', listener);
  },
});
