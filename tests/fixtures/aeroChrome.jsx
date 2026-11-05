import React from 'react';
import { createRoot } from 'react-dom/client';
import { TabProvider } from '../../src/context/TabContext';
import { Titlebar } from '../../src/components/main-app/Titlebar';
import TabBar from '../../src/components/TabBar';
import Header from '../../src/components/main-app/Header';

createRoot(document.getElementById('root')).render(
  <TabProvider>
    <div className="relative flex flex-col overflow-hidden ui-radius-surface text-[var(--text-primary)]" style={{ margin: 40, minHeight: 400 }}>
      <Titlebar />
      <TabBar />
      <Header modelName="Local model" engineRunning palace={{ totalTokens: 1200, limit: 8192 }} />
      <main className="aero-panel m-4 p-4"><h1>Continuum workspace</h1><p>Quiet content beneath reflective chrome.</p></main>
    </div>
  </TabProvider>,
);
