import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ModelSelectorModal from '../../src/components/main-app/ModelSelectorModal';
import CloudProviderSettings from '../../src/components/CloudProviderSettings';
const models = [{ id: '/first.gguf', modelPath: '/first.gguf', name: 'First local' }, { id: '/second.gguf', modelPath: '/second.gguf', name: 'Second local' }];
let rows = [{ id: 'openai', name: 'OpenAI', modelId: 'gpt-test', baseUrl: 'https://api.openai.com/v1', configured: true }, { id: 'anthropic', name: 'Anthropic', modelId: 'claude-test', baseUrl: 'https://api.anthropic.com/v1', configured: false }];
window.calls = { loads: [], kills: 0, saves: [] };
window.api = {
  getCloudProviders: async () => rows,
  getCloudProviderDefaults: async () => ({ defaultImageProviderId: '', defaultVideoProviderId: '' }),
  fetchCloudModels: async input => {
    window.calls.fetchModels = input;
    if (input.id === 'openai') return { models: ['gpt-test', 'gpt-other'] };
    if (input.id === 'anthropic') return { models: ['claude-test'] };
    return new Promise(resolve => { window.resolveModels = resolve; });
  },
  saveCloudProvider: async value => {
    window.calls.saves.push(value);
    const row = { ...value, apiKey: '', configured: true };
    rows = rows.some(item => item.id === value.id) ? rows.map(item => item.id === value.id ? row : item) : [...rows, row];
    return rows;
  },
  deleteCloudProvider: async value => { const id = typeof value === 'string' ? value : value?.id; rows = rows.filter(row => row.id !== id); return rows; },
  getModelLoadConfig: async () => ({ config: { contextLength: 8192, gpuOffload: 'auto', threads: 4, evalBatch: 2048, physicalBatch: 512, parallel: 1, mlock: false, flashAttention: 'auto', cacheTypeK: 'f16', cacheTypeV: 'f16', chatTemplate: 'auto', reasoningFormat: 'auto' }, remembered: false }),
  launchEngine: async id => { window.calls.loads.push(id); return { success: true, modelPath: id }; },
};
function Fixture() {
  const [open, setOpen] = useState(true);
  const [engines, setEngines] = useState([{ modelPath: models[0].id, modelName: models[0].name, isLoaded: true, capabilities: {} }]);
  const [target, setTarget] = useState({ type: 'local' });
  window.terminalAPI = { kill: async () => { window.calls.kills++; return { success: true }; } };
  window.fixtureState = { engines, target };
  return <><button id="open" onClick={() => setOpen(true)}>Open selector</button>
    {open && <ModelSelectorModal models={models} engines={engines} activeChatProvider={target} cloudProviders={rows}
      engineRunning={engines.length > 0} onSelectProvider={setTarget} onSelectModel={() => {}} onClose={() => setOpen(false)}
      onUnloadModel={async modelPath => { window.calls.kills++; setEngines(list => list.filter(engine => engine.modelPath !== modelPath)); }}
      onLoaded={result => { setEngines(list => [...list.filter(engine => engine.modelPath !== result.modelPath), { modelPath: result.modelPath, modelName: result.modelPath, isLoaded: true, capabilities: {} }]); setTarget({ type: 'local' }); }} onScan={() => {}} />}
    <CloudProviderSettings />
  </>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
