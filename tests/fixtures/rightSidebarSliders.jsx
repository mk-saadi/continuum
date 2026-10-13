import React from 'react';
import { createRoot } from 'react-dom/client';
import RightSidebar from '../../src/components/RightSidebar';
let params = { temperature: 1, top_p: 0.5, top_k: 40, repeat_penalty: 1.25, max_tokens: -1 };
window.commits = [];
window.api = {
  getEffectiveSettings: async () => ({ source: 'model', overrides: {}, effective: { systemPrompt: '', memoryEnabled: true, compactionEnabled: true } }),
  getSamplingParams: async () => ({ params: { ...params }, overrides: {}, exists: true }),
  saveSamplingParams: async (sessionId, modelId, patch) => {
    window.commits.push(patch);
    await new Promise(resolve => setTimeout(resolve, 100));
    params = { ...params, ...patch };
    return { params: { ...params }, overrides: { ...patch }, exists: true };
  },
};
createRoot(document.getElementById('root')).render(<RightSidebar open sessionId="chat" modelId="model" agents={[]} sessionAgent={null} onClose={() => {}} />);
