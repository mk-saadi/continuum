const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { validateImageDataUrl } = await import('../src/lib/imageValidation.mjs');
  const { PNG_BASE64, JPEG_BASE64, WEBP_BASE64, largePng } = await import('./fixtures/visionImages.mjs');
  const decode = bytes => !nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty();
  for (const [mime, data] of [['png', PNG_BASE64], ['jpeg', JPEG_BASE64], ['png', largePng()]]) {
    const url = `data:image/${mime};base64,${data}`;
    assert.equal(validateImageDataUrl(url, decode), url, `Valid ${mime} must decode`);
  }
  // This Electron build does not decode WebP; unsupported buffers must fail safely.
  const webp = `data:image/webp;base64,${WEBP_BASE64}`;
  assert.equal(validateImageDataUrl(webp, decode), decode(Buffer.from(WEBP_BASE64, 'base64')) ? webp : null);
  const broken = Buffer.from(PNG_BASE64, 'base64');
  const idat = broken.indexOf('IDAT');
  broken.fill(0, idat + 4, broken.length - 12);
  const url = `data:image/png;base64,${broken.toString('base64')}`;
  assert.ok(validateImageDataUrl(url), 'Transport and signatures alone do not detect corrupt pixels');
  assert.equal(validateImageDataUrl(url, decode), null, 'Decoder catches corrupted image data');
  console.log('Native image decoding accepts real PNG/JPEG, handles WebP support safely, and rejects corrupted PNG pixels.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
