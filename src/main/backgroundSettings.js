'use strict';

// Custom static background image + UI surface opacity.
//
// Storage follows existing conventions:
// - The image file is copied into a managed directory under the configured
//   app-data directory (same pattern as attachments/ in fileUploads.js), so
//   persistence never depends on a temporary file-picker path remaining valid.
// - The `{ imagePath, opacity }` record lives in the SQLite `app_settings`
//   table under the `background-settings` key (same pattern as
//   `avatar-settings` in ipcHandlers.js).
// - Reads go through the `media://` protocol (localMedia.js), whose extension
//   whitelist already covers still images; video extensions are rejected here.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SETTINGS_KEY = 'background-settings';
// Opacity semantics: the slider is SURFACE OPACITY (percent). Higher = more
// solid/readable. Transparency = 100 - opacity. The floor keeps text readable
// over busy images; the ceiling equals fully solid surfaces.
const MIN_OPACITY = 40;
const MAX_OPACITY = 100;
const DEFAULT_OPACITY = 85;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico']);

function backgroundsDirectory() {
  return path.join(require('./configStore').getConfig().appDataDirectory, 'backgrounds');
}

function normalizeOpacity(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OPACITY;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Surface opacity must be a number.');
  const rounded = Math.round(parsed);
  if (rounded < MIN_OPACITY || rounded > MAX_OPACITY)
    throw new Error(`Surface opacity must be between ${MIN_OPACITY} and ${MAX_OPACITY}.`);
  return rounded;
}

function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid background settings.');
  const settings = { imagePath: null, opacity: DEFAULT_OPACITY };
  if (input.imagePath !== undefined && input.imagePath !== null) {
    if (typeof input.imagePath !== 'string' || !path.isAbsolute(input.imagePath))
      throw new Error('Invalid background image path.');
    settings.imagePath = input.imagePath;
  }
  if (input.opacity !== undefined) settings.opacity = normalizeOpacity(input.opacity);
  return settings;
}

function readSettingsRow() {
  const { db } = require('./db');
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row) return { imagePath: null, opacity: DEFAULT_OPACITY };
  try {
    return normalizeSettings(JSON.parse(row.value_json));
  } catch {
    return { imagePath: null, opacity: DEFAULT_OPACITY };
  }
}

function writeSettingsRow(settings) {
  const { db } = require('./db');
  db.prepare(
    'INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

// A stored path is only honored while it still resolves to a managed image
// file inside the backgrounds directory. Anything else (deleted, moved,
// replaced by a non-image) gracefully degrades to "no image" instead of
// breaking rendering.
function unlinkQuietly(filePath) {
	try {
		fs.unlinkSync(filePath);
	} catch {
		/* Best-effort cleanup of a stale managed copy. */
	}
}

function resolveStoredImage(imagePath) {
  if (!imagePath) return null;
  try {
    if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath) || imagePath.includes('\0'))
      return null;
    const directory = fs.realpathSync(backgroundsDirectory());
    const realPath = fs.realpathSync(imagePath);
    if (path.dirname(realPath) !== directory) return null;
    if (!IMAGE_EXTENSIONS.has(path.extname(realPath).toLowerCase())) return null;
    if (!fs.statSync(realPath).isFile()) return null;
    return realPath;
  } catch {
    return null;
  }
}

function getBackgroundSettings() {
  const stored = readSettingsRow();
  return { imagePath: resolveStoredImage(stored.imagePath), opacity: stored.opacity };
}

function setBackgroundOpacity(opacity) {
  const stored = readSettingsRow();
  const settings = normalizeSettings({ ...stored, opacity });
  writeSettingsRow(settings);
  return { imagePath: resolveStoredImage(settings.imagePath), opacity: settings.opacity };
}

function inspectSourceImage(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0'))
    throw new TypeError('An absolute file path is required.');
  const ext = path.extname(sourcePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) throw new Error('Choose a PNG, JPEG, WebP, GIF, AVIF, BMP, or ICO image.');
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error('The background must be a regular file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('Choose an image smaller than 10 MB.');
  return ext;
}

function adoptBackgroundImage(sourcePath) {
  const ext = inspectSourceImage(sourcePath);
  const directory = backgroundsDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `background-${randomUUID()}${ext}`);
  fs.copyFileSync(sourcePath, filePath, fs.constants.COPYFILE_EXCL);
  const previous = readSettingsRow();
  writeSettingsRow({ imagePath: filePath, opacity: previous.opacity });
  const stale = previous.imagePath && path.resolve(previous.imagePath) !== path.resolve(filePath)
    ? previous.imagePath
    : null;
  if (stale) unlinkQuietly(stale);
  return { imagePath: filePath, opacity: previous.opacity };
}

function removeBackgroundImage() {
  const stored = readSettingsRow();
  writeSettingsRow({ imagePath: null, opacity: stored.opacity });
  if (stored.imagePath) unlinkQuietly(stored.imagePath);
  return { imagePath: null, opacity: stored.opacity };
}

module.exports = {
  SETTINGS_KEY,
  MIN_OPACITY,
  MAX_OPACITY,
  DEFAULT_OPACITY,
  MAX_FILE_BYTES,
  IMAGE_EXTENSIONS,
  backgroundsDirectory,
  normalizeOpacity,
  normalizeSettings,
  getBackgroundSettings,
  setBackgroundOpacity,
  adoptBackgroundImage,
  removeBackgroundImage,
};
