import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import TerminalLog from '../../src/components/TerminalLog';
import { terminalLogStore } from '../../src/lib/terminalLogStore.mjs';

// The store singleton captures window.terminalAPI when this module loads, so
// the test page defines it in an inline script before this bundle runs.
let generation = 0;
window.mountApp = () => {
  localStorage.clear();
  window.api = {
    getConfig: async () => ({ modelDirectory: '/models' }),
    listProjects: async () => [],
    getCloudProviders: async () => [],
  };
  window.engineAPI = { getConfig: async () => ({ port: 8080 }) };
  window.electronAPI = {
    getEngineStatus: async () => ({ running: false, isLoaded: false, modelPath: null, modelName: null }),
  };
  window.modelsAPI = { scanLocalModels: async () => ({ success: true, models: [] }) };
  window.titlebarRenders = 0;
  createRoot(document.getElementById('app')).render(<App key={++generation} />);
};

// A stand-in for the settings panel's TerminalLog: it subscribes to the store
// but its parent must not re-render when output arrives.
function LogFixture() {
  window.logFixtureRenders = (window.logFixtureRenders || 0) + 1;
  return <TerminalLog engineRunning serverPort={8080} serverError={null} />;
}
window.mountLogPanel = () => {
  window.logFixtureRenders = 0;
  window.logRoot = createRoot(document.getElementById('log'));
  window.logRoot.render(<LogFixture />);
};
window.unmountLogPanel = () => { window.logRoot.unmount(); };

window.getLogLines = () => terminalLogStore.getSnapshot();
