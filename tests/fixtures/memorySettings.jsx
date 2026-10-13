import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MemorySettings from '../../src/components/main-app/MemorySettings';

let config = { mcpServers: { terminal: { disabled: false, command: 'node', args: ['server.js'], disabledTools: [] }, broken: { disabled: false, command: '/missing' } } };
const listeners = new Set();
const status = () => ({ servers: Object.entries(config.mcpServers).map(([name, definition]) => ({
  name, status: definition.disabled ? 'disabled' : name === 'broken' ? 'error' : 'connected',
  error: name === 'broken' ? 'spawn /missing ENOENT' : undefined,
  tools: name === 'terminal' ? ['run_command', 'run_script'].map(label => ({ name: label, label })) : [],
})) });
function publish() { for (const callback of listeners) callback(status()); return { config: structuredClone(config) }; }
window.api = {
  getAppSettings: async () => ({ mcpMode: 'manual', apiServerPort: 8080, disabledSkills: [], notificationEvents: {} }),
  getConfig: async () => ({ modelDirectory: '/models', appDataDirectory: '/data', engineIdleTimeoutMinutes: 15 }),
  getCloudProviders: async () => [],
  getCloudProviderDefaults: async () => ({}),
  getSubagentModel: async () => null,
  listSkills: async () => [],
  listProjects: async () => [],
  getTokenHistory: async options => ({ ...options, retentionMonths: 12, data: [] }),
  setTokenRetention: async months => { window.retained = months; },
  getEffectiveSettings: async () => ({ effective: { systemPrompt: '', temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1, maxTokens: -1, memoryEnabled: true, compactionEnabled: true } }),
  saveProfileSettings: async (modelPath, patch) => { window.savedProfile = { modelPath, patch }; },
  getMcpConfig: async () => structuredClone(config),
  saveMcpConfig: async value => { if (!value?.mcpServers) throw new Error('Missing mcpServers'); config = value; publish(); return structuredClone(config); },
};
window.mcpAPI = {
  onChanged: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  setServerEnabled: async (name, enabled) => { config.mcpServers[name].disabled = !enabled; return publish(); },
  setToolEnabled: async (tool, enabled, name) => {
    const disabled = new Set(config.mcpServers[name].disabledTools);
    if (enabled) disabled.delete(tool); else disabled.add(tool);
    config.mcpServers[name].disabledTools = [...disabled]; return publish();
  },
  setAllToolsEnabled: async (name, enabled) => { config.mcpServers[name].disabledTools = enabled ? [] : ['run_command', 'run_script']; return publish(); },
};
function Fixture() {
  const [mcpStatus, setStatus] = useState(status);
  React.useEffect(() => window.mcpAPI.onChanged(setStatus), []);
  return <MemorySettings models={[{ id: 'model', modelPath: '/models/test.gguf', name: 'Test model' }]} avatars={{ settings: { showAvatars: true, modelAvatars: {} }, update: async () => {} }} terminalLog={{ lines: [], clear() {} }} theme="dark" onChangeTheme={() => {}} onClose={() => {}} palace={{ enabled: true, toggle() {}, mcpStatus, limit: 8192, setLimit() {}, refresh: async () => {}, api: { getAllActiveMemories: async () => [] } }} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);
