// Shared esbuild stub plugin for the render-isolation fixtures.
//
// Renders the REAL App shell while the heavy leaves are replaced with tiny
// components that record render counts, so propagation can be observed without
// depending on their internals. Header and TabBar stay real. Used by both
// tests/renderIsolation.ui.cjs (Phase 4) and tests/tabSwitchIsolation.ui.cjs
// (Phase 6) so the two suites measure the same harness.
const path = require('node:path');

module.exports = {
  name: 'render-isolation-stubs',
  setup(build) {
    build.onResolve(
      { filter: /(ChatInterface\.jsx|Titlebar\.jsx|MemorySettings\.jsx|MemoryPalace\.jsx|ModelSelectorModal\.jsx|ProjectModal\.jsx|ProjectsView\.jsx|ProjectWorkspace\.jsx|useAvatarSettings|useBackgroundSettings)$/ },
      (args) => ({ path: args.path, namespace: 'phase4-stub' }),
    );
    build.onLoad({ filter: /.*/, namespace: 'phase4-stub' }, (args) => {
      const p = args.path;
      let contents;
      if (p.includes('ChatInterface')) {
        contents = `
          import React from 'react';
          export function ChatInterface({ palace }) {
            window.chatRenderLog.push(palace.sessionId);
            return null;
          }`;
      } else if (p.includes('Titlebar')) {
        contents = `
          import React from 'react';
          export function Titlebar() { window.titlebarRenders += 1; return null; }`;
      } else if (p.includes('MemorySettings')) {
        contents = `
          import React from 'react';
          export default function MemorySettings({ onClose, onChangeTheme }) {
            window.memorySettingsRenders += 1;
            return React.createElement('div', { 'data-testid': 'memory-settings' },
              React.createElement('button', { 'data-testid': 'change-theme', onClick: () => onChangeTheme && onChangeTheme('light') }),
              React.createElement('button', { 'data-testid': 'close-settings', onClick: () => onClose && onClose() }));
          }`;
      } else if (p.includes('MemoryPalace')) {
        contents = `
          export const useMemoryPalace = (modelId, config, initialSessionId) => ({
            sessionId: initialSessionId,
            limit: null, totalTokens: null, pluginTokens: 0, toolTokens: 0,
            error: null, toast: null, contextTokens: undefined,
            contextMethod: undefined, contextConfidence: undefined,
            liveTelemetry: null, turnTelemetry: null,
          });`;
      } else if (p.includes('ModelSelectorModal')) {
        contents = `
          import React from 'react';
          export default function ModelSelectorModal({ onClose }) {
            window.modelSelectorRenders += 1;
            return React.createElement('div', { 'data-testid': 'model-selector' },
              React.createElement('button', { 'data-testid': 'close-model-selector', onClick: () => onClose && onClose() }));
          }`;
      } else if (p.includes('useAvatarSettings')) {
        contents = `
          import React from 'react';
          export default function useAvatarSettings() {
            const ref = React.useRef(null);
            if (!ref.current) ref.current = { settings: { showAvatars: false }, update: () => {}, error: '' };
            return ref.current;
          }`;
      } else if (p.includes('useBackgroundSettings')) {
        contents = `export default function useBackgroundSettings() { return null; }`;
      } else {
        // ProjectModal / ProjectsView / ProjectWorkspace
        contents = `export default function Stub() { return null; }`;
      }
      return { contents, loader: 'jsx', resolveDir: path.join(__dirname, '..', '..') };
    });
  },
};
