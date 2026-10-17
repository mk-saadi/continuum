import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';

// Phase 4 render-isolation fixture. Renders the REAL App shell (so TabPane
// memoization and tab wiring are exercised) while the heavy leaves are stubbed
// with render counters:
//   - ChatInterface: logs the palace.sessionId on every render, so the test can
//     count both total leaf renders and the number of DISTINCT mounted tabs
//     that rendered for a given action.
//   - Titlebar: a plain AppContent child, so its render count is a direct proxy
//     for AppContent renders (as in terminalLogIsolation.ui.cjs).
//   - MemorySettings / ModelSelectorModal: log mounts so modal propagation is
//     observable without depending on their internals.
//
// The stub `useMemoryPalace` returns a fresh object each call, so ChatInterface
// renders are attributed purely to the tab wiring under test.

let generation = 0;

window.mountApp = () => {
  localStorage.clear();
  window.chatRenderLog = [];
  window.titlebarRenders = 0;
  window.memorySettingsRenders = 0;
  window.modelSelectorRenders = 0;

  window.api = {
    getConfig: async () => ({ modelDirectory: '/models' }),
    listProjects: async () => [],
    getCloudProviders: async () => [],
    getBackgroundSettings: async () => null,
    getAttachmentPolicy: async () => ({ accept: '*', tooltip: 'Attach files' }),
  };
  window.terminalAPI = {
    onStatus: () => () => {},
    status: async () => ({ running: false, isLoaded: false, modelPath: null, modelName: null }),
  };
  window.engineAPI = { getConfig: async () => ({ port: 8080 }) };
  window.electronAPI = {
    getEngineStatus: async () => ({ running: false, isLoaded: false, modelPath: null, modelName: null }),
  };
  window.modelsAPI = { scanLocalModels: async () => ({ success: true, models: [] }) };
  window.chatAPI = {
    onStreamStatus: (callback) => { window.__emitStreamStatus = callback; return () => {}; },
    onToolApproval: () => () => {},
    onToolLimitReached: () => () => {},
    onLoopPaused: () => () => {},
  };

  createRoot(document.getElementById('root')).render(<App key={++generation} />);
};

// Adds `count` extra tabs through the real TabBar "+" control.
window.addTabs = async (count) => {
  for (let i = 0; i < count; i += 1) {
    const button = document.querySelector('button[aria-label="New chat tab"]');
    if (!button) throw new Error('new tab button missing');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
