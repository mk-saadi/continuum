import { defaultUrlTransform } from 'react-markdown';
import { defaultSchema } from 'rehype-sanitize';

export function mediaSource(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let source = value.trim();
  let decoded = false;
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname || url.search || url.hash) return '';
      source = decodeURIComponent(url.pathname);
      decoded = true;
    } catch { return ''; }
  }
  if (/^[a-z]:[\\/]/i.test(source)) source = '/' + source.replace(/\\/g, '/');
  if (source.startsWith('/') && !source.startsWith('//')) {
    // Markdown already percent-encodes spaces and Unicode in destinations.
    if (!decoded) {
      try { source = decodeURIComponent(source); } catch { /* A literal percent in a raw path. */ }
    }
    return 'media://' + source.split('/').map(segment => encodeURIComponent(segment)).join('/');
  }
  // Online video is intentionally unsupported: playback is local-files-only.
  if (/^(https:\/\/|media:\/\/\/|local:\/\/media\/)/i.test(source)) return source;
  // Inline base64 is limited to images; video must be a file on disk.
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(source)) return source;
  return '';
}

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi|ts)$/i;

export function isVideoSource(source) {
  try { return VIDEO_EXTENSIONS.test(decodeURIComponent(new URL(source).pathname)); }
  catch { return false; }
}

// Video playback is restricted to local files served through the app's own protocols.
export function isLocalVideoSource(source) {
  return typeof source === 'string' && /^(media:\/\/\/|local:\/\/media\/)/i.test(source) && isVideoSource(source);
}

export function mediaUrlTransform(url, key, node) {
  if (key === 'src' && ['img', 'video', 'source'].includes(node.tagName)) return mediaSource(url);
  return defaultUrlTransform(url);
}

// Normalize before sanitization so Windows drive letters aren't read as schemes.
export function rehypeMediaSources() {
  return tree => {
    function visit(node) {
      if (['img', 'video', 'source'].includes(node.tagName) && node.properties?.src) {
        node.properties.src = mediaSource(node.properties.src);
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

// Iframes are deliberately excluded from the schema: no cross-origin embedding.
export const mediaSchema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames, 'video', 'source'],
  attributes: {
    ...defaultSchema.attributes,
    video: ['src', 'controls', 'title'],
    source: ['src', 'type'],
  },
  protocols: { ...defaultSchema.protocols, src: ['https', 'media', 'local', 'data'] },
};
