export const INVALID_IMAGE_NOTICE = '[System: Attached image buffer was invalid/corrupted and was omitted from context]';

// Strict transport/container validation; the desktop supplies a real image decoder
// too, because a correct base64 alphabet and file signature do not prove validity.
export function validateImageDataUrl(value, decodeImage) {
  if (typeof value !== 'string') return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([\s\S]*)$/i.exec(value.trim());
  if (!match) return null;
  const base64 = match[2].replace(/\s/g, '');
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  try {
    const decoded = atob(base64);
    if (btoa(decoded) !== base64) return null; // Reject noncanonical padding bits.
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    const mime = match[1].toLowerCase();
    const at = (offset, values) => values.every((value, index) => bytes[offset + index] === value);
    const ascii = (offset, text) => at(offset, Array.from(text, char => char.charCodeAt(0)));
    if (mime === 'png' && !(bytes.length >= 45 && at(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
      ascii(12, 'IHDR') && at(bytes.length - 12, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) return null;
    if (mime === 'jpeg' && !(bytes.length >= 4 && at(0, [255, 216]) && at(bytes.length - 2, [255, 217]))) return null;
    if (mime === 'webp' && !(bytes.length >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP') &&
      ['VP8 ', 'VP8L', 'VP8X'].some(chunk => ascii(12, chunk)) &&
      new DataView(bytes.buffer).getUint32(4, true) + 8 === bytes.length)) return null;
    if (decodeImage && decodeImage(bytes, `image/${mime}`) !== true) return null;
    return `data:image/${mime};base64,${base64}`;
  } catch { return null; }
}

export function sanitizeImagePart(part, decodeImage) {
  const url = validateImageDataUrl(part?.image_url?.url, decodeImage);
  return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: INVALID_IMAGE_NOTICE };
}
