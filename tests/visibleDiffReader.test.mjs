import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleDiffReader } from '../src/lib/visibleDiffReader.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('visible diff reads are limited to two and queued reads stop on close', async () => {
 const started = [];
 const gates = [];
 const queue = createVisibleDiffReader(path => { started.push(path); return new Promise(resolve => gates.push(resolve)); });
 const first = queue.read('a'); const second = queue.read('b'); const third = queue.read('c'); const fourth = queue.read('d');
 await tick(); assert.deepEqual(started, ['a', 'b']);
 gates[0]({text:'a'}); await first; await tick(); assert.deepEqual(started, ['a','b','c']);
 queue.close(); assert.equal(await fourth, null); assert.equal(await queue.read('e'), null);
 gates[1]({text:'b'}); gates[2]({text:'c'}); await Promise.all([second,third]);
 await tick(); assert.deepEqual(started, ['a','b','c']);
});
test('failed reads do not stall the queue', async () => {
 const queue = createVisibleDiffReader(async path => { if(path==='bad') throw Error('Cannot read'); return {text:path}; },1);
 const result = await Promise.all([queue.read('bad'),queue.read('good')]);
 assert.deepEqual(result,[{error:'Cannot read'},{text:'good'}]); queue.close();
});
