"use strict";

// Custom background image + UI surface opacity.
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
//
// Phase 3.2: animated GIFs are additionally bounded for rendering. Chromium
// decodes and re-rasterizes the whole background surface every GIF frame, so a
// GIF stored larger than the display costs CPU for nothing
// (docs/custom-background-performance-audit.md). An adopted (or previously
// stored) oversized GIF gets a bounded-resolution animated derivative, and every
// animated GIF also gets a small static "poster" frame for the Settings
// preview. Derivatives are generated once, cached next to their source, and
// invalidated when the source changes. Originals are never modified or deleted
// except when the user replaces/removes the background.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SETTINGS_KEY = "background-settings";
// Opacity semantics: the slider is SURFACE OPACITY (percent). Higher = more
// solid/readable. Transparency = 100 - opacity. The floor keeps text readable
// over busy images; the ceiling equals fully solid surfaces.
const MIN_OPACITY = 40;
const MAX_OPACITY = 100;
const DEFAULT_OPACITY = 85;
const MAX_FILE_BYTES = 10 * 1024 * 4096;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".ico"]);

// Longest edge of a *rendered* background asset. Animated GIFs are the only
// format that decodes every frame continuously, so this applies to animated
// GIFs only. 1920 is an initial engineering trade-off grounded in the audit's
// measurements (decode cost rose ~48 -> 145 -> 282 ms per 3 s for 1280 -> 1920
// -> 3840-wide GIFs). Adjust here only; static images are intentionally left
// untouched.
const MAX_RENDER_DIMENSION = 1920;
// Longest edge of the static Settings thumbnail. Small enough to be free.
const PREVIEW_DIMENSION = 512;
const DERIVED_DIRNAME = "derived";

function backgroundsDirectory() {
	return path.join(require("./configStore").getConfig().appDataDirectory, "backgrounds");
}

// Derivatives live in a subdirectory: distinguishable from originals, never
// eligible as a stored source (resolveStoredImage requires a direct child), and
// safe to prune wholesale.
function derivedDirectory() {
	return path.join(backgroundsDirectory(), DERIVED_DIRNAME);
}

const baseNameOf = (filePath) => path.basename(filePath, path.extname(filePath));
const boundedGifPathFor = (originalPath) => path.join(derivedDirectory(), `${baseNameOf(originalPath)}.bounded.gif`);
const posterPathFor = (originalPath) => path.join(derivedDirectory(), `${baseNameOf(originalPath)}.poster.png`);

function normalizeOpacity(value) {
	if (value === undefined || value === null || value === "") return DEFAULT_OPACITY;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error("Surface opacity must be a number.");
	const rounded = Math.round(parsed);
	if (rounded < MIN_OPACITY || rounded > MAX_OPACITY)
		throw new Error(`Surface opacity must be between ${MIN_OPACITY} and ${MAX_OPACITY}.`);
	return rounded;
}

function normalizeSettings(input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid background settings.");
	const settings = { imagePath: null, opacity: DEFAULT_OPACITY };
	if (input.imagePath !== undefined && input.imagePath !== null) {
		if (typeof input.imagePath !== "string" || !path.isAbsolute(input.imagePath))
			throw new Error("Invalid background image path.");
		settings.imagePath = input.imagePath;
	}
	if (input.opacity !== undefined) settings.opacity = normalizeOpacity(input.opacity);
	return settings;
}

function readSettingsRow() {
	const { db } = require("./db");
	const row = db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(SETTINGS_KEY);
	if (!row) return { imagePath: null, opacity: DEFAULT_OPACITY };
	try {
		return normalizeSettings(JSON.parse(row.value_json));
	} catch {
		return { imagePath: null, opacity: DEFAULT_OPACITY };
	}
}

function writeSettingsRow(settings) {
	const { db } = require("./db");
	db.prepare(
		"INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
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
		if (typeof imagePath !== "string" || !path.isAbsolute(imagePath) || imagePath.includes("\0"))
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

// A derivative is reusable when it exists and is at least as new as its source.
// Managed originals are immutable (fresh UUID per adoption), so this is a
// conservative freshness check rather than a content hash.
function isFreshArtifact(originalPath, artifactPath) {
	try {
		const source = fs.statSync(originalPath);
		const artifact = fs.statSync(artifactPath);
		return artifact.isFile() && artifact.size > 0 && artifact.mtimeMs >= source.mtimeMs;
	} catch {
		return false;
	}
}

// Cheap, synchronous existence check used by the non-generating paths
// (opacity changes, removal). Never triggers processing. `animated` here is a
// best-effort signal (a poster only exists for a source positively identified as
// animated); the authoritative value comes from getBackgroundSettings.
function existingArtifacts(imagePath) {
	if (!imagePath || path.extname(imagePath).toLowerCase() !== ".gif") {
		return { renderPath: null, previewPath: null, animated: false };
	}
	const bounded = boundedGifPathFor(imagePath);
	const poster = posterPathFor(imagePath);
	const renderPath = isFreshArtifact(imagePath, bounded) ? bounded : null;
	const previewPath = isFreshArtifact(imagePath, poster) ? poster : null;
	return { renderPath, previewPath, animated: Boolean(previewPath) };
}

function removeArtifacts(originalPath) {
	if (!originalPath) return;
	unlinkQuietly(boundedGifPathFor(originalPath));
	unlinkQuietly(posterPathFor(originalPath));
}

// Removes derived files that no longer belong to the active source. The derived
// directory is exclusively managed here, so this never touches originals or
// unrelated data. In-flight writes use *.tmp names and are skipped.
//
// The keep-set is derived from the *current stored record*, never from a caller
// argument: a slower stale generation must not be able to prune the derivatives
// of a newer selection (see the replacement race in the tests).
function pruneDerived(keepOriginalPath) {
	let entries;
	try {
		entries = fs.readdirSync(derivedDirectory());
	} catch {
		return;
	}
	const keepBase = keepOriginalPath ? baseNameOf(keepOriginalPath) : null;
	for (const name of entries) {
		if (name.endsWith(".tmp")) continue;
		if (keepBase && name.startsWith(`${keepBase}.`)) continue;
		unlinkQuietly(path.join(derivedDirectory(), name));
	}
}

function pruneDerivedForActiveSource() {
	let keep = null;
	try {
		keep = resolveStoredImage(readSettingsRow().imagePath);
	} catch {
		keep = null;
	}
	pruneDerived(keep);
}

// Runs `produce(tempPath)` and atomically renames the result onto `outputPath`.
// Concurrent requests for the same output share one run. Failures return null
// (the caller falls back to the original source) and never leave a temp file.
const inFlight = new Map();

function generateArtifact(outputPath, produce) {
	const pending = inFlight.get(outputPath);
	if (pending) return pending;
	const run = (async () => {
		const tempPath = `${outputPath}.${randomUUID()}.tmp`;
		try {
			await fsp.mkdir(derivedDirectory(), { recursive: true });
			await produce(tempPath);
			await fsp.rename(tempPath, outputPath);
			return outputPath;
		} catch {
			await fsp.rm(tempPath, { force: true }).catch(() => {});
			return null;
		} finally {
			inFlight.delete(outputPath);
		}
	})();
	inFlight.set(outputPath, run);
	return run;
}

// Ensures the render/preview derivatives for one source exist. Returns
// { renderPath, previewPath, animated }; a null path means the caller uses the
// original, and `animated` tells the renderer whether the painted asset will
// keep decoding frames (used to drop per-frame compositor effects).
// Non-GIF, single-frame GIF, under-cap, and unavailable-processor cases all
// resolve to null without generating anything.
async function ensureArtifacts(imagePath) {
	if (!imagePath || path.extname(imagePath).toLowerCase() !== ".gif") {
		return { renderPath: null, previewPath: null, animated: false };
	}
	// eslint-disable-next-line global-require
	const processor = require("./gifProcessor");
	if (!processor.isAvailable()) return { renderPath: null, previewPath: null, animated: false };

	let info;
	try {
		info = await processor.readGifInfo(imagePath);
	} catch {
		return { renderPath: null, previewPath: null, animated: false };
	}
	if (!info || !info.animated) return { renderPath: null, previewPath: null, animated: false };

	let renderPath = null;
	if (info.longEdge > MAX_RENDER_DIMENSION) {
		const bounded = boundedGifPathFor(imagePath);
		if (isFreshArtifact(imagePath, bounded)) {
			renderPath = bounded;
		} else {
			renderPath = await generateArtifact(bounded, (tempPath) =>
				processor.boundGif({ input: imagePath, output: tempPath, maxDimension: MAX_RENDER_DIMENSION }));
		}
	}

	let previewPath = null;
	const poster = posterPathFor(imagePath);
	if (isFreshArtifact(imagePath, poster)) {
		previewPath = poster;
	} else {
		// Prefer the (smaller) bounded derivative as the poster source.
		previewPath = await generateArtifact(poster, (tempPath) =>
			processor.writePosterFrame({ input: renderPath || imagePath, output: tempPath, maxDimension: PREVIEW_DIMENSION }));
	}

	return { renderPath, previewPath, animated: true };
}

// Full settings, including the derivative paths used for rendering. Async
// because a previously stored oversized GIF may need its derivative generated
// on first load. The renderer awaits this off the render path.
async function getBackgroundSettings() {
	const stored = readSettingsRow();
	const imagePath = resolveStoredImage(stored.imagePath);
	const artifacts = await ensureArtifacts(imagePath);
	pruneDerivedForActiveSource();
	return {
		imagePath,
		renderPath: artifacts.renderPath,
		previewPath: artifacts.previewPath,
		opacity: stored.opacity,
		animated: artifacts.animated,
	};
}

// Opacity is a pure visual property: it must never re-identify or re-process the
// image, so this stays synchronous and only reports already-existing artifacts.
function setBackgroundOpacity(opacity) {
	const stored = readSettingsRow();
	const settings = normalizeSettings({ ...stored, opacity });
	writeSettingsRow(settings);
	const imagePath = resolveStoredImage(settings.imagePath);
	return { imagePath, ...existingArtifacts(imagePath), opacity: settings.opacity };
}

// The displayed limit must match the enforced limit.
const MAX_FILE_LABEL = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB`;

function inspectSourceImage(sourcePath) {
	if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || sourcePath.includes("\0"))
		throw new TypeError("An absolute file path is required.");
	const ext = path.extname(sourcePath).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext))
		throw new Error("Choose a PNG, JPEG, WebP, GIF, AVIF, BMP, or ICO image.");
	const stat = fs.statSync(sourcePath);
	if (!stat.isFile()) throw new Error("The background must be a regular file.");
	if (stat.size > MAX_FILE_BYTES) throw new Error(`Choose an image smaller than ${MAX_FILE_LABEL}.`);
	return ext;
}

async function adoptBackgroundImage(sourcePath) {
	const ext = inspectSourceImage(sourcePath);
	const directory = backgroundsDirectory();
	fs.mkdirSync(directory, { recursive: true });
	const filePath = path.join(directory, `background-${randomUUID()}${ext}`);
	fs.copyFileSync(sourcePath, filePath, fs.constants.COPYFILE_EXCL);
	const previous = readSettingsRow();
	writeSettingsRow({ imagePath: filePath, opacity: previous.opacity });
	// Retire the previous selection (original + its derivatives) immediately.
	if (previous.imagePath && path.resolve(previous.imagePath) !== path.resolve(filePath)) {
		removeArtifacts(previous.imagePath);
		unlinkQuietly(previous.imagePath);
	}
	const artifacts = await ensureArtifacts(filePath);
	pruneDerivedForActiveSource();
	return {
		imagePath: filePath,
		renderPath: artifacts.renderPath,
		previewPath: artifacts.previewPath,
		opacity: previous.opacity,
		animated: artifacts.animated,
	};
}

function removeBackgroundImage() {
	const stored = readSettingsRow();
	writeSettingsRow({ imagePath: null, opacity: stored.opacity });
	if (stored.imagePath) {
		removeArtifacts(stored.imagePath);
		unlinkQuietly(stored.imagePath);
	}
	pruneDerivedForActiveSource();
	return { imagePath: null, renderPath: null, previewPath: null, opacity: stored.opacity, animated: false };
}

module.exports = {
	SETTINGS_KEY,
	MIN_OPACITY,
	MAX_OPACITY,
	DEFAULT_OPACITY,
	MAX_FILE_BYTES,
	MAX_FILE_LABEL,
	IMAGE_EXTENSIONS,
	MAX_RENDER_DIMENSION,
	PREVIEW_DIMENSION,
	DERIVED_DIRNAME,
	backgroundsDirectory,
	derivedDirectory,
	boundedGifPathFor,
	posterPathFor,
	normalizeOpacity,
	normalizeSettings,
	getBackgroundSettings,
	setBackgroundOpacity,
	adoptBackgroundImage,
	removeBackgroundImage,
};
