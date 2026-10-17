import React from 'react';
import { createRoot } from 'react-dom/client';
import { TabProvider, useTabs } from '../../src/context/TabContext.jsx';

// Phase 6 persistence probe. Mounts the REAL TabProvider so the actual
// persistence path is exercised, and instruments the two operations the phase
// is about: `localStorage.setItem` for the tab key, and `JSON.stringify` of a
// tab-state payload. Counts are reset from the test between scenarios.
const TAB_KEY = 'continuum_open_tabs';

const nativeSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  if (key === TAB_KEY) {
    if (window.failTabWrites) throw new Error('simulated storage failure');
    if (window.countTabWrites) window.tabWrites.push(String(value));
  }
  return nativeSetItem.call(this, key, value);
};

const nativeStringify = JSON.stringify;
JSON.stringify = function (...args) {
  const out = nativeStringify.apply(JSON, args);
  // Tab-state payloads are the only JSON containing an `activeTabId` key.
  if (window.countTabWrites && typeof out === 'string' && out.includes('"activeTabId"')) {
    window.tabSerializeCount += 1;
  }
  return out;
};

window.tabWrites = [];
window.tabSerializeCount = 0;
window.countTabWrites = true;
window.failTabWrites = false;
window.resetPersistenceCounters = () => {
  window.tabWrites = [];
  window.tabSerializeCount = 0;
};

function Probe() {
  window.tabsApi = useTabs();
  return null;
}

let root = null;
window.mountProvider = (options = {}) => {
  if (!root) root = createRoot(document.getElementById('root'));
  const tree = (
    <TabProvider>
      <Probe />
    </TabProvider>
  );
  root.render(options.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
};
