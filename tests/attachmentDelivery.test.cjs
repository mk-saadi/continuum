// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/attachmentDelivery.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sharp = require('sharp');
const { spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-delivery-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => path.join(directory, 'profile') } };
  return load.call(this, name, ...args);
};
const database = require('../src/main/db');
database.initDatabase();
const sessions = require('../src/main/sessionManager');
const uploads = require('../src/main/fileUploads');
const reader = require('../src/main/attachmentReader');
const { prepareChatMessages } = require('../src/main/promptBuilder');
const { createMediaGuardedFetch } = require('../src/main/modelCapabilities');
const clouds = require('../src/main/cloudProviders');
const { inspectImage, prepareImageMessages } = require('../src/main/imageAttachments');
let fixtures;
test.before(async () => { fixtures = await require('./fixtures/attachmentImages.cjs').attachmentImages(); });
test.after(() => { database.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
const response = () => Response.json({ choices: [{ message: { content: 'Fixture transport complete.' }, finish_reason: 'stop' }] });
function imageBytes(part) { return Buffer.from(part.image_url.url.split(',')[1], 'base64'); }
async function chat(messages, fetchImpl, cloud = false) {
  if (messages[0]?.role !== 'system') messages = [{role:'system',content:'Fixture system'}, ...messages];
  return (await import('../src/lib/memoryChat.mjs')).runMemoryChat({ baseUrl: 'http://127.0.0.1:8999', modelId: 'fixture', messages, fetchImpl, cloud });
}

test('original storage, reopening, ownership, legacy JPEG and local outgoing image dimensions', async () => {
  for (const fixture of fixtures) {
    const file = path.join(directory, fixture.name); fs.writeFileSync(file, fixture.bytes);
    // Exercise both direct source paths and pathless clipboard byte envelopes.
    for (const input of [file, { name: fixture.name, dataUrl: `data:${fixture.mime};base64,${fixture.bytes.toString('base64')}` }]) {
      const attachments = await uploads.processUploads([input]);
      assert.deepEqual(fs.readFileSync(attachments[0].file_path), fixture.bytes);
      const stored = await sharp(attachments[0].file_path).metadata();
      assert.deepEqual([stored.width, stored.height], [fixture.width, fixture.height]);
      const sessionId = 'image-' + path.basename(attachments[0].file_path);
      const messages = prepareChatMessages({ sessionId, modelId: 'fixture', userText: 'Inspect fixture', attachments });
      let outgoing;
      const local = createMediaGuardedFetch(async (url, options) => {
        if (url.endsWith('/props')) return Response.json({ modalities: { vision: true } });
        outgoing = JSON.parse(options.body); return response();
      });
      await chat(messages, local);
      const part = outgoing.messages.at(-1).content.find(part => part.type === 'image_url');
      const sent = await sharp(imageBytes(part)).metadata();
      assert.deepEqual([sent.width, sent.height], [fixture.displayWidth || fixture.width, fixture.displayHeight || fixture.height]);
      if (fixture.name === 'oriented.jpg' || fixture.mime === 'image/webp') {
        assert.match(part.image_url.url, /^data:image\/png;/);
        assert.match(JSON.stringify(outgoing.messages), /Image delivery:.*original retained/);
      } else assert.deepEqual(imageBytes(part), fixture.bytes);
      if (fixture.name === 'transparent.png' || fixture.mime === 'image/webp') {
        assert.equal(sent.hasAlpha, true);
        const pixels = await sharp(imageBytes(part)).raw().toBuffer();
        assert.equal(pixels[3], 64);
      }
      const row = sessions.loadSession(sessionId).messages[0].attachments[0];
      const ref = reader.reference(row);
      sessions.getOrCreateSession('other', 'fixture');
      assert.throws(() => reader.resolve(ref, 'other'), /not attached to this conversation/);
      database.closeDatabase(); database.initDatabase();
      assert.equal(sessions.loadSession(sessionId).messages[0].attachments[0].file_path, row.file_path);
      assert.equal(reader.resolve(ref, sessionId).file_path, row.file_path);
      assert.deepEqual(fs.readFileSync(row.file_path), fixture.bytes);
    }
  }
});

test('production builder, sanitizer and cloud adapter deliver original images and structured mixed audio/video', async () => {
  const wav = path.join(directory, 'tone.wav'), video = path.join(directory, 'clip.mp4');
  for (const args of [
    ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', wav],
    ['-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.1', '-c:v', 'mpeg4', video],
  ]) {
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
  const dense = fixtures[0];
  const images = await uploads.processUploads([{ name: dense.name, dataUrl: `data:${dense.mime};base64,${dense.bytes.toString('base64')}` }]);
  const media = await uploads.processUploads([wav, video]);
  clouds.saveCloudProvider({ id: 'fixture-router', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-key' });
  const target = { type: 'cloud', provider: 'fixture-router', model: 'fixture-media' };
  let capabilities = { image: true, audio: true, video: true }, sent = 0, body;
  const adapter = clouds.createCloudFetch(target, { getMetadata: async () => [{ providerId: target.provider, modelId: target.model, providerName: 'OpenRouter', capabilities }],
    fetchImpl: async (_url, options) => { sent++; body = JSON.parse(options.body); return response(); } });
  for (const attachments of [[images[0]], [media[0]], [media[1]], [...images, ...media]]) {
    const messages = prepareChatMessages({ sessionId: 'mixed-' + sent, modelId: 'fixture', userText: 'Inspect fixtures', attachments });
    await chat(messages, adapter, true);
    const content = body.messages.at(-1).content;
    assert.ok(Array.isArray(content));
    assert.ok(content.filter(part => part.type === 'text').every(part => !/base64,/.test(part.text)));
    for (const attachment of attachments) {
      const expected = fs.readFileSync(attachment.file_path);
      if (attachment.mime_type.startsWith('image/')) assert.deepEqual(imageBytes(content.find(part => part.type === 'image_url')), expected);
      if (attachment.mime_type.startsWith('audio/')) assert.deepEqual(Buffer.from(content.find(part => part.type === 'input_audio').input_audio.data, 'base64'), expected);
      if (attachment.mime_type.startsWith('video/')) {
        const part = content.find(part => part.type === 'video_url');
        assert.match(part.video_url.url, /^data:video\/mp4;base64,/);
        assert.deepEqual(Buffer.from(part.video_url.url.split(',')[1], 'base64'), expected);
      }
    }
    // Local uses input_video, not the cloud video_url envelope.
    let localBody;
    await chat(messages, createMediaGuardedFetch(async (url, options) => {
      if (url.endsWith('/props')) return Response.json({ modalities: { vision: true, audio: true, video: true } });
      localBody = JSON.parse(options.body); return response();
    }));
    assert.ok(Array.isArray(localBody.messages.at(-1).content));
    if (attachments.includes(media[1])) assert.deepEqual(Buffer.from(localBody.messages.at(-1).content.find(part => part.type === 'input_video').input_video.data, 'base64'), fs.readFileSync(video));
  }
  const messages = prepareChatMessages({ sessionId: 'unsupported', modelId: 'fixture', userText: 'Inspect', attachments: [...images, ...media] });
  const before = sent;
  capabilities = { image: true, audio: false, video: true };
  await assert.rejects(chat(messages, adapter, true), /does not support audio/);
  assert.equal(sent, before);
  await assert.rejects(chat(messages, createMediaGuardedFetch(async url => {
    assert.ok(url.endsWith('/props'), 'unsupported media must never POST');
    return Response.json({ modalities: { vision: true, audio: true, video: false } });
  })), /does not support video/);
  const rejected = clouds.createCloudFetch(target, { getMetadata: async () => [{ providerId: target.provider, modelId: target.model, providerName: 'OpenRouter', capabilities: { image: true, audio: true, video: true } }],
    fetchImpl: async () => new Response('fixture backend rejects mixed media', { status: 422 }) });
  await assert.rejects(chat(messages, rejected, true), /provider rejected the structured attachment request.*mixed-media support/);
});

test('MIME mismatches, unsupported images, corrupt pixels and animation fail without replacing originals', async () => {
  const png = fixtures[1];
  await assert.rejects(uploads.processUploads([{ name: 'wrong.jpg', dataUrl: `data:image/jpeg;base64,${png.bytes.toString('base64')}` }]), /does not match/);
  await assert.rejects(inspectImage(Buffer.from('not pixels'), 'image/png'), /could not be safely decoded/);
  await assert.rejects(inspectImage(png.bytes, 'image/gif'), /format is unsupported/);
  const frame1 = path.join(directory, 'frame01.png'), frame2 = path.join(directory, 'frame02.png');
  fs.writeFileSync(frame1, png.bytes); fs.writeFileSync(frame2, await sharp(png.bytes).negate().png().toBuffer());
  const animation = path.join(directory, 'animated.png');
  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', path.join(directory, 'frame%02d.png'), '-plays', '0', '-f', 'apng', animation], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const before = fs.readFileSync(animation);
  await assert.rejects(uploads.processUploads([animation]), /Animated images are unsupported/);
  assert.deepEqual(fs.readFileSync(animation), before);
  const parts = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${before.toString('base64')}` } }] }];
  await assert.rejects(prepareImageMessages(parts), /Animated images are unsupported/);
  const gif = path.join(directory, 'animated.gif');
  const gifRun = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', path.join(directory, 'frame%02d.png'), gif], { encoding: 'utf8' });
  assert.equal(gifRun.status, 0, gifRun.stderr);
  const webp = await sharp(gif, { animated: true }).webp({ lossless: true }).toBuffer();
  assert.ok((await sharp(webp, { animated: true }).metadata()).pages > 1);
  await assert.rejects(inspectImage(webp, 'image/webp'), /Animated images are unsupported/);
});

test('Anthropic receives original base64 image blocks and rejects audio/video before sending', async () => {
  clouds.saveCloudProvider({ id: 'fixture-anthropic', name: 'Anthropic', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-key' });
  const target = { type: 'cloud', provider: 'fixture-anthropic', model: 'fixture-vision' };
  let body, calls = 0;
  const adapter = clouds.createCloudFetch(target, { getMetadata: async () => [{ providerId: target.provider, modelId: target.model, capabilities: { image: true, audio: true, video: true } }],
    fetchImpl: async (_url, options) => { calls++; body = JSON.parse(options.body); return Response.json({ content: [{ type: 'text', text: 'Fixture complete' }], stop_reason: 'end_turn' }); } });
  const fixture = fixtures[0];
  const attachments = await uploads.processUploads([{ name: fixture.name, dataUrl: `data:${fixture.mime};base64,${fixture.bytes.toString('base64')}` }]);
  const messages = prepareChatMessages({ sessionId: 'anthropic', modelId: 'fixture', userText: 'Inspect', attachments });
  await chat(messages, adapter, true);
  const block = body.messages.at(-1).content.find(part => part.type === 'image');
  assert.equal(block.source.media_type, fixture.mime);
  assert.deepEqual(Buffer.from(block.source.data, 'base64'), fixture.bytes);
  await assert.rejects(chat([{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }], adapter, true), /does not support audio/);
  assert.equal(calls, 1);
});
