'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const sidebar = read('src/components/RightSidebar.jsx');
const panel = read('src/components/ContextPanel.jsx');
const app = read('src/App.jsx');
const preload = read('src/preload.js');
const palace = read('src/components/MemoryPalace.jsx');
const engine = read('src/main/compressionEngine.js');
const handlers = read('src/main/ipcHandlers.js');
const inspection = read('src/main/contextInspection.js');

// 1. Workspace-only Context tab wiring; Casual Chat untouched.
assert.ok(
  sidebar.includes('{ id: "context", label: "Context"'),
  'workspace sections gain a Context tab',
);
assert.ok(sidebar.includes('LuHistory'), 'Context tab has an icon');
assert.ok(sidebar.includes('id="controls-context"'), 'context panel mounted with a stable id');
assert.ok(
   /<ContextPanel\s+measurement=\{contextMeasurement\}\s+sessionId=\{sessionId\}\s+modelId=\{modelId\}\s+active=\{tab === "context"\}\s*\/>/.test(sidebar),
  'context panel receives the session and visibility for refresh',
);
assert.ok(
  sidebar.includes('import ContextPanel from "./ContextPanel"'),
  'panel imported as a separate component, not inlined',
);
const casualBlock = sidebar.slice(sidebar.indexOf('const CASUAL_SECTIONS'), sidebar.indexOf('];', sidebar.indexOf('const CASUAL_SECTIONS')) + 3);
assert.ok(!casualBlock.includes('context'), 'casual tab set has no Context tab');
assert.ok(!casualBlock.includes('Context'), 'casual labels unchanged');
for (const label of ['Persona', 'Generation', 'Memory', 'Activity', 'Agents', 'Controls']) {
  assert.ok(sidebar.includes(`label: "${label}"`), `existing tab label "${label}" preserved`);
}

// 2. Panel covers every required inspection area with explicit states.
for (const heading of ['Compression status', 'Current checkpoint', 'Checkpoint history', 'Original task brief', 'Rolling summary', 'Archived messages']) {
  assert.ok(panel.includes(heading), `panel renders "${heading}"`);
}
for (const marker of ['Verified', 'Unverified', '(record unavailable)', 'Loading', 'Refresh', 'Older', 'Newer']) {
  assert.ok(panel.includes(marker), `panel uses "${marker}"`);
}
assert.ok(panel.includes('Generated historical summary'), 'summary labeled as generated, not canonical');
assert.ok(panel.includes('not applicable to this branch'), 'off-branch briefs labeled, not hidden silently');
assert.ok(panel.includes('Stored records, shown as saved'), 'archived originals labeled as stored records');
assert.ok(panel.includes('Superseded versions describe past history'), 'superseded versions explained, not rewritten');
assert.ok(!panel.includes('dangerouslySetInnerHTML'), 'checkpoint text and tool output render as escaped text');
assert.ok(!panel.match(/token.?saved|saved.*tokens?/i), 'no fabricated token-savings claims');
assert.ok(panel.includes('useCompressionEvents'), 'panel refreshes on compression completion');
assert.ok(
  panel.includes('result.error ?? result.reason'),
  'panel surfaces failure reasons',
);
const compressionEvents = read('src/context/CompressionEventsContext.jsx');
assert.ok(
  compressionEvents.includes('onCompressionComplete') && app.includes('<CompressionEventsProvider>'),
  'one provider owns the compression subscription instead of one listener per pane',
);
assert.ok(panel.includes('role="alert"'), 'errors use role=alert');
assert.ok(panel.includes('role="status"'), 'loading and status use role=status');

// 3. Preload exposes exactly the four read-only inspection APIs.
for (const method of ['getCheckpoint:', 'getCheckpointHistory:', 'getBriefs:', 'getArchivedMessages:']) {
  assert.ok(preload.includes(method), `preload exposes memoryPalace.${method.replace(':', '')}`);
}
assert.ok(
  preload.includes("ipcRenderer.invoke('session:get-checkpoint'"),
  'checkpoint fetch uses the guarded invoke channel',
);

// 4. Existing notification paths tolerate the new failure payloads.
assert.ok(
  palace.includes('if (!result.compressed) return;'),
  'casual toast skips non-compressed results instead of printing undefined counts',
);
assert.ok(
  engine.includes('onComplete({ sessionId, compressed: false, error:'),
  'idle failures notify through the existing completion channel',
);
assert.ok(
  engine.includes('else if (result.reason) onComplete({ sessionId, ...result })'),
  'idle refusals with reasons notify; silent no-ops stay silent',
);
assert.ok(
  handlers.includes("sender.send('session:compression-complete',\n                                    { sessionId, compressed: false, error:"),
  'forced failures notify before the chat error propagates',
);

// 5. Inspection module stays read-only and bounded.
assert.ok(!inspection.match(/INSERT INTO|UPDATE |DELETE FROM/), 'inspection module issues no writes');
assert.ok(inspection.includes('MAX_ARCHIVED_LIMIT'), 'archived pages bounded');
assert.ok(inspection.includes('MAX_HISTORY_LIMIT'), 'checkpoint history bounded');
assert.ok(inspection.includes('MAX_STEP_RESULT_CHARS'), 'tool output truncated with flags');
assert.ok(inspection.includes('{ found: false }'), 'unresolvable evidence is explicit, never invented');
assert.ok(inspection.includes('findSessionForDisplay(sessionId)') && inspection.includes('{ found: false }'), 'unknown sessions return the read-only not-found state');

console.log('Context panel wiring: workspace-only tab, six inspection areas, preload APIs, failure notifications, and read-only bounded inspection passed.');
