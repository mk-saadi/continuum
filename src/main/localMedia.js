'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm']);

function validateLocalPath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath) ||
      /[\\/]{2}/.test(filePath.slice(0, 2)) || filePath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected an absolute local file path.');
  }
  return filePath;
}

async function resolveMediaPath(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'local:' || url.host !== 'media' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid local media URL.');
  }
  const filePath = validateLocalPath(decodeURIComponent(url.pathname.slice(1)));
  if (!MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('Unsupported media type.');
  const realPath = await fs.realpath(filePath);
  validateLocalPath(realPath);
  if (!MEDIA_EXTENSIONS.has(path.extname(realPath).toLowerCase()) || !(await fs.stat(realPath)).isFile()) {
    throw new Error('Expected a media file.');
  }
  return realPath;
}

function registerLocalMediaProtocol(protocol) {
  protocol.registerFileProtocol('local', (request, callback) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return callback({ error: -10 });
    resolveMediaPath(request.url).then(filePath => callback({ path: filePath }), () => callback({ error: -10 }));
  });
}

module.exports = { validateLocalPath, resolveMediaPath, registerLocalMediaProtocol };
