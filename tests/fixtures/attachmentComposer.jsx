import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface.jsx';
import { prepareComposerFiles } from '../../src/utils/composerAttachments.mjs';
import { attachmentPolicy } from '../../src/lib/attachmentPolicy.mjs';

window.uploads = [];
window.api = {
  stageAttachments: async files => { const originals=await prepareComposerFiles(files); window.uploads.push(...originals); return originals; },
  getAttachmentPolicy: async () => attachmentPolicy({ image: true, audio: true, video: true }, { local: true }),
  getEffectiveSettings: async () => ({ effective: {}, overrides: {} }),
  getSessionAgent: async () => null,
  processUploads: async files => { window.uploads.push(...files); return files.map(file => ({ file_path: '/fixture/' + file.name, mime_type: file.type })); },
};
const api = {
  getAllSessions: async () => [],
  loadSession: async () => ({ messages: [], title: 'Fixture', project_id: null }),
  getOrCreateSession: async () => ({}),
};
const palace = {
  api, sessionId: 'fixture', setSessionId() {}, enabled: false, refresh: async () => {}, schedule() {},
  setDraftTokens() {}, prepareMessages: async (_text, _retry, attachments) => { window.submitted = attachments; throw new Error('Fixture stopped after attachment preparation.'); },
};
window.addEventListener('error', event => { window.fixtureError = String(event.error?.stack || event.message); });
createRoot(document.getElementById('root')).render(<ChatInterface palace={palace} selectedModel="fixture-model"
  models={[{ id: 'fixture-model', name: 'Fixture' }]} baseUrl="http://fixture.invalid" engineRunning={true}
  isSidebarOpen={false} isRightSidebarOpen={false} tabActive={true} />);
