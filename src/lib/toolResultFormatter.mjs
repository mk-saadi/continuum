import secretRedaction from './secretRedaction.cjs';
// Runtime-only provenance; never accepted from JSON or model arguments.
export const NATIVE_RESULT = Symbol('native-result');
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

function formatUnredactedToolResult(output, toolName = '') {
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
  const acknowledgment = /screenshot/i.test(toolName) ? 'Screenshot captured successfully.'
    : toolName === 'read_project_file' ? 'Image supplied for inspection; interpretation requires a compatible vision model.' : 'Image captured successfully.';
  return {
    content: images.size ? [...(Array.isArray(output) && output.every(part => ['text', 'image_url'].includes(part?.type)) && safe.some(part => part?.type === 'text')
      ? safe.filter(part => part?.type === 'text' || part === INVALID_IMAGE_NOTICE).map(part => typeof part === 'string' ? { type: 'text', text: part } : part) : [{ type: 'text', text: `${acknowledgment}\n${text}` }]), ...images.values()] : text,
    mediaDetected: true,
    displayResult: safe,
  };
}

// Model content is redacted separately; the user's original result remains intact.
export function redactModelContent(value, options = {}) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); const safe = redactModelContent(parsed, options);
      return JSON.stringify(parsed) === JSON.stringify(safe) ? value : JSON.stringify(safe); } catch {}
    return secretRedaction.redactSecrets(value, options);
  }
  if (Array.isArray(value)) return value.map(item => redactModelContent(item, options));
  if (!value || typeof value !== 'object' || value.type === 'image_url') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    (secretRedaction.isSecretName(key) || /^authorization$/i.test(key)) && typeof item === 'string' ? '[redacted]' : redactModelContent(item, options)]));
}
export function formatToolResult(output, toolName = '', options = {}) {
  const formatted = formatUnredactedToolResult(output, toolName);
  // Only the native dispatcher may assert provenance. Never trust a field
  // name inside file text, an MCP payload, or a nested serialized object.
  const trusted = options.nativeTool === toolName &&
    ['read_project_file', 'write_project_file', 'str_replace_editor'].includes(toolName);
  let source = formatted.content;
  let hashes;
  if (trusted) {
    try {
      const result = typeof source === 'string' ? JSON.parse(source) : null;
      if (result && !Array.isArray(result) && typeof result === 'object') {
        hashes = Object.fromEntries(['content_hash', 'current_content_hash']
          .filter(key => typeof result[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(result[key]))
          .map(key => [key, result[key]]));
        // Redact every other field, including untrusted content, normally.
        source = JSON.stringify({ ...result, ...Object.fromEntries(Object.keys(hashes).map(key => [key, null])) });
      }
    } catch { /* Non-structured results receive no exception. */ }
  }
  let content = redactModelContent(source, options);
  if (hashes && Object.keys(hashes).length) content = JSON.stringify({ ...JSON.parse(content), ...hashes });
  const redacted = JSON.stringify(content) !== JSON.stringify(formatted.content);
  const displayResult = redacted && formatted.displayResult && typeof formatted.displayResult === 'object' && !Array.isArray(formatted.displayResult)
    ? { ...formatted.displayResult, modelOutputRedacted: true } : formatted.displayResult;
  return { ...formatted, content, displayResult, redacted };
}

// The engine's generic text cap can cut JSON mid-string. Keep a trusted file
// page as valid JSON so the next wire sanitization can still recognize its
// revision field. Source text stays redacted and explicitly an excerpt.
export function boundNativeFilePage(content, guard, notice = '') {
  let page;
  try { page = JSON.parse(content); } catch { return null; }
  if (!page || typeof page.content !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(page.content_hash ?? '')) return null;
  const source = page.content;
  const wrap = count => {
    let text = source.slice(0, count);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return JSON.stringify({ ...page, content: text, content_truncated: true, context_excerpt: true,
      ...(notice ? { source_evidence: notice.trim() } : {}) });
  };
  if (guard(wrap(0)) !== wrap(0)) return null;
  let low = 0, high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2), value = wrap(middle);
    if (guard(value) === value) low = middle; else high = middle - 1;
  }
  return wrap(low);
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
