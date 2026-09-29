import { validateImageDataUrl, INVALID_IMAGE_NOTICE } from './imageValidation.mjs';
// Keep image bytes in image_url parts, never in tokenizer-facing text or UI logs.
const DATA_IMAGE = /data:(image\/[a-zA-Z0-9.+-]+);base64,([^\s"'<>]*)/g;
const IMAGE_KEYS = /^(data|base64|blob|image|image_data|image_base64|imageBase64|screenshot|screenshot_base64|url)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const normalizeMime = value => typeof value === 'string' && /^image\/[a-z0-9.+-]+$/i.test(value)
  ? value.toLowerCase().replace('image/jpg', 'image/jpeg') : null;
function sniffMime(data) {
  if (data.startsWith('iVBORw0KGgo')) return 'image/png';
  if (data.startsWith('/9j/')) return 'image/jpeg';
  if (data.startsWith('R0lGOD')) return 'image/gif';
  if (data.startsWith('UklGR') && data.slice(8, 20).includes('XRUJQ')) return 'image/webp';
  return null;
}

export function formatToolResult(output, toolName = '') {
  const images = new Map();
  let removedMedia = false;
  const mediaTool = /(?:screenshot|read_media|image|capture)/i.test(toolName);
  const addImageUrl = value => {
    removedMedia = true;
    const url = validateImageDataUrl(value);
    if (!url) return INVALID_IMAGE_NOTICE;
    images.set(url, { type: 'image_url', image_url: { url } });
    return '[Image attached]';
  };
  const addImage = (mime, data) => addImageUrl(`data:${mime};base64,${data}`);
  function clean(value, key = '', inheritedMime = null) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^data:image\//i.test(trimmed)) return addImageUrl(trimmed);
      // MCP results (and structuredContent) may themselves be serialized JSON.
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return clean(JSON.parse(trimmed), key, inheritedMime); } catch { /* Plain text. */ }
      }
      let found = false;
      const safe = value.replace(DATA_IMAGE, (_match, mime, data) => {
        found = true;
        return addImage(normalizeMime(mime), data);
      });
      if (found) return safe;
      const data = trimmed.replace(/\s/g, '');
      if (inheritedMime && IMAGE_KEYS.test(key)) return addImage(inheritedMime, data);
      const signature = sniffMime(data);
      const mime = signature || inheritedMime;
      const imageField = IMAGE_KEYS.test(key) || (key === '' && mediaTool);
      if (data && BASE64.test(data) && (signature || imageField) && (mime || data.length > 256)) {
        if (mime && (imageField || data.length > 256)) return addImage(mime, data);
        // Unknown binary must not silently become hundreds of thousands of text tokens.
        if (imageField) { removedMedia = true; return '[Encoded media omitted: no recognized image MIME type]'; }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => clean(item, key, inheritedMime));
    if (!value || typeof value !== 'object') return value;
    const mime = normalizeMime(value.mimeType ?? value.mime_type ?? value.media_type ?? value.mime ?? value.format) || inheritedMime;
    if (value.type === 'image_url') return addImageUrl(value.image_url?.url);
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, clean(item, field, mime)]));
  }
  const safe = clean(output);
  if (!removedMedia) return {
    content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
    displayResult: safe,
  };
  // Preserve accompanying tool text and errors, but only after recursively removing bytes.
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
  const acknowledgment = /screenshot/i.test(toolName) ? 'Screenshot captured successfully.' : 'Image captured successfully.';
  return {
    content: images.size ? [...(Array.isArray(output) && output.every(part => ['text', 'image_url'].includes(part?.type)) && safe.some(part => part?.type === 'text')
      ? safe.filter(part => part?.type === 'text' || part === INVALID_IMAGE_NOTICE).map(part => typeof part === 'string' ? { type: 'text', text: part } : part) : [{ type: 'text', text: `${acknowledgment}\n${text}` }]), ...images.values()] : text,
    mediaDetected: true,
    displayResult: safe,
  };
}

export function hasToolImages(messages) {
  return messages.some(message => message.role === 'tool' && Array.isArray(message.content) &&
    message.content.some(part => part.type === 'image_url'));
}

// Flush only AFTER all results for a call batch, preserving tool_call_id ordering.
export function moveToolImagesToUser(messages) {
  const result = [];
  let images = [];
  const flush = () => {
    if (images.length) result.push({ role: 'user', content: [{ type: 'text', text: 'Images attached by the preceding tools:' }, ...images] });
    images = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const parts = message.content.filter(part => part.type === 'image_url');
      images.push(...parts);
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      result.push({ ...message, content: `${parts.length ? 'Image attached to next turn.\n' : ''}${text}` });
    } else result.push(message);
  }
  flush();
  return result;
}

export function rejectsToolImages(status, body) {
  return [400, 415, 422, 500].includes(status) &&
    /tool|content|image|multimodal|jinja|template/i.test(body) &&
    /unsupported|not support|not allowed|must be|expected|expecting|invalid type|cannot|can't|array|string|list|image_url/i.test(body) &&
    !/context.{0,30}(exceed|overflow|too (large|long))|exceed.{0,30}context/i.test(body);
}

export function redactToolMedia(value) {
  const formatted = formatToolResult(value);
  return formatted.mediaDetected ? formatted.displayResult : value;
}
