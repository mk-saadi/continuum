"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { exec } = require("node:child_process");
const { db } = require("../db");
const { requiresConfirmation } = require("../safetyGuards");

const IGNORED = new Set(["node_modules", ".git", "dist", "build"]);
const string = (description) => ({ type: "string", description });
const define = (name, description, properties, required = []) => ({
	type: "function",
	function: {
		name,
		description,
		parameters: { type: "object", properties, required, additionalProperties: false },
	},
});
const agentTools = [
	define(
		"get_recent_chat_history",
		"Retrieve recent dialogue across all chat sessions and projects, newest first. Search uses any keyword; if nothing matches, returns recent messages instead.",
		{
			query: string("Optional short, broad 1-2 word keywords"),
			limit: {
				type: "number",
				default: 10,
				description: "Positive integer number of recent messages to return",
			},
			exclude_current_session: {
				type: "boolean",
				default: true,
				description: "Exclude messages from the active session",
			},
		},
	),
	define(
		"delegate_task",
		"Delegates a targeted research task to a background sub-agent. Important: Keep delegated tasks scoped to a single file, function, or specific feature. For broad codebase reviews, execute multiple scoped delegate_task calls sequentially or read files directly.",
		{
			task_description: string("Specific research or analysis task"),
			target_files: { type: "array", items: string("Project-relative text file path"), maxItems: 32 },
		},
		["task_description", "target_files"],
	),
	define(
		"execute_command",
		"Run a shell command with a 45-second timeout. Output preserves the beginning and error tail.",
		{ command: string("Shell command"), cwd: string("Working directory; defaults to the project root") },
		["command"],
	),
	define(
		"str_replace_editor",
		"Replace exactly one contiguous block of complete lines in a project file, ignoring leading/trailing whitespace and carriage returns when matching. Include surrounding lines to make the match unique.",
		{
			relative_path: string("Project-relative file path"),
			old_str: string("Complete lines to replace; blank lines and internal spacing must match"),
			new_str: string("Replacement text, written verbatim"),
		},
		["relative_path", "old_str", "new_str"],
	),
	define(
		"search_project_content",
		"Search project text files using a regex (invalid regex falls back to literal text). Returns at most 20 matching lines.",
		{
			query: string("Regex or keyword"),
			relative_path: string("Optional project-relative path or absolute app/temp path"),
		},
		["query"],
	),
	define(
		"take_screenshot",
		"Capture a display as a PNG image for vision. In a project, also saves it under .llm_workspace/screenshots and returns file_path. Defaults to the primary screen, with an app-window fallback.",
		{ display_id: string("Optional display ID") },
	),
	define(
		"read_project_file",
		"Read project files or app/temp attachments. Images return vision content; PDFs return extracted text. Large text is truncated.",
		{
			relative_path: string(
				"Project-relative path or absolute path within the project, app userData, or OS temp directory",
			),
		},
		["relative_path"],
	),
	define(
		"write_project_file",
		"Write UTF-8 content to a project file, creating parent directories as needed.",
		{ relative_path: string("Project-relative file path"), content: string("Complete file content") },
		["relative_path", "content"],
	),
	define("list_directory", "List entries in a project directory (up to 200 entries).", {
		relative_path: string("Project-relative directory or absolute app/temp directory; defaults to root"),
	}),
];

function requireText(value, name, empty = false) {
	if (typeof value !== "string" || value.includes("\0") || (!empty && !value.trim()))
		throw new Error(`Invalid ${name}.`);
	return value;
}

const HISTORY_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"and",
	"or",
	"to",
	"of",
	"in",
	"on",
	"for",
	"it",
	"this",
	"that",
	"i",
	"you",
	"we",
]);
function getRecentChatHistory({ query, limit = 10, exclude_current_session = true }, sessionId) {
	if (query !== undefined) requireText(query, "query", true);
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer.");
	if (typeof exclude_current_session !== "boolean")
		throw new Error("exclude_current_session must be a boolean.");
	if (sessionId != null) requireText(sessionId, "sessionId");
	const keywords = [
		...new Set(
			(query?.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(
				(word) => !HISTORY_STOP_WORDS.has(word),
			),
		),
	];
	const baseSql = `SELECT m.id, m.session_id, COALESCE(NULLIF(s.title, ''), 'Untitled chat') AS session_title,
      m.role, m.content, m.created_at
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE (:exclude_current_session = 0 OR :session_id IS NULL OR m.session_id != :session_id)
      AND m.role IN ('user', 'assistant') AND TRIM(m.content) != ''`;
	const params = {
		exclude_current_session: Number(exclude_current_session),
		session_id: sessionId ?? null,
		limit,
	};
	const order = " ORDER BY m.created_at DESC, m.id DESC LIMIT :limit";
	if (keywords.length) {
		const searchParams = { ...params };
		const conditions = keywords.map((word, index) => {
			searchParams[`keyword${index}`] = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
			return `LOWER(m.content) LIKE :keyword${index} ESCAPE '\\'`;
		});
		const matches = db.prepare(`${baseSql} AND (${conditions.join(" OR ")})${order}`).all(searchParams);
		if (matches.length) return matches;
	}
	return db.prepare(baseSql + order).all(params);
}
function sessionRoot(sessionId) {
	requireText(sessionId, "sessionId");
	const row = db
		.prepare(
			`SELECT projects.root_path FROM sessions JOIN projects ON projects.id = sessions.project_id WHERE sessions.id = ?`,
		)
		.get(sessionId);
	if (!row?.root_path) throw new Error("This session needs a project with a root_path.");
	return row.root_path;
}
function hasProjectWorkspace(sessionId) {
	if (!sessionId) return false;
	return !!db
		.prepare("SELECT p.root_path FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?")
		.get(sessionId)?.root_path;
}
function inside(root, target) {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
// Check lexical traversal and every existing ancestor, including dangling symlinks.
async function scopedPath(root, relative = ".", allowAbsolute = false) {
	requireText(relative, "relative_path");
	if (!allowAbsolute && path.isAbsolute(relative)) throw new Error("Use a project-relative path.");
	const target = path.resolve(root, relative);
	if (!inside(root, target)) throw new Error("Path escapes the project root.");
	let current = root;
	for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			await fs.lstat(current);
		} catch (error) {
			if (error.code === "ENOENT") break;
			throw error;
		}
		const real = await fs.realpath(current);
		if (!inside(root, real)) throw new Error("Symlink escapes the project root.");
	}
	return target;
}

/** Read whitelist only. Editing and command working directories still use scopedPath. */
async function isPathAllowed(targetPath, projectRoot) {
	if (typeof targetPath !== "string" || !path.isAbsolute(targetPath) || targetPath.includes("\0"))
		return false;
	const roots = [projectRoot, require("electron").app.getPath("userData"), os.tmpdir()].filter(Boolean);
	const lexical = path.resolve(targetPath);
	try {
		const canonical = await fs.realpath(lexical);
		const allowedRoots = [];
		for (const root of roots) {
			try {
				allowedRoots.push({ lexical: path.resolve(root), canonical: await fs.realpath(root) });
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		return (
			allowedRoots.some((root) => inside(root.lexical, lexical) || inside(root.canonical, lexical)) &&
			allowedRoots.some((root) => inside(root.canonical, canonical))
		);
	} catch {
		return false;
	}
}

async function readablePath(root, relative) {
	requireText(relative, "relative_path");
	// Relative paths retain project-only semantics; external attachments use absolute paths.
	const target = path.isAbsolute(relative) ? relative : await scopedPath(root, relative);
	if (!(await isPathAllowed(target, root)))
		throw new Error(
			"Read path is outside the project, app userData, or temp directories, or does not exist.",
		);
	return fs.realpath(target);
}

let screenshotTimestamp = 0;
let screenshotWrites = Promise.resolve();
async function saveScreenshot(root, png) {
	const save = screenshotWrites.then(async () => {
		const directory = await scopedPath(root, ".llm_workspace/screenshots");
		await fs.mkdir(directory, { recursive: true });
		const ignorePath = await scopedPath(root, ".gitignore");
		try {
			const ignore = await fs.readFile(ignorePath, "utf8");
			if (!ignore.split(/\r?\n/).some((line) => /^\/?\.llm_workspace\/$/.test(line.trim()))) {
				const newline = ignore.includes("\r\n") ? "\r\n" : "\n";
				// r+ avoids creating .gitignore when one does not exist.
				const file = await fs.open(ignorePath, "r+");
				try {
					await file.write(
						`${ignore && !ignore.endsWith("\n") ? newline : ""}.llm_workspace/${newline}`,
						Buffer.byteLength(ignore),
					);
				} finally {
					await file.close();
				}
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		screenshotTimestamp = Math.max(Date.now(), screenshotTimestamp + 1);
		const filePath = await scopedPath(
			root,
			`.llm_workspace/screenshots/screenshot_${screenshotTimestamp}.png`,
		);
		await fs.writeFile(filePath, png, { flag: "wx" });
		return filePath;
	});
	screenshotWrites = save.catch(() => {});
	return save;
}

function truncateOutput(stdout, stderr = "") {
	if (stdout.length + stderr.length <= 2500) return { stdout, stderr };
	const lines = [
		...(stdout ? stdout.split("\n").map((text) => ({ stream: "stdout", text })) : []),
		...(stderr ? stderr.split("\n").map((text) => ({ stream: "stderr", text })) : []),
	];
	// The requested line windows can exceed 2,500 characters; never overlap them.
	if (lines.length <= 65) return { stdout, stderr };
	const marker = {
		stream: lines[5].stream,
		text: `[... Outputs ${lines.length - 65} lines truncated to save context space ...]`,
	};
	const retained = [...lines.slice(0, 5), marker, ...lines.slice(-60)];
	return Object.fromEntries(
		["stdout", "stderr"].map((stream) => [
			stream,
			retained
				.filter((line) => line.stream === stream)
				.map((line) => line.text)
				.join("\n"),
		]),
	);
}
function executeCommand(args, cwd, signal) {
	requireText(args.command, "command");
	return new Promise((resolve) => {
		exec(
			args.command,
			{ cwd, timeout: 45000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") stderr += `\nCommand failed: ${error.message}`;
				resolve({
					...truncateOutput(stdout, stderr),
					exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
				});
			},
		);
	});
}
async function screenshot({ display_id }, sessionId) {
	const { desktopCapturer, screen, BrowserWindow } = require("electron");
	if (display_id !== undefined) requireText(display_id, "display_id");
	const display =
		display_id === undefined
			? screen.getPrimaryDisplay()
			: screen.getAllDisplays().find((item) => String(item.id) === display_id);
	if (!display) throw new Error("Display not found.");
	const sources = await desktopCapturer.getSources({
		types: ["screen", "window"],
		thumbnailSize: {
			width: Math.round(display.size.width * display.scaleFactor),
			height: Math.round(display.size.height * display.scaleFactor),
		},
	});
	const appIds = new Set(BrowserWindow.getAllWindows().map((window) => window.getMediaSourceId()));
	const source =
		sources.find((item) => item.id.startsWith("screen:") && item.display_id === String(display.id)) ||
		(display_id === undefined && sources.find((item) => appIds.has(item.id)));
	if (!source || source.thumbnail.isEmpty())
		throw new Error("Screenshot unavailable. Check screen capture permissions.");
	const png = source.thumbnail.toPNG();
	const root = hasProjectWorkspace(sessionId) ? await fs.realpath(sessionRoot(sessionId)) : null;
	const filePath = root ? await saveScreenshot(root, png) : null;
	return {
		...(filePath ? { file_path: filePath } : {}),
		type: "image_url",
		image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
	};
}
async function searchContent(root, args, signal) {
	requireText(args.query, "query");
	let regex;
	try {
		regex = new RegExp(args.query);
	} catch {
		/* Treat invalid regex as a keyword. */
	}
	const matches = [];
	const start = await readablePath(root, args.relative_path ?? ".");
	async function visit(target) {
		signal?.throwIfAborted();
		if (
			matches.length >= 20 ||
			path
				.relative(root, target)
				.split(path.sep)
				.some((part) => IGNORED.has(part))
		)
			return;
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink()) return;
		if (!(await isPathAllowed(target, root)))
			throw new Error("Search path is outside allowed directories.");
		if (stat.isDirectory()) {
			for (const entry of await fs.readdir(target)) {
				if (matches.length >= 20) break;
				await visit(path.join(target, entry));
			}
		} else if (stat.isFile()) {
			const bytes = await fs.readFile(target);
			if (bytes.includes(0)) return;
			const lines = bytes.toString("utf8").split(/\r?\n/);
			for (let index = 0; index < lines.length && matches.length < 20; index++) {
				const line = lines[index];
				const match = regex ? regex.exec(line) : null;
				const offset = regex ? (match?.index ?? -1) : line.indexOf(args.query);
				if (offset >= 0)
					matches.push({
						file_path: inside(root, target) ? path.relative(root, target) : target,
						line_number: index + 1,
						snippet: line.slice(Math.max(0, offset - 100), Math.max(0, offset - 100) + 500),
					});
			}
		}
	}
	await visit(start);
	return { matches };
}
async function executeStrReplaceEditor(target, { old_str, new_str }) {
	requireText(old_str, "old_str", true);
	requireText(new_str, "new_str", true);
	if (!old_str)
		throw new Error("old_str must not be empty. Provide surrounding lines to identify a unique block.");

	const content = await fs.readFile(target, "utf8");
	const lines = content.split("\n");
	const normalize = (line) => line.replace(/\r/g, "").trim();
	const normalizedLines = lines.map(normalize);
	const oldLines = old_str.split("\n").map(normalize);
	let match = -1;
	for (let start = 0; start <= lines.length - oldLines.length; start++) {
		if (!oldLines.every((line, offset) => line === normalizedLines[start + offset])) continue;
		if (match !== -1) {
			throw new Error(
				"old_str is not unique after whitespace normalization. Provide more surrounding lines for uniqueness.",
			);
		}
		match = start;
	}
	if (match === -1) {
		throw new Error(
			"old_str was not found after whitespace normalization. Provide complete surrounding lines; blank lines and internal spacing must match.",
		);
	}

	// Use original offsets so surrounding text and mixed line endings stay intact.
	let start = 0;
	for (let index = 0; index < match; index++) start += lines[index].length + 1;
	const last = match + oldLines.length - 1;
	let end = start;
	for (let index = match; index < last; index++) end += lines[index].length + 1;
	end += lines[last].length;
	// The final line separator belongs to the surrounding content.
	if (last < lines.length - 1 && lines[last].endsWith("\r")) end--;
	await fs.writeFile(target, content.slice(0, start) + new_str + content.slice(end), "utf8");
	return { success: true };
}

async function executeAgentTool({ name, arguments: rawArguments, sessionId, signal, engine }) {
	try {
		const definition = agentTools.find((tool) => tool.function.name === name)?.function;
		if (!definition) throw new Error("Unknown agent tool.");
		const args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
		if (!args || typeof args !== "object" || Array.isArray(args))
			throw new Error("Tool arguments must be an object.");
		if (Object.keys(args).some((key) => !Object.hasOwn(definition.parameters.properties, key)))
			throw new Error("Unexpected tool argument.");
		for (const key of definition.parameters.required)
			if (!Object.hasOwn(args, key)) throw new Error(`Missing ${key}.`);
		signal?.throwIfAborted();
		if (name === "get_recent_chat_history") return getRecentChatHistory(args, sessionId);
		if (name === "take_screenshot") return await screenshot(args, sessionId);
		const root = await fs.realpath(sessionRoot(sessionId));
		if (!(await fs.stat(root)).isDirectory()) throw new Error("Project root is not a directory.");
		if (name === "delegate_task")
			return await require("../subAgentRunner").runSubAgent({
				...args,
				rootPath: root,
				engine,
				signal,
			});
		if (name === "execute_command") {
			if (requiresConfirmation(args.command)) {
				return {
					success: false,
					error: "This command looks like an unscoped or broad database mutation. Run a read-only count/preview of what it would affect first, then either re-run scoped to specific _ids, or ask the user to confirm before proceeding.",
				};
			}
			return await executeCommand(args, await scopedPath(root, args.cwd ?? ".", true), signal);
		}
		if (name === "search_project_content") return await searchContent(root, args, signal);
		const target = await (
			["read_project_file", "list_directory"].includes(name) ? readablePath : scopedPath
		)(root, args.relative_path ?? ".");
		if (name === "list_directory") {
			const entries = await fs.readdir(target, { withFileTypes: true });
			return {
				entries: entries.slice(0, 200).map((entry) => ({
					name: entry.name,
					type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
				})),
				omitted: Math.max(0, entries.length - 200),
			};
		}
		if (name === "read_project_file") {
			if (!(await fs.stat(target)).isFile()) throw new Error("Read target must be a regular file.");
			const bytes = await fs.readFile(target);
			const mime = {
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".webp": "image/webp",
				".gif": "image/gif",
			}[path.extname(target).toLowerCase()];
			if (mime)
				return {
					file_path: target,
					type: "image_url",
					image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
				};
			const content = await require("../ragManager").parseDocument(target, bytes);
			if (content.includes("\0")) throw new Error("Unsupported binary file.");
			return {
				content: content.length > 20000 ? `${content.slice(0, 20000)}\n[Output truncated]` : content,
			};
		}
		if (name === "write_project_file") {
			requireText(args.content, "content", true);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, args.content, "utf8");
			return { success: true };
		}
		return await executeStrReplaceEditor(target, args);
	} catch (error) {
		return { success: false, error: error.message };
	}
}

module.exports = {
	agentTools,
	executeAgentTool,
	getRecentChatHistory,
	hasProjectWorkspace,
	truncateOutput,
	scopedPath,
	isPathAllowed,
	screenshot,
};
