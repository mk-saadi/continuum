'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

function imageExtension(contentType, bytes) {
  const type = contentType?.split(';', 1)[0].trim().toLowerCase();
  const byType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
  if (byType[type]) return byType[type];
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  throw new Error('Image provider returned an unsupported image format.');
}

async function generateImage({ prompt, signal, fetchImpl = fetch } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000 || prompt.includes('\0')) {
    throw new Error('Image prompt must be between 1 and 10,000 characters.');
  }
  const provider = require('../cloudProviders').getActiveMediaModel('image');
  if (!provider) throw new Error('Choose and save a Default Image Model for Tools in Settings → Cloud Providers → Media Models.');

  let endpoint;
  if (provider.apiType === 'openrouter') endpoint = 'https://openrouter.ai/api/v1/images/generations';
  else if (provider.apiType === 'openai-images') endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/images/generations`;
  else if (provider.apiType === 'stable-diffusion') endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/sdapi/v1/txt2img`;
  else throw new Error('The selected image provider API type is unsupported.');

  const stableDiffusion = provider.apiType === 'stable-diffusion';
  const response = await fetchImpl(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
    body: JSON.stringify(stableDiffusion ? { prompt } : { model: provider.modelId, prompt }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${provider.name} image generation failed (HTTP ${response.status}).`);
  }
  const payload = await response.json();
  const item = payload?.data?.[0] ?? payload?.images?.[0];
  let bytes;
  let contentType;
  if (typeof item?.b64_json === 'string') bytes = Buffer.from(item.b64_json, 'base64');
  else if (typeof item?.url === 'string') {
    let imageUrl;
    try {
      imageUrl = new URL(item.url);
      if (!['http:', 'https:'].includes(imageUrl.protocol)) throw new Error();
    } catch { throw new Error('Image provider returned an invalid image URL.'); }
    const imageResponse = await fetchImpl(imageUrl, { method: 'GET', redirect: 'error', signal });
    if (!imageResponse.ok) {
      await imageResponse.body?.cancel();
      throw new Error('Failed to download the generated image.');
    }
    const declaredLength = Number(imageResponse.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      await imageResponse.body?.cancel();
      throw new Error('Generated image exceeds the 30 MB file limit.');
    }
    const data = Buffer.from(await imageResponse.arrayBuffer());
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds the 30 MB file limit.');
    bytes = data;
    contentType = imageResponse.headers.get('content-type');
  } else if (stableDiffusion && typeof item === 'string') bytes = Buffer.from(item, 'base64');
  else throw new Error('Image provider returned no image data.');

  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image data is empty or exceeds the 30 MB file limit.');
  const { app } = require('electron');
  const directory = path.join(app.getPath('userData'), 'generated_media');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${randomUUID()}${imageExtension(contentType, bytes)}`);
  await fs.writeFile(filePath, bytes, { flag: 'wx' });
  const markdownPath = filePath.split(path.sep).map(encodeURIComponent).join('/');
  return `![Generated image](${markdownPath})`;
}

module.exports = { generateImage, imageExtension };
