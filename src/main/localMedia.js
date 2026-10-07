'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico', '.mp4', '.webm', '.mov', '.mkv', '.avi', '.ts']);

function validateLocalPath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath) ||
      /[\\/]{2}/.test(filePath.slice(0, 2)) || filePath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected an absolute local file path.');
  }
  return filePath;
}

async function resolveMediaPath(rawUrl) {
  const url = new URL(rawUrl);
  const legacy = url.protocol === 'local:' && url.host === 'media';
  const media = url.protocol === 'media:' && !url.host && rawUrl.startsWith('media:///');
  if ((!legacy && !media) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid local media URL.');
  }
  let decodedPath = decodeURIComponent(legacy ? url.pathname.slice(1) : url.pathname);
  if (media && process.platform === 'win32' && /^\/[a-z]:\//i.test(decodedPath)) decodedPath = decodedPath.slice(1);
  const filePath = validateLocalPath(decodedPath);
  if (!MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('Unsupported media type.');
  const realPath = await fs.realpath(filePath);
  validateLocalPath(realPath);
  if (!MEDIA_EXTENSIONS.has(path.extname(realPath).toLowerCase()) || !(await fs.stat(realPath)).isFile()) {
    throw new Error('Expected a media file.');
  }
  return realPath;
}

async function serveMediaRequest(request, fetchFile) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  try {
    const filePath = await resolveMediaPath(request.url);
    // Chromium's file loader streams bytes and handles Range requests for seeking.
    const headers = new Headers();
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    return await fetchFile(pathToFileURL(filePath).href, { method: request.method, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function registerLocalMediaProtocol(protocol) {
  protocol.registerFileProtocol('local', (request, callback) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return callback({ error: -10 });
    resolveMediaPath(request.url).then(filePath => callback({ path: filePath }), () => callback({ error: -10 }));
  });
}

module.exports = { validateLocalPath, resolveMediaPath, registerLocalMediaProtocol, serveMediaRequest };
