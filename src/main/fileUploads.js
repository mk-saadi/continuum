'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MIME_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.jsx': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain', '.py': 'text/plain',
  '.html': 'text/html', '.css': 'text/css', '.xml': 'text/xml',
  '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain', '.ini': 'text/plain',
  '.sh': 'text/plain', '.sql': 'text/plain', '.log': 'text/plain', '.tsv': 'text/tab-separated-values',
  '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain', '.java': 'text/plain',
  '.go': 'text/plain', '.rs': 'text/plain', '.rb': 'text/plain', '.php': 'text/plain',
});
const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;

function attachmentsDirectory() {
  return path.join(require("./configStore").getConfig().appDataDirectory, 'attachments');
}

function inspectFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new TypeError('An absolute file path is required.');
  }
  const mime = MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error('Supported attachments: PNG, JPEG, GIF, WebP, PDF, and text files (TXT, Markdown, CSV, JSON, source code, and configuration files).');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Attachments must be regular files.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('Each attachment must be 20 MB or smaller.');
  return { file_path: filePath, mime_type: mime, size: stat.size };
}

function validateAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length > MAX_FILES) {
    throw new TypeError(`Choose at most ${MAX_FILES} attachments.`);
  }
  let total = 0;
  return attachments.map((attachment) => {
    const file = inspectFile(attachment?.file_path);
    // Prompts may read only managed copies, never renderer-supplied arbitrary paths.
    const directory = fs.realpathSync(attachmentsDirectory());
    if (path.dirname(fs.realpathSync(file.file_path)) !== directory || file.mime_type !== attachment.mime_type) {
      throw new Error('Invalid managed attachment. Upload the file before attaching it.');
    }
    total += file.size;
    if (total > MAX_BATCH_BYTES) throw new Error('Attachments must total 50 MB or less.');
    return { file_path: file.file_path, mime_type: file.mime_type };
  });
}

async function processUploads(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length > MAX_FILES) {
    throw new TypeError(`Choose at most ${MAX_FILES} attachments.`);
  }
  const sources = filePaths.map(source => {
    if (typeof source === 'string') return inspectFile(source);
    const dataUrl = source?.dataUrl;
    if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 23 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
      throw new Error('Invalid optimized JPEG attachment.');
    }
    const bytes = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64');
    if (bytes.length > MAX_FILE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error('Invalid optimized JPEG attachment.');
    }
    const name = typeof source.name === 'string' ? path.basename(source.name).replace(/\.[^.]*$/, '') : 'image';
    return { file_path: `${name || 'image'}.jpg`, mime_type: 'image/jpeg', size: bytes.length, bytes };
  });
  if (sources.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) {
    throw new Error('Attachments must total 50 MB or less.');
  }
  const directory = attachmentsDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const saved = [];
  try {
    for (const source of sources) {
      const filePath = path.join(directory, `${Date.now()}-${randomUUID()}-${path.basename(source.file_path)}`);
      if (source.bytes) await fs.promises.writeFile(filePath, source.bytes, { flag: 'wx' });
      else await fs.promises.copyFile(source.file_path, filePath, fs.constants.COPYFILE_EXCL);
      saved.push({ file_path: filePath, mime_type: source.mime_type });
    }
    return validateAttachments(saved);
  } catch (error) {
    await Promise.all(saved.map(({ file_path }) => fs.promises.unlink(file_path).catch(() => {})));
    throw error;
  }
}

function attachmentName(filePath) {
  return path.basename(filePath).replace(/^\d+-[0-9a-f-]{36}-/i, '');
}

module.exports = { processUploads, validateAttachments, attachmentName, inspectFile };
