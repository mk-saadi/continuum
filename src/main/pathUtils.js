'use strict';

const path = require('node:path');

function resolveSubAgentPath(targetPath, projectRoot = null) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || targetPath.includes('\0'))
    throw new Error('Invalid file path.');
  if (path.isAbsolute(targetPath)) return path.normalize(targetPath);
  // Keep a Windows drive/UNC path intact when parsing a task on another host.
  if (path.win32.isAbsolute(targetPath)) return path.win32.normalize(targetPath);
  return path.resolve(projectRoot || process.cwd(), targetPath);
}

function fileNotFound(resolvedPath) {
  return new Error(`FILE_NOT_FOUND: The file at '${resolvedPath}' does not exist or is inaccessible.`);
}

module.exports = { resolveSubAgentPath, fileNotFound };
