import React from 'react';
import { createRoot } from 'react-dom/client';
import TokenHistory from '../../src/components/settings/TokenHistory';
window.queries = [];
window.api = {
  listProjects: async () => [{ id: 'p1', name: 'Example project' }],
  getTokenHistory: async options => {
    window.queries.push(options);
    return { ...options, retentionMonths: window.retained || 12, data: [{ period: '2026-09-01', promptTokens: options.projectId ? 20 : 1200, completionTokens: 300, turns: 2 }] };
  },
  setTokenRetention: async months => { window.retained = months; },
};
createRoot(document.getElementById('root')).render(<TokenHistory />);
