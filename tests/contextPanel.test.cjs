'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const panel = fs.readFileSync(require.resolve('../src/components/ContextPanel.jsx'), 'utf8');
const sidebar = fs.readFileSync(require.resolve('../src/components/RightSidebar.jsx'), 'utf8');
const handlers = fs.readFileSync(require.resolve('../src/main/ipcHandlers.js'), 'utf8');
test('context panel shows one summary and clear status with current capacity and occupancy', () => {
  assert.match(panel, /Compaction summary/); assert.match(panel, /Current context:/); assert.match(panel, /capacityTokens/);
  for (const text of ['Original task brief','Rolling summary','Archived messages','Current checkpoint','Checkpoint history']) assert.ok(!panel.includes(text));
  for (const status of ['compacting','completed','deferred','failed']) assert.ok(panel.includes(status));
  assert.match(panel, /Original messages and tool results remain in chat history/);
});
test('summary comes from the migrated state through trusted IPC and is escaped', () => {
  assert.match(handlers, /"session:get-summary":.*getSummaryForDisplay/);
  assert.match(panel, /api.getSessionSummary\(sessionId\)/);
  assert.ok(!panel.includes('dangerouslySetInnerHTML')); assert.ok(!panel.includes('getCheckpoint'));
});
test('both workspace and casual expose context inspection', () => {
  const casual = sidebar.slice(sidebar.indexOf('const CASUAL_SECTIONS'), sidebar.indexOf('const WORKSPACE_SECTIONS'));
  assert.match(casual, /id: "context"/);
  assert.equal((sidebar.match(/<ContextPanel/g) ?? []).length, 1);
});
