import React from 'react';
import { createRoot } from 'react-dom/client';
import ModelSettingsModal from '../../src/components/ModelSettingsModal';

window.api = {
  getModelLoadConfig: async () => {
    if (window.location.search.includes("loading")) await new Promise(resolve => setTimeout(resolve, 1800));
    if (window.location.search.includes("error")) throw new Error("Model metadata is unavailable.");
    return ({ remembered: false, config: {
    contextLength: 8192, threads: 8, evalBatch: 512, physicalBatch: 128,
    parallel: 1, gpuOffload: 'auto', flashAttention: 'auto', seed: -1,
  } }); },
  launchEngine: async () => ({ success: true }),
};
createRoot(document.getElementById('root')).render(
  <ModelSettingsModal model={{ id: 'review-model', name: 'Qwen • local model',
    architecture: 'qwen2', contextLength: 32768, layerCount: 32,
    embeddingLength: 4096, attentionHeads: 32, kvHeads: 8, size: 4900000000,
  }} onClose={() => {}} onLoaded={() => {}} />,
);
