'use strict';

const sharp = (...args) => require('sharp')(...args);
const FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const failure = message => new Error(`Cannot prepare image attachment: ${message} Use a static PNG, JPEG, or WebP image, or select a compatible model. The original file is unchanged.`);

// libvips versions without APNG support expose only its first frame. Detect
// the animation-control chunk ourselves rather than silently dropping frames.
function animatedPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}
async function inspectImage(bytes, mime) {
  if (!FORMATS[mime]) throw failure('This image format is unsupported; GIF and other animated formats are not accepted in Phase 1.');
  try {
    const metadata = await sharp(bytes, { animated: true }).metadata();
    if (metadata.format !== FORMATS[mime]) throw failure('The file extension/MIME does not match its encoded image format.');
    if ((metadata.pages || 1) > 1 || animatedPng(bytes)) throw failure('Animated images are unsupported. Export the desired frame explicitly.');
    // Decode pixels as well as the header; never advertise a corrupt image as usable.
    await sharp(bytes).stats();
    return metadata;
  } catch (error) {
    if (error.message.startsWith('Cannot prepare image attachment:')) throw error;
    throw failure('The image could not be safely decoded (it may be corrupt or exceed decoder resource limits).');
  }
}
async function prepareImageMessages(messages, { local = false } = {}) {
  const result = [];
  for (const message of messages || []) {
    if (!Array.isArray(message.content)) { result.push(message); continue; }
    const content = [];
    for (const part of message.content) {
      if (part.type !== 'image_url') { content.push(part); continue; }
      const match = /^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url || '');
      if (!match) throw failure('Image input must contain valid encoded image bytes.');
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.toString('base64') !== match[2]) throw failure('Invalid image encoding.');
      const meta = await inspectImage(bytes, match[1]);
      const orient = meta.orientation > 1;
      // llama.cpp uses stb_image, which does not decode WebP. PNG retains alpha
      // and resolution. EXIF orientation is baked into pixels so decoders that
      // ignore EXIF see the same orientation as the browser preview.
      if (orient || (local && match[1] === 'image/webp')) {
        const { data, info } = await sharp(bytes).rotate().png().toBuffer({ resolveWithObject: true });
        const reasons = [orient && 'EXIF orientation applied', local && match[1] === 'image/webp' && 'WebP converted for local decoder compatibility'].filter(Boolean).join('; ');
        content.push({ type: 'text', text: `[Image delivery: ${reasons}; lossless PNG ${info.width} × ${info.height}; original retained.]` });
        content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${data.toString('base64')}` } });
      } else content.push(part); // No resizing, recompression, or alpha flattening.
    }
    result.push({ ...message, content });
  }
  return result;
}
async function prepareMediaMessages(messages, options) {
  const { sanitizeMediaContent } = await import('../lib/mediaContent.mjs');
  const validated = (messages || []).map(message => ({ ...message,
    content: sanitizeMediaContent(message.content, message.role) }));
  return prepareImageMessages(validated, options);
}
module.exports = { inspectImage, prepareImageMessages, prepareMediaMessages, EXTENSIONS };
