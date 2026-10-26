'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrackedFetch } = require('../src/main/localRequestLifecycle');
const { createEngineLifecycle } = require('../src/main/engineLifecycle');
const { createIdleService } = require('../src/main/engineManager');
function fixture(fetchImpl) {
  let timer, stops = 0;
  const records = [];
  const idle = createIdleService({ onIdle: () => stops++, getIdleMinutes: () => 5, setTimer: callback => { timer = callback; return callback; }, clearTimer: () => { timer = null; } });
  const lifecycle = createEngineLifecycle({ generation: 'g1', modelPath: '/private/model.gguf', pid: 42, activeRequests: () => idle.activeRequests, emit: r => records.push(r) });
  const fetch = createTrackedFetch(fetchImpl, () => ({ beginRequest: () => idle.beginRequest(), record: lifecycle.record }));
  return { fetch, idle, lifecycle, records, tick: () => timer?.(), stops: () => stops };
}
test('low-pressure inference stays protected through body consumption and concurrent title failure', async () => {
  let source;
  const f = fixture(async url => {
    if (url === 'title') throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
    return new Response(new ReadableStream({ start(controller) { source = controller; } }));
  });
  const response = await f.fetch('chat');
  await assert.rejects(f.fetch('title'));
  f.tick(); assert.equal(f.stops(), 0); assert.equal(f.idle.activeRequests, 1);
  assert.equal(f.records.at(-1).event, 'transport-disconnected'); assert.equal(f.records.at(-1).serverTerminated, false);
  source.enqueue(new TextEncoder().encode('hello')); source.close();
  assert.equal(await response.text(), 'hello'); assert.equal(f.idle.activeRequests, 0);
  f.tick(); assert.equal(f.stops(), 1); f.idle.dispose();
});
test('ECONNREFUSED is unavailability evidence, never process-exit evidence or a retry', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  await assert.rejects(f.fetch('measure')); assert.equal(calls, 1);
  assert.equal(f.records[0].event, 'server-unavailable'); assert.equal(f.records[0].serverTerminated, false); assert.equal(f.stops(), 0);
  f.idle.dispose();
});
test('request abort and streaming socket failure release only their own leases', async () => {
  const controller = new AbortController(); let source;
  const f = fixture(async () => new Response(new ReadableStream({ start(c) { source = c; } })));
  const response = await f.fetch('compaction', { signal: controller.signal });
  const done = response.text(); controller.abort(); source.error(controller.signal.reason);
  await assert.rejects(done); assert.equal(f.idle.activeRequests, 0); assert.equal(f.stops(), 0);
  assert.equal(f.records[0].event, 'request-cancelled'); f.idle.dispose();
});
test('process diagnostics retain the first authorized stop origin and redact paths', () => {
  for (const reason of ['user-unload', 'model-switch', 'settings-reload', 'app-shutdown', 'idle-timeout']) {
    const f = fixture(async () => new Response(''));
    assert.equal(f.lifecycle.requestStop(reason, 'test', reason !== 'app-shutdown'), true);
    assert.equal(f.lifecycle.requestStop('user-unload', 'competitor', true), false);
    f.lifecycle.exited(0, 'SIGTERM');
    assert.equal(f.records.at(-1).reason, reason); assert.equal(f.records.at(-1).serverTerminated, true);
    assert.ok(!JSON.stringify(f.records).includes('/private')); f.idle.dispose();
  }
  const f = fixture(async () => new Response('')); f.lifecycle.exited(null, 'SIGKILL');
  assert.equal(f.records[0].reason, 'server-crash'); assert.equal(f.records[0].userAction, false); f.idle.dispose();
});
test('a body-level socket disconnect does not replay a provider or terminate the model', async () => {
  let source, calls = 0;
  const f = fixture(async () => { calls++; return new Response(new ReadableStream({ start(c) { source = c; } })); });
  const response = await f.fetch('child'); const text = response.text();
  source.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }));
  await assert.rejects(text); assert.equal(calls, 1); assert.equal(f.stops(), 0);
  assert.equal(f.records[0].event, 'transport-disconnected'); assert.equal(f.idle.activeRequests, 0); f.idle.dispose();
});
test('an old generation finishing cannot release the replacement generation lease', async () => {
  let oldSource, newSource;
  const old = fixture(async () => new Response(new ReadableStream({ start(c) { oldSource = c; } })));
  const next = fixture(async () => new Response(new ReadableStream({ start(c) { newSource = c; } })));
  const oldResponse = await old.fetch('old'), newResponse = await next.fetch('new');
  old.idle.dispose(); oldSource.close(); await oldResponse.text();
  next.tick(); assert.equal(next.stops(), 0); assert.equal(next.idle.activeRequests, 1);
  newSource.close(); await newResponse.text(); assert.equal(next.idle.activeRequests, 0); next.idle.dispose();
});
test('retired endpoints and stale queued generation descriptors fail before network dispatch', async () => {
  let calls = 0, unavailable = true;
  const records = [];
  const fetch = createTrackedFetch(async () => { calls++; return new Response('ok'); }, () => ({
    generation: 'new', get unavailable() { return unavailable; }, terminated: true,
    record: (...args) => records.push(args), beginRequest: () => () => {},
  }));
  await assert.rejects(fetch('old'), { code: 'LOCAL_ENGINE_UNAVAILABLE' });
  unavailable = false;
  await assert.rejects(fetch('reused-port', { engineRuntimeIdentity: 'old' }), { code: 'LOCAL_ENGINE_UNAVAILABLE' });
  assert.equal(calls, 0); assert.equal(records.length, 2);
  assert.equal(await (await fetch('current', { engineRuntimeIdentity: 'new' })).text(), 'ok'); assert.equal(calls, 1);
});
