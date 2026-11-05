'use strict';

// The Continuum renderer's own origin. Development is served by the Vite
// preview (`npm run dev` waits for tcp:5173 before launching Electron);
// production loads the packaged dist/index.html. This module is the single
// source of truth for that URL:
//   * ipcHandlers' trusted-sender check authenticates exactly this origin, and
//   * the system prompt may name it as an inspectable preview only when it is
//     a browsable http(s) origin.
// Nothing user-, model- or network-supplied participates, so guidance can
// never introduce an arbitrary localhost URL.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function rendererOrigin() {
	if (process.env.NODE_ENV === 'development') return 'http://localhost:5173/';
	const { app } = require('electron');
	return pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;
}

/**
 * The authenticated Continuum preview URL the model may inspect with browser
 * tools, or null when this build does not serve a browsable preview.
 */
function authenticatedPreviewUrl() {
	try {
		const origin = rendererOrigin();
		return /^https?:\/\//.test(origin) ? origin : null;
	} catch {
		return null;
	}
}

module.exports = { rendererOrigin, authenticatedPreviewUrl };
