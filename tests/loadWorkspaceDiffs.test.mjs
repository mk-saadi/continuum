import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkspaceDiffs } from '../src/lib/loadWorkspaceDiffs.mjs';

test('first three previews load together, remaining previews load sequentially without scrolling', async () => {
  const gates = [];
  const started = [];
  const published = [];
  const files = Array.from({ length:6 }, (_, i) => ({ path:String(i) }));
  const run = loadWorkspaceDiffs(files, {
    read: path => { started.push(path); return new Promise(resolve => gates.push(resolve)); },
    publish: path => published.push(path), cancelled: () => false, yieldTask: async () => {},
  });
  assert.deepEqual(started, ['0','1','2']);
  gates[0]({}); gates[1]({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 3);
  gates[2]({});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['0','1','2','3']);
  for (let i=3;i<6;i++) {
    gates[i]({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.length, Math.min(i+2,6));
  }
  await run;
  assert.equal(published.length, 6);
});

test('closing view stops queued work and suppresses late publications', async () => {
  let stopped = false;
  let reads = 0;
  let publications = 0;
  await loadWorkspaceDiffs(Array.from({length:8}, (_, i) => ({path:String(i)})), {
    read: async () => { reads++; stopped = true; return {}; },
    publish: () => publications++, cancelled: () => stopped, yieldTask: async () => {},
  });
  assert.equal(reads,1);
  assert.equal(publications,0);
});
