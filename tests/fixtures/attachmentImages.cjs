'use strict';
const sharp = require('sharp');
async function attachmentImages() {
  const text = Array.from({ length: 90 }, (_, y) => `<text x="12" y="${20 + y * 22}" font-size="12">${y}: Dense screenshot fixture — preserve small text and original pixels 0123456789</text>`).join('');
  const dense = await sharp(Buffer.from(`<svg width="4096" height="2048"><rect width="4096" height="2048" fill="white"/>${text}</svg>`)).png().toBuffer();
  const transparent = await sharp({ create: { width: 37, height: 23, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.25 } } }).png().toBuffer();
  const oriented = await sharp({ create: { width: 40, height: 24, channels: 3, background: '#39a' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const webp = await sharp(transparent).webp({ lossless: true }).toBuffer();
  const legacy = await sharp(dense).resize(1024, 512).jpeg({ quality: 80 }).toBuffer();
  return [
    { name: 'dense.png', mime: 'image/png', width: 4096, height: 2048, bytes: dense },
    { name: 'transparent.png', mime: 'image/png', width: 37, height: 23, bytes: transparent },
    { name: 'oriented.jpg', mime: 'image/jpeg', width: 40, height: 24, displayWidth: 24, displayHeight: 40, bytes: oriented },
    { name: 'alpha.webp', mime: 'image/webp', width: 37, height: 23, bytes: webp },
    { name: 'legacy.jpg', mime: 'image/jpeg', width: 1024, height: 512, bytes: legacy },
  ];
}
module.exports = { attachmentImages };
