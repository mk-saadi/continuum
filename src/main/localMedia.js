'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico', '.mp4', '.webm', '.mov', '.mkv', '.avi', '.ts', '.m2ts', '.mts', '.mpeg', '.mpg', '.m4v', '.ogv', '.ogg', '.3gp', '.3g2', '.wmv', '.flv', '.vob']);

function validateLocalPath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath) ||
      /[\\/]{2}/.test(filePath.slice(0, 2)) || filePath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected an absolute local file path.');
  }
  return filePath;
}

function publicMediaPath(filePath) {
  const inside=(root)=> {const relative=path.relative(root,filePath);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));};
  try {
    const store=require('./attachmentStore');
    // Attachments (including aliases/snapshots) use conversation-owned ID IPC,
    // never the global markdown media protocol, even inside a project root.
    if(inside(store.directory())) return false;
    try { if(inside(require('node:fs').realpathSync(store.directory()))) return false; } catch { /* No managed directory yet. */ }
    const database=require('./db');
    if(database.isInitialized()) {
      if(database.db.prepare('SELECT 1 FROM attachment_versions WHERE file_path=? OR real_path=? OR snapshot_path=? LIMIT 1').get(filePath,filePath,filePath)) return false;
      if(database.db.prepare('SELECT 1 FROM attachment_path_aliases WHERE file_path=? LIMIT 1').get(filePath)) return false;
      if(database.db.prepare('SELECT 1 FROM message_attachments WHERE file_path=? LIMIT 1').get(filePath)) return false;
      for(const project of database.db.prepare('SELECT root_path FROM projects').all()) if(inside(project.root_path)) return true;
    }
    const profile=require('electron').app.getPath('userData');
    const appData=require('./configStore').getConfig().appDataDirectory;
    return [require('electron').app.getPath('downloads'),path.join(profile,'generated_media'),path.join(appData,'avatars'),path.join(appData,'backgrounds')].some(inside);
  } catch { return false; }
}
async function resolveMediaPath(rawUrl, authorize = publicMediaPath) {
  const url = new URL(rawUrl);
  const legacy = url.protocol === 'local:' && url.host === 'media';
  const media = url.protocol === 'media:' && (url.host === 'files' || (!url.host && rawUrl.startsWith('media:///')));
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
  if(!authorize(filePath) || !authorize(realPath)) throw new Error('Use a conversation attachment ID for protected media.');
  if (path.extname(realPath).toLowerCase() === '.ts' && !require('./transportStream').isTransportStreamFile(realPath)) {
    throw new Error('This .ts file is source code, not an MPEG transport stream.');
  }
  return realPath;
}

const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t',
  '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.vob': 'video/mpeg',
  '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
};

async function serveMediaRequest(request, authorize = publicMediaPath) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  try {
    const filePath = await resolveMediaPath(request.url, authorize);
    const { size } = await fs.stat(filePath);
    const headers = new Headers({
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()],
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    });
    let start = 0, end = size - 1, status = 200;
    // Electron net.fetch(file:) ignores Range. Serve the requested bytes ourselves
    // so metadata preload, resuming playback and seeking all work reliably.
    const range = request.method === 'GET' && request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          headers.set('Content-Range', `bytes */${size}`);
          headers.set('Content-Length', '0');
          return new Response(null, { status: 416, headers });
        }
        status = 206;
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        headers.set('Content-Length', String(end - start + 1));
      }
      // Malformed or multipart ranges are ignored, returning a full 200 response.
    }
    const body = request.method === 'HEAD' || size === 0 ? null
      : Readable.toWeb(createReadStream(filePath, { start, end }));
    return new Response(body, { status, headers });
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

module.exports = { validateLocalPath, resolveMediaPath, registerLocalMediaProtocol, serveMediaRequest, publicMediaPath };
