import { sanitizeImagePart, validateImageDataUrl } from './imageValidation.mjs';

const VIDEO_FORMATS = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg']);
function fail(message) { throw new Error(`Cannot prepare attachment input: ${message} Select a compatible model or attach a supported file.`); }
function base64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && btoa(atob(value)) === value;
}
export function containsEncodedMedia(value) {
  if (typeof value === 'string') {
    if (/^data:(image|audio|video)\//i.test(value.trim())) return true;
    if (/^\s*[\[{]/.test(value)) {
      try { return containsEncodedMedia(JSON.parse(value)); } catch { /* Ordinary text. */ }
    }
    return false;
  }
  if (!value || typeof value !== 'object') return false;
  return /^(image|audio|video)\//.test(value.mimeType || value.mime_type || value.media_type || '') ||
    /^(image|audio|video|input_image|input_audio|input_video|image_url|audio_url|video_url)$/.test(value.type) ||
    Object.entries(value).some(([key, item]) => /^(image_url|input_audio|input_video|audio_url|video_url)$/.test(key) || containsEncodedMedia(item));
}
export function hasAudioVideo(value) {
  if (typeof value === 'string') {
    if (/data:(audio|video)\//i.test(value)) return true;
    if (/^\s*[\[{]/.test(value)) { try { return hasAudioVideo(JSON.parse(value)); } catch { /* Text. */ } }
    return false;
  }
  if (!value || typeof value !== 'object') return false;
  if (/^(input_audio|input_video|audio_url|video_url|audio|video)$/.test(value.type) ||
    /^(audio|video)\//.test(value.mimeType || value.mime_type || value.media_type || '')) return true;
  return Object.entries(value).some(([key, child]) => /^(input_audio|input_video|audio_url|video_url)$/.test(key) || hasAudioVideo(child));
}
export function sanitizeMediaContent(content, role, decodeImage) {
  if (!Array.isArray(content)) {
    if (containsEncodedMedia(content)) fail('Encoded media must be supplied as structured content parts, never as text or a JSON object.');
    return content == null ? null : typeof content === 'string' ? content : JSON.stringify(content);
  }
  if (!['user', 'tool'].includes(role)) fail(`Media/content arrays are unsupported for role ${role}.`);
  return content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      if (/^data:(image|audio|video)\/[^;]+;base64,/i.test(part.text.trim())) fail('Encoded media cannot be a text part.');
      return { type: 'text', text: part.text };
    }
    if (part?.type === 'image_url') {
      // Desktop transport decodes originals with sharp; Chromium's nativeImage
      // does not decode WebP on every platform. Tool corruption keeps its notice.
      if (role === 'tool') return sanitizeImagePart(part, /^data:image\/webp;/i.test(part.image_url?.url || '') ? undefined : decodeImage);
      const url = validateImageDataUrl(part.image_url?.url);
      if (!url) fail('The image is corrupt or its format is unsupported. Use a static PNG, JPEG, or WebP image.');
      return { type: 'image_url', image_url: { url } };
    }
    if (role !== 'user') fail('Audio/video tool results do not have a supported delivery pathway.');
    if (part?.type === 'input_audio' && ['wav', 'mp3'].includes(part.input_audio?.format) && base64(part.input_audio?.data))
      return { type: 'input_audio', input_audio: { data: part.input_audio.data, format: part.input_audio.format } };
    if (part?.type === 'input_video' && VIDEO_FORMATS.has(part.input_video?.format) && base64(part.input_video?.data))
      return { type: 'input_video', input_video: { data: part.input_video.data, format: part.input_video.format } };
    fail(`Unsupported or malformed content part (${String(part?.type || 'unknown')}). Audio requires WAV/MP3; video requires MP4/WebM/MOV/MPEG.`);
  });
}
