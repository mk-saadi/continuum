"use strict";

const path = require("node:path");
const { validateLocalPath } = require("./localMedia");

// Base directory a chat's relative file references resolve against.
// A session bound to a project resolves against that project's root (the
// workspace the agent itself operated in); a session without one behaves as
// a casual chat and resolves against the working directory the agent's own
// commands run in, so a relative path means the same thing to the message
// renderer as it did to the tool that produced it.
function sessionBaseDirectory(sessionId) {
	if (sessionId) {
		try {
			const row = require("./db")
				.db.prepare(
					"SELECT projects.root_path FROM sessions JOIN projects ON projects.id = sessions.project_id WHERE sessions.id = ?"
				)
				.get(sessionId);
			if (row?.root_path) return row.root_path;
		} catch {
			// A missing or uninitialised database must not break opening a path.
		}
	}
	return process.cwd();
}

function decodeFileUrl(value) {
	try {
		const url = new URL(value);
		if (url.hostname || url.search || url.hash) return null;
		return decodeURIComponent(url.pathname);
	} catch {
		return null;
	}
}

// Turn a markdown link destination into an absolute filesystem path.
// Absolute paths (POSIX and Windows) pass through unchanged; file:// URLs
// are converted; everything else resolves against the chat's base directory.
function resolveChatPath(target, sessionId) {
	if (typeof target !== "string") throw new Error("Expected a file path.");
	const value = target.trim();
	if (!value || value.includes("\0")) throw new Error("Expected a file path.");

	if (value.startsWith("file:")) {
		const converted = decodeFileUrl(value);
		if (!converted) throw new Error("Invalid file path.");
		return validateLocalPath(converted);
	}

	let candidate = value;
	try {
		candidate = decodeURI(value);
	} catch {
		candidate = value;
	}

	if (path.isAbsolute(candidate)) return validateLocalPath(candidate);

	return validateLocalPath(path.resolve(sessionBaseDirectory(sessionId), candidate));
}

module.exports = { resolveChatPath, sessionBaseDirectory };
