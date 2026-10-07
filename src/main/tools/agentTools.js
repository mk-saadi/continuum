"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { resolveSubAgentPath, fileNotFound } = require('../pathUtils');
const { exec, execFile } = require("node:child_process");
const { db } = require("../db");
const { approvedMutations } = require("../safetyGuards");
const { spawnSubagentTool, executeSpawnSubagent } = require('./subagent');

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
	define('use_skill', 'Load the full instructions of a skill enabled for this project when its purpose matches the current task.', {
		name: string('Skill ID from the available project skills index'),
		file: string('Optional relative path to a supporting text file inside the skill folder'),
	}, ['name']),
	define('propose_skill', 'Suggest a reusable workflow as a Skill. This only presents a proposal to the user; it never saves the Skill automatically.', {
		name: string('Lowercase skill ID using letters, numbers, hyphens, or underscores'),
		description: string('One-line summary of when this skill is useful'),
		instructions: string('Complete reusable instructions in Markdown'),
	}, ['name', 'description', 'instructions']),
	define(
		"manage_mcp_servers",
		"Enable, disable, or restart installed MCP servers for this chat. Enabling or restarting makes their tool schemas available on the next model turn.",
		{
			action: { type: "string", enum: ["enable", "disable", "restart"] },
			server_names: { type: "array", items: string("Installed MCP server name"), minItems: 1, maxItems: 20 },
		},
		["action", "server_names"],
	),
	define(
		"approve_mcp_mutation",
		"Approve one MCP mutation attempt using the hash from a SAFETY GUARD INTERCEPT. Call only after explaining the exact mutation and receiving explicit user permission, then re-run the same MCP tool with the same arguments.",
		{ hash: { type: "string", pattern: "^[a-f0-9]{16}$", description: "The 16-character SHA-256 payload hash from the intercept message" } },
		["hash"],
	),
	define(
		"get_recent_chat_history",
		"Retrieve up to 10 recent dialogue messages across chats, newest first. Choose a limit from 1 to 10 (default 5). Use search_memory for broader historical searches.",
		{
			query: string("Optional short, broad 1-2 word keywords"),
			limit: {
				type: "number",
				default: 5,
				minimum: 1,
				maximum: 10,
				description: "Number of recent messages to return (1-10)",
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
		"Legacy file delegation with a strict 4,000-character aggregate file limit. Prefer execute_command for local file searches and inspection.",
		{
			task_description: string("Specific research or analysis task"),
			target_files: { type: "array", items: string("Absolute or project-relative text file path"), maxItems: 32 },
		},
		["task_description", "target_files"],
	),
	define(
		"generate_image",
		"Generates or draws an image based on a detailed visual prompt. Enhance and expand short user prompts with vivid lighting, composition, and style details before calling this tool.",
		{ prompt: string("Expanded, highly descriptive visual prompt for the image generator.") },
		["prompt"],
	),
	spawnSubagentTool,
	define(
		"get_single_web_page_content",
		"Fetch a public web page and return readable article text, capped at 12,000 characters.",
		{ url: string("Public HTTP or HTTPS page URL") },
		["url"],
	),
	define(
		"extract_web_page_data",
		"Fetch one public web page and ask an isolated, tool-free sub-agent to answer a specific question in under 500 tokens.",
		{ url: string("Public HTTP or HTTPS page URL"), query: string("Specific question to answer from the page") },
		["url", "query"],
	),
	define(
		"execute_command",
		"Run a shell command with a 45-second timeout. In Workspace Write mode, git and other commands can write only inside the project root. Output preserves the beginning and error tail.",
		{
			command: string("Shell command"),
			cwd: string("Working directory; defaults to the project root"),
			user_confirmed: {
				type: "boolean",
				description: "Legacy field; does not grant permission. Approval is collected through the application UI.",
			},
		},
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
			relative_path: string("Optional absolute or project-relative path"),
		},
		["query"],
	),
	define(
		"take_screenshot",
		"Capture a display as a PNG image for vision, including in Read Only mode. In a project, also saves it under .llm_workspace/screenshots and returns file_path. Defaults to the primary screen, with an app-window fallback.",
		{ display_id: string("Optional display ID") },
	),
	define(
		"read_project_file",
		"Read files by absolute or project-relative path. Images return vision content; PDFs return extracted text. Large text is truncated.",
		{
			relative_path: string(
				"Absolute or project-relative file path",
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
define("list_directory", "List entries in a directory (up to 200 entries).", {
		relative_path: string("Absolute or project-relative directory; defaults to root"),
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
function getRecentChatHistory({ query, limit = 5, exclude_current_session = true }, sessionId) {
	if (query !== undefined) requireText(query, "query", true);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("limit must be an integer from 1 to 10.");
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
      AND m.role IN ('user', 'assistant') AND TRIM(m.content) != ''
    ORDER BY m.id DESC LIMIT :candidateLimit`;
	const params = {
		exclude_current_session: Number(exclude_current_session),
		session_id: sessionId ?? null,
		candidateLimit: keywords.length ? 200 : limit,
	};
	const recent = db.prepare(baseSql).all(params)
		.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
	if (keywords.length) {
		const matches = recent.filter(row => keywords.some(word => row.content.toLowerCase().includes(word)));
		if (matches.length) return matches.slice(0, limit);
	}
	return recent.slice(0, limit);
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

/** Read tools accept any accessible path. Editing and command directories use scopedPath. */
async function isPathAllowed(targetPath) {
	try { await fs.realpath(resolveSubAgentPath(targetPath)); return true; }
	catch { return false; }
}

async function readablePath(root, relative) {
	requireText(relative, "relative_path");
	const target = resolveSubAgentPath(relative, root);
	try { return await fs.realpath(target); }
	catch (error) {
		if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw fileNotFound(target);
		throw error;
	}
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
function executeCommand(args, cwd, signal, workspaceRoot) {
	requireText(args.command, "command");
	return new Promise((resolve) => {
        const run = workspaceRoot
            ? (command, options, done) => {
                if (process.platform !== 'linux') return done(new Error('Workspace shell sandbox is unavailable on this platform. Use Ask for Approval or Full Access.'), '', '');
                // Filesystem isolation is the security boundary. Unsharing the
                // network namespace fails on some desktop/container kernels and
                // prevents even local git commands from starting.
                execFile('bwrap', ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
                    '--ro-bind', '/', '/', '--bind', workspaceRoot, workspaceRoot, '--proc', '/proc', '--dev', '/dev',
                    '--chdir', cwd, '/bin/sh', '-c', command], options, done);
            }
            : exec;
        run(
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

async function executeAgentTool({ name, arguments: rawArguments, sessionId, signal, engine, permissionMode, permissionGranted = false, rootPath }) {
	try {
		const definition = agentTools.find((tool) => tool.function.name === name)?.function;
		if (!definition) throw new Error("Unknown agent tool.");
		const args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
		if (!args || typeof args !== "object" || Array.isArray(args))
			throw new Error("Tool arguments must be an object.");
		if (name === 'spawn_sub_agent' && Object.hasOwn(args, 'target_files'))
			throw new Error("Do NOT use sub-agents for file inspection. Use 'execute_command' with 'grep -n', 'ripgrep', or 'sed' to query local files directly.");
		if (Object.keys(args).some((key) => !Object.hasOwn(definition.parameters.properties, key)))
			throw new Error("Unexpected tool argument.");
		for (const key of definition.parameters.required)
			if (!Object.hasOwn(args, key)) throw new Error(`Missing ${key}.`);
        if (name === 'propose_skill') {
            if (!require('../skillsManager').validId(args.name) || typeof args.description !== 'string' || !args.description.trim() ||
                typeof args.instructions !== 'string' || !args.instructions.trim() || args.instructions.length > 200000)
                throw new Error('Invalid skill proposal.');
            return { success: true, proposed: true, message: 'Skill proposal sent for user review. No skill was saved.' };
        }
        if (name === 'use_skill') {
            const projectId = require('../db').db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id;
            const skill = require('../skillsManager').activeProjectSkills(projectId).find(item => item.id === args.name);
            if (!skill) throw new Error('Skill is not active for this project.');
            return args.file
                ? { name: skill.id, file: args.file, content: require('../skillsManager').readSkillFile(skill.id, args.file) }
                : { name: skill.id, instructions: skill.instructions };
        }
        const { guardTool, resolveMode, sessionProject } = require('../toolPermissions');
        const project = sessionProject(sessionId);
        permissionMode = resolveMode(permissionMode, project);
        if (!permissionGranted) await guardTool({ name, args, permissionMode, project, signal });
        const unrestricted = permissionMode === 'full_access' || permissionMode === 'ask_approval';
		signal?.throwIfAborted();
		if (name === "manage_mcp_servers") {
			if (require('../configManager').getAppSettings().mcpMode === 'manual')
				throw new Error('MCP server management is disabled in Manual Mode.');
			return await require("../mcpManager").manageServers(args.action, args.server_names, sessionId);
		}
		if (name === "approve_mcp_mutation") {
			if (typeof args.hash !== "string" || !/^[a-f0-9]{16}$/.test(args.hash))
				throw new Error("Invalid mutation hash; use the hash from the safety intercept.");
			approvedMutations.add(args.hash);
			return { success: true, hash: args.hash };
		}
		if (name === "get_recent_chat_history") return getRecentChatHistory(args, sessionId);
		if (name === "take_screenshot") return await screenshot(args, sessionId);
		if (name === "get_single_web_page_content") return await require("./webSearch").getSingleWebPageContent({ ...args, signal });
		if (name === "extract_web_page_data") return await require("../subAgentRunner").extractWebPageData({ ...args, engine, signal, parentSessionId: sessionId });
		if (name === "generate_image") return await require("./generateImage").generateImage({ ...args, signal });
		const readingFiles = ['spawn_sub_agent', 'delegate_task', 'read_project_file', 'list_directory', 'search_project_content'].includes(name);
		// rootPath is an explicit root from the delegating caller (the child
		// agent loop passes its execution's project root, since a child session
		// has no database project of its own). It is honored only for read-only
		// tools: writes and commands keep resolving their root from the session
		// project, so this override can never redirect a mutation.
		const root = readingFiles ? path.resolve(rootPath ?? project?.root_path ?? process.cwd())
			: await fs.realpath(project?.root_path ?? (unrestricted ? process.cwd() : sessionRoot(sessionId)));
		if (!readingFiles && !(await fs.stat(root)).isDirectory()) throw new Error("Project root is not a directory.");
		if (name === "spawn_sub_agent")
			return await executeSpawnSubagent({ ...args, rootPath: root, engine, signal, parentSessionId: sessionId });
		if (name === "delegate_task")
			return await require("../subAgentRunner").runSubAgent({
				...args,
				rootPath: root,
				engine,
				signal,
				parentSessionId: sessionId,
			});
		if (name === "execute_command") {

			return await executeCommand(args, (unrestricted ? path.resolve(root, args.cwd ?? ".") : await scopedPath(root, args.cwd ?? ".", true)), signal, permissionMode === 'workspace_write' ? root : undefined);
		}
		if (name === "search_project_content") return await searchContent(root, args, signal);
		const target = ["read_project_file", "list_directory"].includes(name)
			? await readablePath(root, args.relative_path ?? ".")
			: unrestricted ? path.resolve(root, args.relative_path ?? ".") : await scopedPath(root, args.relative_path ?? ".", true);
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
	approvedMutations,
	agentTools,
	executeAgentTool,
	getRecentChatHistory,
	hasProjectWorkspace,
	truncateOutput,
	scopedPath,
	isPathAllowed,
	screenshot,
};
