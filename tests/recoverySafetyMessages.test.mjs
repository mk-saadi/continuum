import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, safetyVerdictInfo, restoreOutcomeMessage } from '../src/lib/recoverySafety.mjs';

test('safe or missing reports need no explanation', () => {
  assert.equal(safetyVerdictInfo(undefined), null);
  assert.equal(safetyVerdictInfo({ verdict: 'safe', anomalies: [] }), null);
});

test('authorization-required names paths, sizes, and the separate force decision', () => {
  const info = safetyVerdictInfo({ verdict: 'authorization-required', filesWouldEmpty: 2, bytesWouldDestroy: 100,
    anomalies: [{ type: 'empty-over-nonempty', paths: [{ path: 'a.txt', currentSize: 90 }, { path: 'b.txt', currentSize: 10 }] }] });
  assert.equal(info.verdict, 'authorization-required');
  assert.equal(info.needsForce, false);
  assert.match(info.title, /confirmation/);
  assert.ok(info.lines.some((line) => line.includes('a.txt') && line.includes('90 B')));
  assert.match(info.explanation, /separate decision/);
  assert.match(info.footer, /only a preview/);
});

test('refused verdicts explain the damage shape and demand both confirmations', () => {
  const info = safetyVerdictInfo({ verdict: 'refused', filesWouldEmpty: 4, bytesWouldDestroy: 40,
    anomalies: [{ type: 'degenerate-checkpoint', paths: ['x.txt'] }] });
  assert.equal(info.needsForce, true);
  assert.match(info.title, /refused/i);
  assert.match(info.explanation, /AND allow overwriting/);
  assert.match(info.footer, /No files were changed/);
});

test('restore outcomes distinguish success, refusal, and partial with undo info', () => {
  const ok = restoreOutcomeMessage({ strategy: 'per-path', complete: true,
    restored: [{ path: 'a.txt', action: 'restored' }, { path: 'b.txt', action: 'unchanged' }],
    removed: [], skipped: [], preRestoreCheckpointId: 12, undoPinned: true });
  assert.equal(ok.kind, 'success');
  assert.match(ok.text, /Restored 1 path/);
  assert.match(ok.text, /Undo point #12 \(pinned against cleanup\)/);
  const refused = restoreOutcomeMessage({ strategy: 'refused', complete: false, restored: [], removed: [], skipped: [],
    safety: { verdict: 'refused', filesWouldEmpty: 1, bytesWouldDestroy: 9, anomalies: [] } });
  assert.equal(refused.kind, 'refused');
  assert.match(refused.text, /No files were changed/);
  const partial = restoreOutcomeMessage({ strategy: 'per-path', complete: false,
    restored: [{ path: 'a.txt', action: 'restored' }], removed: [], skipped: [{ path: 'b.txt', reason: 'conflict' }],
    preRestoreCheckpointId: 7 });
  assert.equal(partial.kind, 'partial');
  assert.match(partial.text, /1 skipped/);
  assert.match(partial.text, /Undo point #7/);
  assert.ok(!partial.text.includes('pinned'));
});

test('byte counts stay readable', () => {
  assert.equal(formatBytes(0), 'empty');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
});
