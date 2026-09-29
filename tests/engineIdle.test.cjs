const assert = require('node:assert/strict');
const { createIdleService, buildLlamaServerArgs } = require('../src/main/engineManager');
const { normalizeLoadConfig } = require('../src/main/configManager');
let timer, unloaded = 0, globalMinutes = -1;
const service = createIdleService({
  onIdle: () => unloaded++,
  getIdleMinutes: () => globalMinutes,
  setTimer(callback, delay) { timer = { callback, delay }; return timer; },
  clearTimer() { timer = null; },
});
service.resetIdleTimer(-1);
assert.equal(timer, null);
service.resetIdleTimer(5);
assert.equal(timer.delay, 300000);
const firstTimer = timer;
globalMinutes = 15;
service.resetIdleTimer();
assert.notEqual(timer, firstTimer);
assert.equal(timer.delay, 900000);
const endFirst = service.beginRequest();
const endSecond = service.beginRequest();
assert.equal(timer, null);
endFirst();
assert.equal(timer, null);
endSecond();
assert.equal(timer.delay, 900000);
timer.callback();
assert.equal(unloaded, 1);
service.resetIdleTimer(60);
assert.equal(timer.delay, 3600000);
service.dispose();
endSecond();
service.resetIdleTimer(5);
assert.equal(timer, null);
for (const [key, value] of Object.entries({ kvCacheQuantization: 'q2', chatTemplate: 'invalid', reasoningFormat: 'invalid', cacheTypeK: 'q2', cacheTypeV: 'q2', mlock: 'true' }))
  assert.throws(() => normalizeLoadConfig({ [key]: value }), /Invalid/);
for (const precision of ['f16', 'q8_0', 'q4_0']) {
  const args = buildLlamaServerArgs({modelPath: 'test.gguf'}, {kvCacheQuantization: precision, chatTemplate: 'deepseek', reasoningFormat: 'deepseek'}, 8080);
  for (const flag of ['--cache-type-k', '--cache-type-v']) assert.equal(args[args.indexOf(flag) + 1], precision);
  assert.equal(args[args.indexOf('--chat-template') + 1], 'deepseek');
  assert.equal(args[args.indexOf('--reasoning-format') + 1], 'deepseek');
}
assert.equal(buildLlamaServerArgs({modelPath: 'test.gguf'}, {}, 8080).includes('--chat-template'), false);
console.log('Idle reset, active requests, disposal, validation, and spawn flags passed.');

const split = buildLlamaServerArgs({ modelPath: 'test.gguf' }, { cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', mlock: true }, 8080);
assert.equal(split[split.indexOf('--cache-type-k') + 1], 'q8_0');
assert.equal(split[split.indexOf('--cache-type-v') + 1], 'q4_0');
assert.ok(split.includes('--mlock'));
assert.equal(split.includes('-lm'), false);
assert.equal(Object.hasOwn(normalizeLoadConfig({ keepAliveMinutes: 5 }), 'keepAliveMinutes'), false);
