const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCapabilities, queryCapabilities, requiredModalities, assertCapabilities } = require('../src/main/modelCapabilities');
test('runtime values remain unknown when absent; input modes stay independent', () => {
  assert.deepEqual(normalizeCapabilities({}).image, null);
  const capabilities = normalizeCapabilities({ modalities: { vision: true, audio: false }, default_generation_settings: { n_ctx: 4096 }, build_info: 'test-build' });
  assert.equal(capabilities.image, true);
  assert.equal(capabilities.audio, false);
  assert.equal(capabilities.video, null);
  assert.equal(capabilities.contextLength, 4096);
  assertCapabilities(capabilities, ['image']);
  assert.throws(() => assertCapabilities(capabilities, ['audio']), /does not support/);
  assert.throws(() => assertCapabilities(capabilities, ['video']), /has not been verified/);
});
test('media in history and tool results is checked without affecting plain text', () => {
  assert.deepEqual(requiredModalities([{ content: 'hello' }]), []);
  assert.deepEqual(requiredModalities([{ role: 'tool', content: [{ type: 'image_url' }, { type: 'input_audio' }, { type: 'video_url' }] }]), ['image', 'audio', 'video']);
});
test('properties are requested from the local engine and errors do not imply support', async () => {
  let requested;
  const result = await queryCapabilities(8080, async (url, options) => {
    requested = url;
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ modalities: { vision: true, audio: true, video: false } }) };
  });
  assert.equal(requested, 'http://127.0.0.1:8080/props');
  assert.equal(result.audio, true);
  await assert.rejects(queryCapabilities(8080, async () => ({ ok: false, status: 404 })), /Cannot verify/);
  await assert.rejects(queryCapabilities(0), /Invalid engine port/);
});

test('local requests verify image capabilities each time and block before inference', async () => {
  const { createMediaGuardedFetch } = require('../src/main/modelCapabilities');
  const calls = [];
  let vision = false;
  const guarded = createMediaGuardedFetch(async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ modalities: { vision } }) };
  });
  const url = 'http://127.0.0.1:8080/v1/chat/completions';
  const media = { body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }) };
  await assert.rejects(guarded(url, media), /does not support image/);
  assert.equal(calls.length, 1);
  vision = true;
  await guarded(url, media);
  assert.deepEqual(calls.slice(-2), ['http://127.0.0.1:8080/props', url]);
  const before = calls.length;
  await guarded(url, { body: JSON.stringify({ messages: [{ content: 'hello' }] }) });
  assert.equal(calls.length, before + 1);
  vision = false;
  await assert.rejects(guarded(url, media), /does not support image/);
});
