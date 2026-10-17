"use strict";

// Animated-GIF bounding for custom backgrounds.
//
// Why this exists: Chromium decodes and re-rasterizes the entire background
// surface on every animated-GIF frame, so a GIF stored larger than the display
// is pure waste. The controlled audit (docs/custom-background-performance-audit.md)
// measured decode/raster work scaling with native pixel dimensions, not file
// size. This module produces a bounded-resolution animated derivative while
// preserving animation.
//
// The image library is `sharp` (libvips). It is loaded lazily and treated as
// optional: if the native module cannot be loaded, callers degrade gracefully to
// the original asset instead of failing to render the app.
//
// Correctness contract (verified by tests against real multi-frame fixtures):
// frame count, per-frame delays, loop count, transparency, and
// disposal/compositing are preserved; aspect ratio is preserved; the image is
// never cropped; animation is never collapsed to a single frame.

let cachedSharp;

function loadSharp() {
	if (cachedSharp !== undefined) return cachedSharp;
	try {
		// eslint-disable-next-line global-require
		cachedSharp = require("sharp");
	} catch {
		cachedSharp = null;
	}
	return cachedSharp;
}

function isAvailable() {
	return loadSharp() !== null;
}

// Header-only inspection: dimensions, frame count, animation flag.
async function readGifInfo(input) {
	const sharp = loadSharp();
	if (!sharp) return null;
	const meta = await sharp(input, { animated: true }).metadata();
	const width = Math.max(0, meta.width || 0);
	// For a multi-page image sharp reports the *stacked* height; pageHeight is a
	// single frame. A single-frame GIF has no pageHeight.
	const height = Math.max(0, meta.pageHeight || meta.height || 0);
	const pages = Math.max(1, meta.pages || 1);
	return { width, height, pages, animated: pages > 1, longEdge: Math.max(width, height) };
}

// Scales the longer edge down to `maxDimension`, never up. Aspect ratio is kept
// (each edge is rounded from the same factor, so a pixel of distortion at most).
function targetSize(width, height, maxDimension) {
	const longEdge = Math.max(width, height);
	if (longEdge <= maxDimension) return { width, height, scaled: false };
	const factor = maxDimension / longEdge;
	return {
		width: Math.max(1, Math.round(width * factor)),
		height: Math.max(1, Math.round(height * factor)),
		scaled: true,
	};
}

// Writes a bounded-resolution animated GIF. Returns the target size, or null when
// the asset is not an animated GIF or is already within bounds.
async function boundGif({ input, output, maxDimension }) {
	const sharp = loadSharp();
	if (!sharp) return null;
	const info = await readGifInfo(input);
	if (!info || !info.animated) return null;
	const size = targetSize(info.width, info.height, maxDimension);
	if (!size.scaled) return null;
	await sharp(input, { animated: true })
		.resize({ width: size.width, height: size.height, fit: "fill", withoutEnlargement: true })
		// `effort` raises the palette/quantisation quality; delays and loop are
		// carried over from the input metadata by libvips.
		.gif({ effort: 7 })
		.toFile(output);
	return { width: size.width, height: size.height };
}

// Writes a small static PNG of the first frame, used for the Settings thumbnail
// so the preview never runs a second full-resolution animation. Transparency is
// preserved (PNG supports alpha).
async function writePosterFrame({ input, output, maxDimension }) {
	const sharp = loadSharp();
	if (!sharp) return null;
	await sharp(input, { page: 0 })
		.resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
		.png()
		.toFile(output);
	return true;
}

module.exports = {
	isAvailable,
	readGifInfo,
	targetSize,
	boundGif,
	writePosterFrame,
};
