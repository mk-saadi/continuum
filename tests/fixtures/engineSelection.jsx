import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
const root = createRoot(document.getElementById('root'));
let generation = 0;
window.mountApp = ({ status, delayed = false, scanned = [] }) => {
  window.api = {
    getConfig: async () => ({ modelDirectory: '/models' }),
    listProjects: async () => [],
    getCloudProviders: async () => [{ id: 'openai', name: 'OpenAI', modelId: 'test-cloud', configured: true }],
  };
  window.terminalAPI = { onStatus: fn => { window.emitStatus = fn; return () => {}; }, status: async () => status };
  window.engineAPI = { getConfig: async () => ({ port: 8080 }) };
  window.electronAPI = { getEngineStatus: () => delayed ? new Promise(resolve => { window.resolveInitialStatus = resolve; }) : Promise.resolve(status) };
  window.modelsAPI = { scanLocalModels: async () => ({ success: true, models: scanned }) };
  root.render(<App key={++generation} />);
};
