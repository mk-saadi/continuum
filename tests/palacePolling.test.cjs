'use strict';
// Phase 2 inactive-tab polling: pure gating/equality units plus structural
// guards pinning the hook wiring. Run with: node --test tests/palacePolling.test.cjs
// Hook-lifecycle behavior (timers, races, multi-tab scaling) is covered by
// tests/palacePolling.ui.cjs with fake timers in real Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const polling = await import('../src/lib/palacePolling.mjs');

  await test('poll interval default is 2000ms', () => {
    assert.equal(polling.PALACE_POLL_INTERVAL_MS, 2000);
  });

  await test('shouldPollTick gates on active pane and visible document', () => {
    assert.equal(polling.shouldPollTick({ isActive: true, hidden: false }), true);
    assert.equal(polling.shouldPollTick({ isActive: false, hidden: false }), false);
    assert.equal(polling.shouldPollTick({ isActive: true, hidden: true }), false);
    assert.equal(polling.shouldPollTick({ isActive: false, hidden: true }), false);
    assert.equal(polling.shouldPollTick(), true, 'defaults poll (no tab state passed)');
  });

  await test('usageEqual compares usage snapshots semantically', () => {
    const base = { totalTokens: 100, messageCount: 2, hasSummary: false, telemetry: null };
    assert.equal(polling.usageEqual(null, null), true);
    assert.equal(polling.usageEqual(null, base), false);
    assert.equal(polling.usageEqual(base, null), false);
    assert.equal(polling.usageEqual(base, { ...base }), true, 'fresh-but-identical object does not churn');
    assert.equal(polling.usageEqual(base, { ...base, totalTokens: 101 }), false);
    assert.equal(polling.usageEqual(base, { ...base, messageCount: 3 }), false);
    assert.equal(polling.usageEqual(base, { ...base, hasSummary: true }), false);
    const tele = { lastPromptTokens: 50, peakPromptTokens: 60, peakRequestIndex: 1, promptRequests: 1, promptCoverage: 'complete', completionTokens: 5, totalTokens: 55, scope: 'all' };
    assert.equal(polling.usageEqual({ ...base, telemetry: tele }, { ...base, telemetry: { ...tele } }), true);
    assert.equal(polling.usageEqual({ ...base, telemetry: tele }, { ...base, telemetry: { ...tele, lastPromptTokens: 51 } }), false);
    assert.equal(polling.usageEqual({ ...base, telemetry: tele }, { ...base, telemetry: null }), false);
    assert.equal(polling.usageEqual(base, { ...base, telemetry: tele }), false);
  });

  // Structural pins: the wiring the UI suite verifies behaviorally.
  const palace = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MemoryPalace.jsx'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');

  await test('polling effect is gated on isActive with cleanup', () => {
    assert.ok(palace.includes('isActive = true'), 'isActive defaults to polling (existing callers unaffected)');
    assert.ok(palace.includes('!isActive) return'), 'inactive panes start no refresh and no timer');
    assert.ok(palace.includes('shouldPollTick'), 'ticks re-check the gate (hidden document)');
    assert.ok(palace.includes('clearInterval(interval)'), 'timer cleanup preserved');
    assert.ok(palace.includes('usageEqual(previous, next)'), 'identical polls keep previous state identity');
    assert.ok(!palace.includes('setInterval(refresh, 2000)'), 'ungated hardcoded interval removed');
  });

  await test('canonical tab state feeds the gate; agent paths untouched', () => {
    assert.ok(app.includes('isActive: active'), 'TabPane passes its canonical active flag, no new registry');
    assert.ok(app.includes('active={tab.id === activeTabId}'), 'active still derives from the tab store');
    // The gate must not reach execution, persistence, or subscriptions: every
    // event-driven and agent path in the hook stays ungated.
    for (const token of ['prepareChatMessages', 'saveMessage', 'useCompressionEvents', 'onChanged', 'scheduleIdleCompression', 'measureContext']) {
      assert.ok(palace.includes(token), `${token} path retained`);
    }
    const chat = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'main-app', 'ChatInterface.jsx'), 'utf8');
    const tabActiveUses = (chat.match(/tabActive/g) || []).length;
    assert.equal(tabActiveUses, 3, `tabActive stays confined to composer focus (default, guard, deps), found ${tabActiveUses}`);
  });

  console.log('Palace polling: gating, equality, and wiring pins passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
