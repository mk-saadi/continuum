import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeChatMessages, runMemoryChat } from '../src/lib/memoryChat.mjs';
import { redactToolMedia } from '../src/lib/toolResultFormatter.mjs';
import { PNG_BASE64 } from './fixtures/visionImages.mjs';
const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } };
const audio = { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } };
const video = { type: 'input_video', input_video: { data: 'AAAAAGZ0eXBpc29t', format: 'video/mp4' } };
for (const parts of [[image], [audio], [video], [image, audio, video]]) {
  test(`preserves structured ${parts.map(part => part.type).join('/')} in the actual chat request`, async () => {
    let requests = 0;
    await runMemoryChat({ baseUrl: 'http://fixture.invalid', modelId: 'fixture',
      messages: [{ role: 'system', content: 'Fixture system.' }, { role: 'user', content: [{ type: 'text', text: 'Inspect fixture.' }, ...parts] }],
      fetchImpl: async (_url, options) => {
        requests++;
        assert.deepEqual(JSON.parse(options.body).messages.at(-1).content, [{ type: 'text', text: 'Inspect fixture.' }, ...parts]);
        return Response.json({ choices: [{ message: { content: 'Transport fixture complete.' }, finish_reason: 'stop' }] });
      } });
    assert.equal(requests, 1);
  });
}
test('malformed, unknown, nested and already-stringified media never fall back to text', () => {
  for (const content of [[{ ...audio, input_audio: { data: '@@@@', format: 'wav' } }],
    [{ ...audio, input_audio: { data: 'AAAA', format: 'ogg' } }],
    [{ ...video, input_video: { data: 'AAAA', format: 'video/unknown' } }],
    [image, { type: 'unsupported', data: 'PRIVATE_BYTES' }],
    audio, { nested: [audio] }, { mimeType: 'audio/wav', data: 'PRIVATE_BYTES' }, JSON.stringify([audio, video]),
    [{ type: 'text', text: 'data:audio/wav;base64,AAAA' }]]) {
    assert.throws(() => sanitizeChatMessages([{ role: 'user', content }]), /Cannot prepare attachment input/);
  }
  const calls = [{ role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'audio_tool', arguments: '{}' } }] }];
  assert.throws(() => sanitizeChatMessages([...calls, { role: 'tool', tool_call_id: 'a', content: { type: 'audio', mimeType: 'audio/wav', data: 'PRIVATE_BYTES' } }]), /Audio\/video tool results/);
  assert.throws(() => sanitizeChatMessages([{ role: 'system', content: [audio] }]), /unsupported for role system/);
});
test('diagnostics do not expose structured audio/video bytes', () => {
  const request = { messages: [{ role: 'system', content: 'Fixture system.' }, { role: 'user', content: [audio, video, image] }] };
  for (const value of [request, JSON.stringify(request)]) {
    const safe = JSON.stringify(redactToolMedia(value));
    for (const data of [audio.input_audio.data, video.input_video.data, PNG_BASE64]) assert.ok(!safe.includes(data));
  }
});
