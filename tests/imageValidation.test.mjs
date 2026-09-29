import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageDataUrl, INVALID_IMAGE_NOTICE } from '../src/lib/imageValidation.mjs';
import { sanitizeChatMessages, runMemoryChat } from '../src/lib/memoryChat.mjs';
import { formatToolResult } from '../src/lib/toolResultFormatter.mjs';
import { PNG_BASE64, JPEG_BASE64, WEBP_BASE64 } from './fixtures/visionImages.mjs';
const png = `data:image/png;base64,${PNG_BASE64}`;
const part = url => ({ type: 'image_url', image_url: { url } });

test('cleans whitespace and accepts correctly encoded PNG, JPEG and WebP containers', () => {
  for (const [mime, bytes] of [['png', PNG_BASE64], ['jpeg', JPEG_BASE64], ['webp', WEBP_BASE64]]) {
    const original = `data:image/${mime};base64,${bytes}`;
    const wrapped = ` data:image/${mime};base64,\n${bytes.match(/.{1,16}/g).join(' \t\r\n')} \n`;
    assert.equal(validateImageDataUrl(wrapped), original);
  }
});

test('rejects empty, malformed, truncated, mismatched and unsupported images', () => {
  for (const url of [null, {}, '', 'data:image/png;base64,', 'data:image/png;base64, \n', 'data:image/png;base64,cG5n',
    png + 'garbage', png.slice(0, -8), png.replace('png', 'jpeg'), png.replace('png', 'gif'),
    png.replace('base64,', 'base64,@'), `data:image/png;base64,${PNG_BASE64.slice(0, -1)}!`, 'https://example.com/image.png']) {
    assert.equal(validateImageDataUrl(url), null, String(url));
    const [message] = sanitizeChatMessages([{ role: 'user', content: [part(url)] }]);
    assert.deepEqual(message.content, [{ type: 'text', text: INVALID_IMAGE_NOTICE }]);
  }
});

test('real decoder failure replaces the image without altering surrounding text', () => {
  let decoded = 0;
  const messages = sanitizeChatMessages([{ role: 'user', content: [{ type: 'text', text: 'Inspect this.' }, part(png)] }], (bytes, mime) => {
    decoded++; assert.ok(bytes instanceof Uint8Array); assert.equal(mime, 'image/png'); return false;
  });
  assert.equal(decoded, 1);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'Inspect this.' }, { type: 'text', text: INVALID_IMAGE_NOTICE }]);
  assert.equal(validateImageDataUrl(png, () => { throw new Error('Decode failed'); }), null);
});

test('malformed MCP/raw images are omitted and mixed results retain placeholders', () => {
  for (const value of [{ content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 + '@' }] },
    part('data:image/png;base64,'), part(png + '@'), { mimeType: 'image/png', data: '' }]) {
    const formatted = formatToolResult(value);
    assert.equal(typeof formatted.content, 'string');
    assert.ok(formatted.content.includes(INVALID_IMAGE_NOTICE));
    assert.ok(!formatted.content.includes(PNG_BASE64));
  }
  const result = formatToolResult([{ type: 'text', text: 'Caption' }, part(png), part('data:image/png;base64,@')]);
  assert.ok(result.content.some(block => block.text === INVALID_IMAGE_NOTICE));
  assert.equal(result.content.filter(block => block.type === 'image_url').length, 1);
});

test('final wire payload omits corrupt image buffers in both user and tool roles', async () => {
  let payload;
  const messages = [{ role: 'system', content: 'Help.' }, { role: 'user', content: [part(png)] },
    { role: 'assistant', tool_calls: [{ id: 'image', function: { name: 'take_screenshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'image', content: part(png) }];
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'model', messages, decodeImage: () => false,
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'Image unavailable.' }, finish_reason: 'stop' }] }); },
  });
  assert.ok(!JSON.stringify(payload.messages).includes(PNG_BASE64));
  assert.ok(!JSON.stringify(payload.messages).includes('image_url'));
  assert.ok(payload.messages[1].content.some(part => part.text === INVALID_IMAGE_NOTICE));
  assert.ok(payload.messages[3].content.some(part => part.text === INVALID_IMAGE_NOTICE));
  assert.equal(payload.messages[3].tool_call_id, 'image');
});
