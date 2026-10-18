"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { resolveSubAgentPath, fileNotFound } = require('../pathUtils');
const { exec, execFile } = require("node:child_process");
const { db } = require("../db");
const { approvedMutations } = require("../safetyGuards");
const { spawnSubagentTool, executeSpawnSubagent } = require('./subagent');
const recoveryStore = require("../recoveryStore");

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
		"Fetch a public web page or JSON API endpoint and return readable article text or pretty-printed JSON, capped at 12,000 characters. For single pages and API responses only; delegate full-page extraction or multi-page research to spawn_sub_agent or extract_web_page_data instead of pulling raw pages here.",
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
		"web_search",
		"Search the public web and return a short ranked list of results (title, URL, snippet). Discovery only: it never fetches a result page — read a chosen URL with get_single_web_page_content or delegate it to a sub-agent. Requires a search provider configured in Settings.",
		{
			query: string("The search query"),
			max_results: {
				type: "number",
				minimum: 1,
				maximum: 20,
				default: 5,
				description: "Number of results to return (1-20, default 5)",
			},
		},
		["query"],
	),
	define(
		"execute_command",
		"Run a shell command with a 45-second timeout. Contained commands run inside the workspace sandbox and can write only inside the project root; commands that would affect the system outside the workspace request user approval first. Output preserves the beginning and error tail.",
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
		"run_tests",
		"Run a verification command (tests, lint, type-check, or build) and return a structured verdict instead of raw output. Use this before claiming work is complete. `status` is `passed` only when the command exits 0; a nonzero exit is `failed`, an exceeded timeout is `timed_out`, a user interruption is `cancelled`, and a command that never ran (missing tool, no exit status) is `error`. Runs with the same sandbox, approval, workspace, and timeout rules as execute_command.",
		{
			command: string("Verification shell command (for example `npm test`, `pytest`, `cargo test`, or a repository check script)"),
			cwd: string("Working directory; defaults to the project root"),
			timeout_ms: {
				type: "number",
				minimum: 1000,
				maximum: 120000,
				description: "Optional verification timeout in milliseconds (1000-120000); defaults to 45000 like execute_command",
			},
		},
		["command"],
	),
	define(
		"update_plan",
		[
			'Create, update, or read the durable task plan for this Workspace task.',
			'',
			'Action "create" (call ONCE, before starting the work). Exact arguments:',
			'{"action":"create","objective":"<one-line goal>","steps":[{"description":"<first step>"},{"description":"<second step>","status":"in_progress"}]}',
			'- "steps" must be a non-empty array; every step requires a "description". "status" is optional (default "pending"); "note" is optional.',
			'- NEVER include "id" in a step when creating: ids are assigned by the tool and returned in the plan. Including one fails with UNEXPECTED_STEP_ID.',
			'- Create only once. If a plan already exists, create fails with PLAN_EXISTS — call action "get" to read the plan, then use action "update".',
			'',
			'Action "update" (every change after create). Exact arguments:',
			'{"action":"update","steps":[{"id":7,"status":"completed"},{"description":"A newly added step"}],"remove_step_ids":[3]}',
			'- To change an existing step, pass its "id" plus only the fields to change (any of "description", "status", "note").',
			'- To add a step, omit "id" and include "description". To delete steps, list their ids in "remove_step_ids".',
			'- Provide at least one of "steps", "remove_step_ids", or "objective"; an empty update fails with EMPTY_UPDATE.',
			'',
			'Action "get" returns the current plan and its step ids. Call it when resuming, after a restart or context compaction, or whenever you are unsure of the plan or its ids — never re-create the plan and never guess ids.',
			'',
			'"status" is one of pending | in_progress | completed | blocked; a "blocked" step requires a "note" explaining the blocker. Step ids are stable and scoped to this task. "expected_revision" is an optional optimistic guard that fails with STALE_PLAN; recover by calling action "get", then retry.',
			'If a call fails, read the returned "code" and correct the arguments before retrying; do not repeat the same failing call. A plan records intended work and reported progress, not proof of completion — verify finished implementation (for example with run_tests) before marking a step completed.',
		].join("\n"),
		{
			action: {
				type: "string",
				enum: ["create", "update", "get"],
				description: '"create" starts the plan (call it once, first); "update" applies incremental changes after create; "get" returns the current plan and its step ids.',
			},
			objective: string("Optional one-line goal for the task (used with create/update)"),
			steps: {
				type: "array",
				description: 'On "create": the complete ordered step list, each {"description": ...} and no "id". On "update": only the steps to change or add — existing steps by "id", new steps by "description" with "id" omitted.',
				items: {
					type: "object",
					properties: {
						id: {
							type: "integer",
							description: 'Existing step id from create/get (update only). NEVER include "id" when action is "create".',
						},
						description: string("Step text; required on create and when adding a new step on update"),
						status: {
							type: "string",
							enum: ["pending", "in_progress", "completed", "blocked"],
							description: "Current step status (default pending)",
						},
						note: string("Optional concise context; required when status is blocked"),
					},
					required: [],
					additionalProperties: false,
				},
			},
			remove_step_ids: {
				type: "array",
				items: { type: "integer" },
				description: "Step ids to delete in the same update call",
			},
			expected_revision: {
				type: "integer",
				minimum: 1,
				description: 'Optional optimistic guard: fails with STALE_PLAN if the stored revision differs; recover with action "get".',
			},
		},
		["action"],
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
	define(
		"move_project_file",
		"Move or rename a project file or directory. Fails if the destination already exists; create no data, only relocates it.",
		{
			source_path: string("Existing project-relative file or directory path"),
			destination_path: string("New project-relative path; parent directories are created"),
		},
		["source_path", "destination_path"],
	),
	define(
		"delete_project_file",
		"Permanently delete one project file (never a directory, never a symlink). The content is captured for recovery before deletion, so it can be restored. Always asks for confirmation except in Full Access. Fails in Read Only mode, for casual chats without a workspace, and if the file is larger than the recovery capture limit.",
		{
			path: string("Project-relative file path to delete"),
			expected_hash: {
				type: "string",
				pattern: "^[a-f0-9]{64}$",
				description: "Optional SHA-256 of the file's current content; delete only if the content still matches",
			},
		},
		["path"],
	),
	define(
		"edit_project_files",
		"Apply small surgical replacements across one or more project files, all-or-nothing: every edit is validated first (contained path, unique match), then all are written together; if any edit fails validation, nothing is written. Multiple edits may target the same file — they are applied in the order given, so a later edit's old_str is matched against the result of the earlier ones. Use write_project_file for a whole-file rewrite and apply_patch for a unified diff.",
		{
			edits: {
				type: "array",
				description: "1 to 20 surgical replacements, applied in order; several may target the same file",
				items: {
					type: "object",
					properties: {
						relative_path: string("Project-relative file path"),
						old_str: string("Complete lines to replace; blank lines and internal spacing must match"),
						new_str: string("Replacement text, written verbatim"),
					},
					required: ["relative_path", "old_str", "new_str"],
					additionalProperties: false,
				},
				minItems: 1,
				maxItems: 20,
			},
		},
		["edits"],
	),
	define(
		"apply_patch",
		"Apply a unified diff to project files. Validate-all-then-write like edit_project_files: every hunk must match before anything is written. Refuses file deletions and paths escaping the project.",
		{
			patch: string("Unified diff text with ---/+++ file headers and @@ hunks; /dev/null as the --- source creates a file"),
		},
		["patch"],
	),
define("list_directory", "List entries in a directory (up to 200 entries).", {
		relative_path: string("Absolute or project-relative directory; defaults to root"),
	}),
	define("git_status", "Show the git working-tree status for the project: current branch plus staged, unstaged, and untracked files. Read-only; requires a project workspace that is a git repository.", {}),
	define(
		"git_diff",
		"Show uncommitted project changes as a unified diff (truncated at 20,000 characters). Set staged for staged changes only, ref to diff the worktree against a commit, stat_only for the file summary, or relative_path to limit to one file.",
		{
			staged: { type: "boolean", description: "Diff staged changes (git diff --cached) instead of the worktree" },
			ref: string("Optional single commit, branch, or tag to diff against (for example HEAD)"),
			relative_path: string("Optional project-relative file path to limit the diff"),
			stat_only: { type: "boolean", description: "Show the per-file summary instead of the full diff" },
		},
	),
	define(
		"git_log",
		"Show recent project commit history, newest first (at most 50 entries). Read-only; requires a git repository.",
		{
			limit: { type: "number", default: 10, minimum: 1, maximum: 50, description: "Number of commits to return (1-50)" },
			ref: string("Optional single commit, branch, or tag to start from (defaults to HEAD)"),
			relative_path: string("Optional project-relative file path to limit history to"),
		},
	),
	define(
		"git_show",
		"Show one project commit: metadata plus its diff (truncated at 20,000 characters). Use stat_only for the file summary. Read-only.",
		{
			ref: string("Commit hash, branch, or tag to show (for example HEAD or a full hash)"),
			relative_path: string("Optional project-relative file path to limit the diff"),
			stat_only: { type: "boolean", description: "Show the per-file summary instead of the full diff" },
		},
		["ref"],
	),
	define("git_branch", "List project branches with their latest commits and tracking info (git branch -vv --all). Read-only.", {}),
	define(
		"git_stage",
		"Stage explicit project files for the next commit (git add -- paths). Only the listed paths are staged, never everything; use git_status to review first. Paths stay inside the project.",
		{
			paths: {
				type: "array",
				description: "Project-relative file paths to stage (1-50)",
				items: string("Project-relative file path"),
				minItems: 1,
				maxItems: 50,
			},
		},
		["paths"],
	),
	define(
		"git_unstage",
		"Unstage explicit project files without touching worktree content (git restore --staged -- paths). Only the listed paths are unstaged, never everything; the working-tree changes are kept. Paths stay inside the project.",
		{
			paths: {
				type: "array",
				description: "Project-relative file paths to unstage (1-50)",
				items: string("Project-relative file path"),
				minItems: 1,
				maxItems: 50,
			},
		},
		["paths"],
	),
	define(
		"git_commit",
		"Commit already-staged project changes with an explicit message. Stages nothing by itself: stage paths with git_stage first, then commit. Always asks the user for confirmation except in Full Access.",
		{ message: string("Non-empty commit message (at most 2000 characters)") },
		["message"],
	),
	define(
		"git_create_branch",
		"Create a project branch from a ref (defaults to HEAD) and switch to it unless switch is false. Switching refuses when the worktree has staged or unstaged changes; commit or stash first. Branch names only, never detaches.",
		{
			name: string("New branch name: 1-100 characters of letters, digits, ., _, -, / only"),
			start_point: string("Optional single commit, branch, or tag to start from (defaults to HEAD)"),
			switch: { type: "boolean", default: true, description: "Switch to the new branch after creating it" },
		},
		["name"],
	),
	define(
		"git_switch",
		"Switch the project worktree to an existing local branch. Refuses when the worktree has staged or unstaged changes; commit or stash first. Branch names only, never detaches.",
		{
			ref: string("Existing local branch name to switch to"),
		},
		["ref"],
	),
	define(
		"git_sync",
		"Sync the project with a configured remote: fetch new history, fast-forward-pull the current branch, or push it. Pulls never merge or rebase; pushes never force-push and always ask for confirmation except in Full Access.",
		{
			action: { type: "string", enum: ["fetch", "pull", "push"], description: "fetch reads remote history, pull fast-forwards the current branch, push publishes it" },
			remote: string("Configured remote name (defaults to origin); never a URL"),
			branch: string("Branch name (fetch: any branch, defaults to all; pull/push: must be the current branch)"),
		},
		["action"],
	),
	define(
		"git_stash",
		"Push tracked worktree changes onto the stash, pop the latest (or indexed) entry back, or list stored entries. Push stores tracked changes only, never untracked files; pop surfaces conflicts as errors and never auto-resolves them.",
		{
			action: { type: "string", enum: ["push", "pop", "list"], description: "push stores tracked changes, pop restores an entry and drops it, list shows stored entries" },
			message: string("Optional push-only message (at most 500 characters)"),
			index: { type: "number", description: "Optional pop-only entry number (defaults to the latest)" },
		},
		["action"],
	),
	define(
		"git_blame",
		"Show line-by-line authorship for a project file (commit, author, date per line), optionally restricted to a line range. Read-only; paths never escape the project.",
		{
			relative_path: string("Project-relative file path"),
			ref: string("Optional single commit, branch, or tag to blame at (defaults to the worktree)"),
			start_line: { type: "number", minimum: 1, description: "First line of the range (1-based)" },
			end_line: { type: "number", minimum: 1, description: "Last line of the range (1-based, must be >= start_line)" },
		},
		["relative_path"],
	),
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
function executeCommand(args, cwd, signal, workspaceRoot, timeoutMs = 45000) {
	requireText(args.command, "command");
	return new Promise((resolve) => {
        const run = workspaceRoot
            ? (command, options, done) => {
                if (process.platform !== 'linux') return done(new Error('Workspace shell sandbox is unavailable on this platform. Use Ask for Approval or Full Access.'), '', '');
                // Filesystem isolation is the security boundary. Unsharing the
                // network namespace fails on some desktop/container kernels and
                // prevents even local git commands from starting.
                //
                // Usability: $HOME and /tmp must be writable, but the real ones
                // stay read-only (via `--ro-bind / /`). Workspace-local home and
                // temp areas are created inside the workspace (symlink-checked,
                // fail-closed through scopedPath) and exposed through env and a
                // /tmp overlay. The /tmp overlay is mounted BEFORE the workspace
                // bind: when the workspace itself lives under /tmp, mounting it
                // afterwards would hide the workspace bind from the namespace.
                (async () => {
                    const sandboxHome = await scopedPath(workspaceRoot, '.llm_workspace/sandbox/home');
                    const sandboxTmp = await scopedPath(workspaceRoot, '.llm_workspace/sandbox/tmp');
                    await fs.mkdir(sandboxHome, { recursive: true });
                    await fs.mkdir(sandboxTmp, { recursive: true });
                    execFile('bwrap', ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
                        '--ro-bind', '/', '/', '--bind', sandboxTmp, '/tmp', '--bind', workspaceRoot, workspaceRoot, '--proc', '/proc', '--dev', '/dev',
                        '--chdir', cwd, '/bin/sh', '-c', command],
                        { ...options, env: { ...process.env, HOME: sandboxHome, TMPDIR: sandboxTmp } }, done);
                })().catch(error => done(error, '', ''));
            }
            : exec;
        run(
			args.command,
			{ cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") stderr += `\nCommand failed: ${error.message}`;
				// Distinguish how the process ended. Node reports a user abort as
				// an AbortError, a timeout as a killed process with a signal, and
				// a spawn failure (missing runner/executable) as a string code.
				// Consumers of the raw shape (the model, the UI, the work digest)
				// still read exitCode; these fields are additive evidence.
				const cancelled = Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
				const timedOut = Boolean(error) && !cancelled && error.killed === true && typeof error.signal === "string";
				const spawnError = Boolean(error) && !cancelled && !timedOut && typeof error.code === "string" ? error.code : null;
				resolve({
					...truncateOutput(stdout, stderr),
					exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					...(cancelled ? { cancelled: true } : {}),
					...(timedOut ? { timedOut: true } : {}),
					...(spawnError ? { spawnError } : {}),
				});
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Structured verification (run_tests)
//
// A thin, evidence-only wrapper over executeCommand: it runs through the exact
// same guard, sandbox, workspace scoping, recovery boundary, timeout and
// cancellation path, then classifies the raw result into one of
// passed | failed | timed_out | cancelled | error. Success is never inferred:
// `passed` requires a real exit code of 0, and any unknown/absent exit status
// is reported as `error`, never as a pass.
// ---------------------------------------------------------------------------

const VERIFICATION_TIMEOUT_MIN = 1000;
const VERIFICATION_TIMEOUT_MAX = 120000;
const VERIFICATION_TIMEOUT_DEFAULT = 45000;
const VERIFICATION_STREAM_LIMIT = 4000; // per captured stream
const VERIFICATION_EXCERPT_LIMIT = 1200; // failure excerpt
// Shell conventions for "the command could not be run at all": 127 is the
// POSIX "command not found", 126 "not executable / permission denied". Only
// combined with a matching diagnostic so an ordinary failing test that happens
// to exit 127 is still reported as a test failure.
const COMMAND_UNAVAILABLE_RE = /(?:command not found|not found|no such file or directory|permission denied|not executable|is a directory)/i;

function verificationTimeoutMs(args) {
	if (args.timeout_ms === undefined) return VERIFICATION_TIMEOUT_DEFAULT;
	if (
		typeof args.timeout_ms !== "number" ||
		!Number.isSafeInteger(args.timeout_ms) ||
		args.timeout_ms < VERIFICATION_TIMEOUT_MIN ||
		args.timeout_ms > VERIFICATION_TIMEOUT_MAX
	) {
		throw new Error(`timeout_ms must be an integer from ${VERIFICATION_TIMEOUT_MIN} to ${VERIFICATION_TIMEOUT_MAX}.`);
	}
	return args.timeout_ms;
}

// Keep the head and the tail: the tail usually holds the failure, the head the
// command context. The marker makes the omission explicit and bounded.
function boundVerificationStream(text, limit = VERIFICATION_STREAM_LIMIT) {
	if (typeof text !== "string" || text.length <= limit) return text ?? "";
	const keep = Math.floor((limit - 40) / 2);
	return `${text.slice(0, keep)}\n[... ${text.length - 2 * keep} characters truncated ...]\n${text.slice(-keep)}`;
}

function verificationFailureExcerpt(stdout, stderr) {
	const source = (stderr && stderr.trim() ? stderr : stdout) ?? "";
	const trimmed = source.trim();
	if (!trimmed) return "";
	return trimmed.length <= VERIFICATION_EXCERPT_LIMIT
		? trimmed
		: `[...]\n${trimmed.slice(-VERIFICATION_EXCERPT_LIMIT)}`;
}

function verificationStatus(result, signal) {
	if (result?.cancelled || signal?.aborted) return "cancelled";
	if (result?.timedOut) return "timed_out";
	if (result?.spawnError) return "error";
	if (typeof result?.exitCode !== "number") return "error";
	if (result.exitCode === 0) return "passed";
	// A command that never started is an execution error, not a test failure.
	if (
		(result.exitCode === 126 || result.exitCode === 127) &&
		COMMAND_UNAVAILABLE_RE.test(result.stderr ?? "")
	) {
		return "error";
	}
	return "failed";
}

function verificationReason(status, result, exitCode, timeoutMs) {
	if (status === "timed_out") {
		return `Verification timed out after ${timeoutMs} ms and was stopped without a pass/fail result.`;
	}
	if (status === "cancelled") {
		return "Verification was cancelled before it completed.";
	}
	if (status === "failed") {
		return `Verification failed: the command exited with status ${exitCode}.`;
	}
	if (result?.spawnError) {
		return `Verification could not run: the command runner is unavailable (${result.spawnError}).`;
	}
	if (exitCode === 126 || exitCode === 127) {
		return `Verification could not run: the command was not found or is not executable (exit ${exitCode}).`;
	}
	return "Verification could not run: no exit status was reported.";
}

// Map the raw executeCommand result into the structured verification verdict.
function structureVerification(args, result, signal, timeoutMs, cwdLabel) {
	const status = verificationStatus(result, signal);
	const exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
	const stdout = boundVerificationStream(result?.stdout);
	const stderr = boundVerificationStream(result?.stderr);
	const structured = {
		// success mirrors the verdict so existing failure detection, the work
		// digest, and the circuit breaker treat a failed check as a failure.
		success: status === "passed",
		status,
		command: args.command,
		cwd: cwdLabel,
		exitCode,
		stdout,
		stderr,
	};
	// Carry the shell recovery boundary's evidence through, so a verification
	// that touched the workspace is still restorable from the returned result.
	for (const key of ["recoveryCheckpointId", "recoveryChangedTotal", "recoveryChanged", "recoveryComplete", "recoveryPostFailed"]) {
		if (result && result[key] !== undefined) structured[key] = result[key];
	}
	if (status === "passed") {
		structured.message = "Verification passed (exit 0).";
		return structured;
	}
	structured.reason = verificationReason(status, result, exitCode, timeoutMs);
	const excerpt = verificationFailureExcerpt(stdout, stderr);
	if (excerpt) structured.failure_excerpt = excerpt;
	return structured;
}

// The single execution path shared by execute_command and run_tests: resolve
// the cwd under the same containment rules, run the command (sandboxed unless
// the user granted an uncontained run), and wrap it in the shell recovery
// boundary when the session has a project root.
async function runScopedCommand(name, args, { root, signal, uncontained, sessionId, recoveryRoot, timeoutMs }) {
	const cwd = uncontained
		? path.resolve(root, args.cwd ?? ".")
		: await scopedPath(root, args.cwd ?? ".", true);
	const runCommand = () => executeCommand(args, cwd, signal, uncontained ? undefined : root, timeoutMs);
	const projectRoot = recoveryRoot ? path.resolve(recoveryRoot) : null;
	const result = projectRoot
		? await require("../recoveryBoundary").withShellRecovery(
				{
					root: projectRoot,
					chatSessionId: sessionId ?? null,
					toolName: name,
					opMeta: { command: typeof args.command === "string" ? args.command.slice(0, 500) : "" },
				},
				runCommand,
			)
		: await runCommand();
	return { result, cwd };
}

async function runVerification(args, { root, signal, uncontained, sessionId, recoveryRoot }) {
	const timeoutMs = verificationTimeoutMs(args);
	const { result, cwd } = await runScopedCommand("run_tests", args, {
		root,
		signal,
		uncontained,
		sessionId,
		recoveryRoot,
		timeoutMs,
	});
	const cwdLabel = uncontained ? cwd : path.relative(root, cwd) || ".";
	return structureVerification(args, result, signal, timeoutMs, cwdLabel);
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

// Read-only git inspection. Every command runs via execFile with an argument
// array (never a shell string), confined to the project root as cwd, with a
// 15-second timeout. Only single refs matching GIT_REF_TOKEN are accepted —
// no ranges, no flags, no shell metacharacters — and paths stay
// project-relative so a pathspec can never address files outside the repo.
const GIT_REF_TOKEN = /^[A-Za-z0-9._\/\-~^@+]+$/;
const GIT_OUTPUT_LIMIT = 20000;

function requireGitRef(value, name) {
	requireText(value, name);
	if (value.length > 128 || value.startsWith("-") || value.startsWith("/") || value.includes('..') || !GIT_REF_TOKEN.test(value))
		throw new Error(`Invalid ${name}: use a single commit, branch, or tag (for example HEAD).`);
	return value;
}

// Strict new/existing branch names (a subset of what requireGitRef accepts:
// no rev suffixes like ~ or ^, no @, no empty components). Used for branch
// creation and branch-only switching so a ref can never parse as a flag,
// a revision range, or a file path.
function requireGitBranchName(value, name) {
	requireText(value, name);
	if (
		value.length < 1 || value.length > 100 ||
		!/^[A-Za-z0-9._\/-]+$/.test(value) ||
		value.startsWith(".") || value.startsWith("/") || value.startsWith("-") ||
		value.includes("..") || value.includes("@{") || value.includes("//") ||
		value.endsWith(".lock") || value.endsWith("/")
	)
		throw new Error(`Invalid ${name}: use a branch name of 1-100 characters (letters, digits, ., _, -, /).`);
	return value;
}

function optionalGitPath(value, name) {
	if (value === undefined) return null;
	requireText(value, name);
	if (value.length > 1024 || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\") || value.includes("\0"))
		throw new Error(`Invalid ${name}: use a project-relative path.`);
	if (value.split("/").some((part) => part === "..")) throw new Error(`Invalid ${name}: path escapes the project root.`);
	return value;
}

async function runGit(root, args, signal, { write = false, uncontained = false, network = false, askpass } = {}) {
	root = await fs.realpath(root);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
	Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' });
	// SSH transport is unsupported by design (gh-CLI HTTPS only): never let a
	// sandboxed git reach the ambient agent socket, even when one is configured.
	delete env.SSH_AUTH_SOCK;
	// A caller-supplied askpass path (a secret-free relay client, never a
	// token) is the only credential channel ever admitted to the sandbox.
	if (askpass !== undefined) {
		if (typeof askpass !== 'string' || !askpass || askpass.includes('\0')) throw new Error('Invalid askpass helper.');
		Object.assign(env, { GIT_ASKPASS: askpass });
	}
	if (!uncontained) Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
	const gitArgs = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
		...(!uncontained ? ['-c', 'core.hooksPath=/dev/null'] : []), ...args];
	// A cwd is not containment: Git can run filters, diff drivers and helpers.
	// Reads always run with a read-only host filesystem and no network; only
	// explicit write operations may receive a writable workspace mount.
	// Remote sync uses a separate profile that shares the host network
	// namespace but is otherwise identical (read-only /, no capabilities, no
	// helpers, no system/global config). It exists for fetch/pull/push/ls-remote
	// only and must never be reused for shell or file tools.
	let command = 'git';
	let commandArgs = gitArgs;
	if (!uncontained) {
		if (process.platform !== 'linux') throw new Error('Git sandbox is unavailable on this platform.');
		command = 'bwrap';
		commandArgs = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
			...(network ? [] : ['--unshare-net']), '--cap-drop', 'ALL',
			'--ro-bind', '/', '/', '--tmpfs', '/tmp', write ? '--bind' : '--ro-bind', root, root,
			...(askpass ? ['--ro-bind', path.dirname(askpass), path.dirname(askpass)] : []),
			'--proc', '/proc', '--dev', '/dev', '--chdir', root, 'git', ...gitArgs];
		Object.assign(env, { HOME: '/tmp', TMPDIR: '/tmp' });
	}
	return new Promise((resolve, reject) => {
		execFile(
			command,
			commandArgs,
			{ cwd: root, timeout: network ? 120000 : 15000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", signal, env },
			(error, stdout, stderr) => {
				if (error) {
					if (error.code === "ENOENT") return reject(new Error(`${command} is not installed; Git execution is blocked.`));
					if (/not a git repository/i.test(stderr))
						return reject(new Error("Not a git repository: the project workspace has no .git directory."));
					// Merge-style failures (stash pop conflicts, checkout
					// collisions) report on stdout, not stderr: include both
					// so the caller always sees git's own diagnosis verbatim.
					const detail = `${stdout}\n${stderr}`.trim() || error.message;
					return reject(new Error(`git ${args[0]} failed: ${detail.slice(0, 500)}`));
				}
				resolve(stdout);
			},
		);
	});
}

function truncateGitOutput(stdout) {
	return stdout.length > GIT_OUTPUT_LIMIT ? `${stdout.slice(0, GIT_OUTPUT_LIMIT)}\n[Output truncated]` : stdout;
}

async function prepareGitCommit(root, signal) {
	const diff = await runGit(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], signal);
	if (!diff.trim()) throw new Error('Nothing staged to commit.');
	const head = await runGit(root, ['symbolic-ref', '-q', 'HEAD'], signal).catch(() => runGit(root, ['rev-parse', 'HEAD'], signal));
	const parent = await runGit(root, ['rev-parse', '--verify', 'HEAD'], signal).catch(() => 'unborn');
	return { fingerprint: require('node:crypto').createHash('sha256').update(head).update(parent).update(diff).digest('hex'),
		stagedDiff: truncateGitOutput(diff) };
}

// Branch switching refuses on a dirty worktree: any staged, unstaged, or
// otherwise tracked change (anything in porcelain output besides untracked
// ?? entries) blocks the switch. Read-only probe; the caller runs the
// actual mutation with { write: true }.
async function requireCleanGitWorktree(root, signal, uncontained, purpose = "switching branches") {
	const status = await runGit(root, ["status", "--porcelain=v1"], signal, { uncontained });
	const dirty = status.split("\n").some((line) => line.length > 0 && !line.startsWith("??"));
	if (dirty)
		throw new Error(`Worktree has staged or unstaged changes; commit or stash them before ${purpose}.`);
}

// Remote names come from an allow-list, never from free-form input: the value
// must both match a strict token and equal a configured remote, so it can
// never parse as a git flag or carry a URL/refspec.
async function requireGitRemote(root, value, signal) {
	requireText(value, "remote");
	if (!/^[A-Za-z0-9._-]+$/.test(value) || value.startsWith("-") || value.length > 128)
		throw new Error("Invalid remote: use a configured remote name (for example origin).");
	const remotes = (await runGit(root, ["remote"], signal)).split("\n").map((line) => line.trim()).filter(Boolean);
	if (!remotes.includes(value))
		throw new Error(`Unknown remote '${value}': configured remotes are ${remotes.join(", ") || "(none)"}.`);
	return value;
}

async function currentGitBranch(root, signal) {
	let head;
	try {
		head = (await runGit(root, ["symbolic-ref", "--short", "HEAD"], signal)).trim();
	} catch {
		throw new Error("Detached HEAD: sync pull/push require an attached branch; checkout a branch first.");
	}
	if (!head) throw new Error("Detached HEAD: sync pull/push require an attached branch; checkout a branch first.");
	try {
		await runGit(root, ["rev-parse", "--verify", "HEAD"], signal);
	} catch {
		throw new Error("No commits on this branch yet; commit before pulling or pushing.");
	}
	return head;
}

// Pull and push operate on the current branch only: an explicit branch must
// equal HEAD's branch, so a pull can never merge a foreign branch and a push
// can never publish one.
async function resolveSyncBranch(root, value, signal) {
	const current = await currentGitBranch(root, signal);
	if (value === undefined) return current;
	requireGitBranchName(value, "branch");
	if (value !== current)
		throw new Error(`Sync pull/push operate on the current branch ('${current}'); checkout '${value}' first or omit branch.`);
	return current;
}

// gh-CLI auth, the only supported credential source. The token is obtained
// outside the sandbox and lives only in main-process memory plus one
// single-use localhost relay (below): it never enters bwrap env, argv, tool
// output, logs, or SQLite, and nothing of our own is stored anywhere.
async function ghTokenFor(remote) {
	const authFailed = () => {
		throw new Error(`Authentication failed for '${remote}'. Ask the user to run 'gh auth login'; the token itself is never shown.`);
	};
	const run = (args) => new Promise((resolve, reject) => {
		require("node:child_process").execFile("gh", args, { timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) return reject(error);
			resolve(stdout);
		});
	});
	try {
		await run(["auth", "status"]);
	} catch {
		authFailed();
	}
	try {
		const token = (await run(["auth", "token"])).trim();
		if (!token) authFailed();
		return token;
	} catch {
		authFailed();
	}
}

function startTokenRelay(token) {
	const http = require("node:http");
	const nonce = require("node:crypto").randomBytes(16).toString("hex");
	const server = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === `/${nonce}`) {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(token);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	return new Promise((resolve, reject) => {
		server.on("error", reject);
		// Shared network namespace makes loopback reachable from the sandbox;
		// the server is destroyed when the git call settles, so the URL below
		// is single-use even though it must cross into bwrap.
		server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/${nonce}` }));
	});
}

let relayClient = null;
async function pickRelayClient() {
	if (relayClient) return relayClient;
	const run = (command) => new Promise((resolve) => {
		require("node:child_process").execFile(command, ["--version"], { timeout: 10000 }, (error) => resolve(!error));
	});
	// curl/wget resolve identically inside the sandbox (ro-bind /), so a host
	// probe decides. Neither present fails closed — but only when auth is
	// actually required, never for public or file:// remotes.
	if (await run("curl")) relayClient = "curl";
	else if (await run("wget")) relayClient = "wget";
	if (!relayClient) throw new Error("Authenticated sync needs curl or wget for the credential relay; install one and retry.");
	return relayClient;
}

// Runs fn with a GIT_ASKPASS relay configured when the remote URL needs it.
// Plain file:// (and other non-HTTP) URLs skip auth entirely. The staged
// helper script embeds only the single-use relay URL — verified empirically,
// git executes GIT_ASKPASS directly (no shell), so the helper must be a real
// file, bind-mounted read-only by the network profile.
async function withRemoteAuth(remote, remoteUrl, fn) {
	if (!/^https?:/i.test(remoteUrl)) return fn(undefined);
	const token = await ghTokenFor(remote);
	const { server, url } = await startTokenRelay(token);
	const dir = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "git-askpass-"));
	const helper = path.join(dir, "askpass.sh");
	const client = await pickRelayClient();
	const fetch = client === "curl"
		? `exec curl -fsS --max-time 10 '${url}'`
		: `exec wget -qO- -T 10 '${url}'`;
	await fs.writeFile(helper, `#!/bin/sh\n# Single-use credential-relay client. Contains no secret.\n${fetch}\n`, { mode: 0o700 });
	try {
		return await fn(helper);
	} finally {
		server.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function lsRemoteSha(root, remote, branch, signal, askpass) {
	const out = await runGit(root, ["ls-remote", remote, branch], signal, { network: true, askpass });
	const first = out.trim().split("\n").map((line) => line.trim()).filter(Boolean)[0];
	return first ? first.split(/\s+/)[0] : "";
}

// Push approval snapshot: everything the user confirms, fingerprinted so any
// local or remote movement between approval and execution rejects. The
// summary carries shas, subjects, and stat only — never secrets.
async function prepareGitPush(root, args, signal) {
	const remote = await requireGitRemote(root, args.remote ?? "origin", signal);
	const branch = await resolveSyncBranch(root, args.branch, signal);
	const localSha = (await runGit(root, ["rev-parse", "--verify", branch], signal)).trim();
	const remoteUrl = (await runGit(root, ["remote", "get-url", remote], signal)).trim();
	const remoteSha = await withRemoteAuth(remote, remoteUrl, (askpass) => lsRemoteSha(root, remote, branch, signal, askpass));
	if (remoteSha) {
		// ls-remote names a tip this repo may never have fetched: make the
		// objects available before log/diff/merge-base touch them. Tracking-ref
		// movement is harmless here (worktree, index, and HEAD are untouched).
		try {
			await runGit(root, ["cat-file", "-e", remoteSha], signal);
		} catch {
			await withRemoteAuth(remote, remoteUrl, (askpass) => runGit(root, ["fetch", remote, branch], signal, { network: true, write: true, askpass }));
		}
	}
	const short = (sha) => sha.slice(0, 7);
	let subjects;
	let stat;
	if (remoteSha) {
		subjects = await runGit(root, ["log", "--pretty=format:%s", "-n", "20", `${remoteSha}..${localSha}`], signal);
		stat = await runGit(root, ["diff", "--stat", remoteSha, localSha], signal);
	} else {
		subjects = await runGit(root, ["log", "--pretty=format:%s", "-n", "20", localSha], signal);
		stat = await runGit(root, ["diff", "--stat", EMPTY_TREE, localSha], signal);
	}
	const count = subjects.split("\n").filter((line) => line.trim()).length;
	const lines = [
		`Push ${short(localSha)} (${count} commit${count === 1 ? "" : "s"}) '${branch}' -> '${remote}'${remoteSha ? ` (remote at ${short(remoteSha)})` : " (new upstream branch)"}:`,
		...subjects.split("\n").filter((line) => line.trim()).slice(0, 20).map((line) => `  ${line.trim().slice(0, 200)}`),
		stat.trim(),
	].join("\n");
	const summary = lines.length > 2000 ? `${lines.slice(0, 2000)}\n[truncated]` : lines;
	const fingerprint = require("node:crypto").createHash("sha256")
		.update(remote).update("\0").update(branch).update("\0")
		.update(localSha).update("\0").update(remoteSha).update("\0").update(stat).digest("hex");
	return { fingerprint, summary, remote, branch, localSha, remoteSha };
}

async function executeGitTool(root, name, args, signal, uncontained = false, approval = null, fullAccess = false) {
	if (name === "git_status") {
		return { output: truncateGitOutput(await runGit(root, ["status", "--porcelain=v1", "--branch"], signal)) };
	}
	if (name === "git_branch") {
		return { output: truncateGitOutput(await runGit(root, ["branch", "-vv", "--all"], signal)) };
	}
	if (name === "git_diff") {
		if (args.staged !== undefined && typeof args.staged !== "boolean") throw new Error("staged must be a boolean.");
		if (args.stat_only !== undefined && typeof args.stat_only !== "boolean") throw new Error("stat_only must be a boolean.");
		const gitArgs = ["diff", '--no-ext-diff', '--no-textconv'];
		if (args.stat_only) gitArgs.push("--stat");
		if (args.staged) gitArgs.push("--cached");
		if (args.ref !== undefined) gitArgs.push(requireGitRef(args.ref, "ref"));
		const file = optionalGitPath(args.relative_path, "relative_path");
		if (file !== null) gitArgs.push("--", file);
		return { output: truncateGitOutput(await runGit(root, gitArgs, signal)) };
	}
	if (name === "git_log") {
		const limit = args.limit ?? 10;
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
			throw new Error("limit must be an integer from 1 to 50.");
		const gitArgs = ["log", "--pretty=format:%H %ad %an %s", "--date=short", "-n", String(limit)];
		if (args.ref !== undefined) gitArgs.push(requireGitRef(args.ref, "ref"));
		const file = optionalGitPath(args.relative_path, "relative_path");
		if (file !== null) gitArgs.push("--", file);
		return { output: truncateGitOutput(await runGit(root, gitArgs, signal)) };
	}
	if (name === "git_show") {
		const gitArgs = ["show", '--no-ext-diff', '--no-textconv', requireGitRef(args.ref, "ref")];
		if (args.stat_only !== undefined && typeof args.stat_only !== "boolean") throw new Error("stat_only must be a boolean.");
		if (args.stat_only) gitArgs.splice(1, 0, "--stat");
		const file = optionalGitPath(args.relative_path, "relative_path");
		if (file !== null) gitArgs.push("--", file);
		return { output: truncateGitOutput(await runGit(root, gitArgs, signal)) };
	}
	if (name === "git_blame") {
		const file = optionalGitPath(args.relative_path, "relative_path");
		if (file === null) throw new Error("Invalid relative_path: use a project-relative file path.");
		const { start_line, end_line } = args;
		if (start_line !== undefined && (!Number.isSafeInteger(start_line) || start_line < 1))
			throw new Error("start_line must be a positive integer.");
		if (end_line !== undefined && (!Number.isSafeInteger(end_line) || end_line < 1))
			throw new Error("end_line must be a positive integer.");
		if (start_line !== undefined && end_line !== undefined && end_line < start_line)
			throw new Error("end_line must be >= start_line.");
		const gitArgs = ["blame"];
		if (start_line !== undefined || end_line !== undefined)
			gitArgs.push("-L", `${start_line ?? 1},${end_line !== undefined ? end_line : ''}`);
		if (args.ref !== undefined) gitArgs.push(requireGitRef(args.ref, "ref"));
		gitArgs.push("--", file);
		return { output: truncateGitOutput(await runGit(root, gitArgs, signal)) };
	}
	if (name === "git_stage") {
		if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 50)
			throw new Error("paths must be an array of 1 to 50 project-relative file paths.");
		const seen = new Set();
		const staged = [];
		for (const value of args.paths) {
			optionalGitPath(value, 'path');
			if (value === '.' || value.endsWith('/')) throw new Error('Stage explicit files, not directories.');
			if (seen.has(value)) throw new Error(`Duplicate path: ${value}.`);
			seen.add(value);
			// Same containment guarantees as the other write tools: sandboxed
			// to the project unless the call is uncontained (an approval grant
			// or Full Access). The `--` separator below additionally keeps a
			// path from ever parsing as a git flag.
			if (value.length > 1024 || path.isAbsolute(value) || value.split("/").some((part) => part === ".."))
				throw new Error(`Invalid path (must stay inside the project): ${value}.`);
			const target = uncontained ? path.resolve(root, value) : await scopedPath(root, value, true);
			try { if ((await fs.lstat(target)).isDirectory()) throw new Error('Stage explicit files, not directories.'); }
			catch (error) { if (error.code !== 'ENOENT') throw error; }
			staged.push(path.relative(root, target) || ".");
		}
		return { output: truncateGitOutput(await runGit(root, ["add", "--", ...staged], signal, { write: true, uncontained })), staged };
	}
	if (name === "git_unstage") {
		if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 50)
			throw new Error("paths must be an array of 1 to 50 project-relative file paths.");
		const seen = new Set();
		const unstaged = [];
		for (const value of args.paths) {
			optionalGitPath(value, 'path');
			if (value === '.' || value.endsWith('/')) throw new Error('Unstage explicit files, not directories.');
			if (seen.has(value)) throw new Error(`Duplicate path: ${value}.`);
			seen.add(value);
			// Same containment guarantees as the other write tools: sandboxed
			// to the project unless the call is uncontained (an approval grant
			// or Full Access). The `--` separator below additionally keeps a
			// path from ever parsing as a git flag.
			if (value.length > 1024 || path.isAbsolute(value) || value.split("/").some((part) => part === ".."))
				throw new Error(`Invalid path (must stay inside the project): ${value}.`);
			const target = uncontained ? path.resolve(root, value) : await scopedPath(root, value, true);
			try { if ((await fs.lstat(target)).isDirectory()) throw new Error('Unstage explicit files, not directories.'); }
			catch (error) { if (error.code !== 'ENOENT') throw error; }
			unstaged.push(path.relative(root, target) || ".");
		}
		// Index-only by construction: --staged copies HEAD into the index and
		// leaves the worktree alone. No --worktree, no --source, no pathspec
		// magic — working-tree content is never touched.
		return { output: truncateGitOutput(await runGit(root, ["restore", "--staged", "--", ...unstaged], signal, { write: true, uncontained })), unstaged };
	}
	if (name === "git_commit") {
		requireText(args.message, "message");
		if (args.message.length > 2000) throw new Error("message must be at most 2000 characters.");
		if (!fullAccess) {
			const current = await prepareGitCommit(root, signal);
			if (!approval?.gitCommitFingerprint || current.fingerprint !== approval.gitCommitFingerprint)
				throw new Error('Staged changes or branch changed since approval. Review and approve the commit again.');
		}
		// Staged-only by construction: no -a, no pathspec, no amend/--allow-empty.
		// Nothing staged is a plain git error passed through below, never silent.
		const output = truncateGitOutput(await runGit(root, ["commit", "-m", args.message], signal, { write: true, uncontained }));
		let hash = null;
		try { hash = (await runGit(root, ["rev-parse", "HEAD"], signal)).trim(); } catch { /* Output above is the result. */ }
		return { output, hash };
	}
	if (name === "git_create_branch") {
		const branch = requireGitBranchName(args.name, "name");
		const start = args.start_point === undefined ? "HEAD" : requireGitRef(args.start_point, "start_point");
		if (args.switch !== undefined && typeof args.switch !== "boolean") throw new Error("switch must be a boolean.");
		const shouldSwitch = args.switch ?? true;
		// Check before creating: a failed switch must not leave a branch
		// behind that the agent never asked to keep.
		if (shouldSwitch) await requireCleanGitWorktree(root, signal, uncontained);
		// Argv only, validated names above: no shell, no flags, no detach.
		const output = truncateGitOutput(await runGit(root, ["branch", branch, start], signal, { write: true, uncontained }));
		if (!shouldSwitch) return { output, branch, switched: false };
		const switched = truncateGitOutput(await runGit(root, ["switch", branch], signal, { write: true, uncontained }));
		return { output: [output, switched].filter(Boolean).join("\n") || `Switched to branch '${branch}'.`, branch, switched: true };
	}
	if (name === "git_switch") {
		// Branch names only: rev suffixes (~, ^), ranges, and pathspecs are
		// rejected by requireGitBranchName. No --force/--merge/--discard-
		// changes/--detach is ever passed: a dirty worktree fails instead.
		const branch = requireGitBranchName(args.ref, "ref");
		await requireCleanGitWorktree(root, signal, uncontained);
		const output = truncateGitOutput(await runGit(root, ["switch", branch], signal, { write: true, uncontained }));
		return { output, branch };
	}
	if (name === "git_stash") {
		if (args.action !== "push" && args.action !== "pop" && args.action !== "list")
			throw new Error('action must be one of "push", "pop", or "list".');
		if (args.action === "list") {
			if (args.message !== undefined) throw new Error("message is only valid for push.");
			if (args.index !== undefined) throw new Error("index is only valid for pop.");
			return { output: truncateGitOutput(await runGit(root, ["stash", "list"], signal, { uncontained })), action: "list" };
		}
		if (args.action === "push") {
			if (args.index !== undefined) throw new Error("index is only valid for pop.");
			// Tracked changes only by construction: no -u/--all/--include-
			// untracked, no --keep-index, no --patch. The message travels as
			// a single argv element, never a shell string.
			let message = "Continuum stash";
			if (args.message !== undefined) {
				requireText(args.message, "message");
				if (args.message.length > 500) throw new Error("message must be at most 500 characters.");
				message = args.message;
			}
			const output = truncateGitOutput(await runGit(root, ["stash", "push", "-m", message], signal, { write: true, uncontained }));
			return { output, action: "push", message };
		}
		if (args.message !== undefined) throw new Error("message is only valid for push.");
		// Build stash@{n} ourselves from a validated integer: git never
		// resolves a caller-supplied ref string here. Deliberately no apply,
		// drop, clear, or branch — pop restores and drops, or fails loudly.
		let gitArgs = ["stash", "pop"];
		let index = null;
		if (args.index !== undefined) {
			if (typeof args.index !== "number" || !Number.isSafeInteger(args.index) || args.index < 0)
				throw new Error("index must be a non-negative integer.");
			const entries = (await runGit(root, ["stash", "list"], signal, { uncontained })).split("\n").filter((line) => line.trim());
			if (args.index >= entries.length)
				throw new Error(`Invalid index: only ${entries.length} stash ${entries.length === 1 ? "entry" : "entries"} stored.`);
			index = args.index;
			gitArgs = ["stash", "pop", `stash@{${index}}`];
		}
		// A conflicting pop fails here with git's own error (entry kept, no
		// auto-resolve): runGit passes stderr through verbatim.
		const output = truncateGitOutput(await runGit(root, gitArgs, signal, { write: true, uncontained }));
		return { output, action: "pop", ...(index === null ? {} : { index }) };
	}
	if (name === "git_sync") {
		// No --force/--force-with-lease/refspec/colon/plus exists anywhere in
		// this schema or argv: force-push is impossible by construction, and
		// --prune/--tags/--depth/--all/--mirror/--delete/--set-upstream were
		// deliberately excluded. Remote sync always runs in the contained
		// network sandbox profile (never uncontained): approval gates
		// permission, the sandbox gates containment.
		const action = args.action;
		if (action !== "fetch" && action !== "pull" && action !== "push")
			throw new Error('action must be one of "fetch", "pull", or "push".');
		const remote = await requireGitRemote(root, args.remote ?? "origin", signal);
		const remoteUrl = (await runGit(root, ["remote", "get-url", remote], signal)).trim();
		return await withRemoteAuth(remote, remoteUrl, async (askpass) => {
			const net = { network: true, askpass };
			if (action === "fetch") {
				const fetchBranch = args.branch === undefined ? null : requireGitBranchName(args.branch, "branch");
				const fetchArgs = fetchBranch ? ["fetch", remote, fetchBranch] : ["fetch", remote];
				const fetched = truncateGitOutput(await runGit(root, fetchArgs, signal, { ...net, write: true }));
				return { output: fetched, action, remote, ...(fetchBranch ? { branch: fetchBranch } : {}) };
			}
			const branch = await resolveSyncBranch(root, args.branch, signal);
			if (action === "pull") {
				await requireCleanGitWorktree(root, signal, false, "pulling");
				// --ff-only is hard-coded, never model-supplied: a diverged
				// history fails instead of merging, and --no-rebase forbids
				// rewriting. Worktree dirt already refused above.
				const pulled = truncateGitOutput(await runGit(root, ["pull", "--ff-only", "--no-rebase", remote, branch], signal, { ...net, write: true }));
				return { output: pulled, action, remote, branch };
			}
			const snapshot = await prepareGitPush(root, { remote, branch }, signal);
			if (!fullAccess) {
				if (!approval?.gitPushFingerprint || snapshot.fingerprint !== approval.gitPushFingerprint)
					throw new Error("Local or remote history changed since approval. Review and approve the push again.");
			}
			if (snapshot.remoteSha) {
				// Pre-flight fast-forward check: the remote tip must already be
				// an ancestor of what we publish. Anything else fails here —
				// fetch and reconcile first, never push over it.
				try {
					await runGit(root, ["merge-base", "--is-ancestor", snapshot.remoteSha, snapshot.localSha], signal);
				} catch {
					throw new Error(`Push refused: '${branch}' has diverged from '${remote}/${branch}'. Fetch and reconcile first; force-push is not supported.`);
				}
			}
			const pushed = truncateGitOutput(await runGit(root, ["push", remote, branch], signal, { ...net, write: true }));
			// Treat push as request-then-verify: the remote tip must now be
			// what we published. Server rejections already surface verbatim
			// through runGit; this catches anything stranger.
			const confirmed = await withRemoteAuth(remote, remoteUrl, (retryAskpass) => lsRemoteSha(root, remote, branch, signal, retryAskpass));
			if (confirmed !== snapshot.localSha)
				throw new Error(`Push reported success but '${remote}/${branch}' does not point at the published commit. Re-fetch and inspect before retrying.`);
			return { output: pushed, action, remote, branch };
		});
	}
	throw new Error("Unknown agent tool.");
}
async function executeStrReplaceEditor(target, { old_str, new_str }, recoveryCtx = {}) {
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
	// Atomic temp+rename (not bare writeFile): an interrupted write must
	// never leave a half-written file behind.
	const write = async () => {
		await atomicWriteFile(target, content.slice(0, start) + new_str + content.slice(end));
		return { success: true };
	};
	if (!recoveryCtx.root || !recoveryCtx.rel) return write();
	return withFileRecovery(recoveryCtx.root, {
		chatSessionId: recoveryCtx.chatSessionId ?? null,
		toolName: "str_replace_editor",
		paths: [recoveryCtx.rel],
		uncontained: recoveryCtx.uncontained === true,
	}, write);
}

// Resolve a write-target path with the same containment guarantees as the
// other write tools: sandboxed to root unless the call is uncontained.
async function resolveWriteTarget(root, value, uncontained) {
	requireText(value, "path");
	return uncontained ? path.resolve(root, value) : await scopedPath(root, value, true);
}

// Write file content atomically (temp file + rename) so an interrupted write
// never leaves a half-written file behind.
async function atomicWriteFile(target, content) {
	const suffix = `.tmp-${process.pid}-${require("node:crypto").randomUUID().slice(0, 8)}`;
	const temporary = `${target}${suffix}`;
	await fs.writeFile(temporary, content, "utf8");
	try {
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

// Shared surgical-replacement matcher (same whitespace-normalized, uniqueness-
// enforcing semantics as executeStrReplaceEditor), factored so multi-file
// edits can validate every replacement before writing anything.
function locateReplacement(content, old_str) {
	requireText(old_str, "old_str", true);
	if (!old_str)
		throw new Error("old_str must not be empty. Provide surrounding lines to identify a unique block.");
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
	let start = 0;
	for (let index = 0; index < match; index++) start += lines[index].length + 1;
	const last = match + oldLines.length - 1;
	let end = start;
	for (let index = match; index < last; index++) end += lines[index].length + 1;
	end += lines[last].length;
	if (last < lines.length - 1 && lines[last].endsWith("\r")) end--;
	return { start, end };
}

// Workspace file recovery (Phase 1): capture before-images before the first
// irreversible mutation. Capture failures block the operation (never silent);
// mutation failures trigger a best-effort rollback from the checkpoint, and
// the checkpoint row always remains for explicit restore. Shell/MCP
// mutations are NOT covered — see docs/workspace-recovery-architecture.md.
async function withFileRecovery(root, { chatSessionId = null, toolName, op = null, paths, uncontained = false }, mutate) {
	let checkpoint;
	try {
		// The operation is about to mutate exactly these paths: any capture
		// gap on them blocks the operation instead of leaving it half-protected.
		checkpoint = await recoveryStore.captureOperation({ root, chatSessionId, toolName, op, paths, required: paths, uncontained });
	} catch (error) {
		throw new Error(`Recovery capture failed; refusing ${toolName} to protect existing content: ${error.message}`);
	}
	try {
		const result = await mutate();
		// Record post-operation state so later restores can tell this
		// operation's own effects (revert freely) from later edits
		// (conflicts unless forced). Best-effort: a snapshot failure must
		// never fail an operation that already succeeded — without it,
		// restores simply stay conservative.
		try {
			await recoveryStore.recordOpPostState(
				checkpoint.checkpointId,
				await recoveryStore.snapshotCurrentState(root, paths, uncontained),
			);
		} catch {
			/* Conservative fallback preserved. */
		}
		if (result && typeof result === "object" && !Array.isArray(result)) {
			return { ...result, recoveryCheckpointId: checkpoint.checkpointId };
		}
		return result;
	} catch (error) {
		let rollback;
		let undoCheckpointId = null;
		let safetyNote = '';
		try {
			// Preserve evidence before the automatic rollback overwrites
			// anything: a clearly labelled pre-rollback snapshot, best-effort.
			// A snapshot failure must never mask the original error, and a
			// failed rollback is reported, never retried (no recursion).
			try {
				const pre = await recoveryStore.captureOperation({ root, chatSessionId, toolName, op: { ...(op ?? {}), note: 'pre-rollback' },
					paths, kind: 'pre-rollback' });
				undoCheckpointId = pre.checkpointId;
			} catch (snapshotError) {
				safetyNote = ` Pre-rollback snapshot unavailable: ${snapshotError.message}.`;
			}
			// Rollback restores the exact pre-image of the just-authorized
			// operation, so it carries internal authorization past the safety
			// gate; any gate finding is reported below rather than silently
			// applied, and the pre-rollback snapshot above keeps the
			// overwritten state recoverable either way.
			const rolled = await recoveryStore.restoreCheckpoint(checkpoint.checkpointId, { force: true, allowRisky: true });
			if (rolled.safety && rolled.safety.verdict !== 'safe') {
				const kinds = rolled.safety.anomalies.map((entry) => entry.type).join(', ');
				safetyNote += ` Rollback applied over a flagged restore (${rolled.safety.verdict}: ${kinds}); pre-rollback state kept as checkpoint #${undoCheckpointId ?? rolled.preRestoreCheckpointId ?? 'unknown'}.`;
			}
			rollback = rolled.complete ? "succeeded"
				: `incomplete (${rolled.skipped.map((entry) => `${entry.path}: ${entry.reason}`).join("; ")})`;
		} catch (rollbackError) {
			rollback = `failed: ${rollbackError.message}`;
		}
		error.message = `${error.message} [Recovery checkpoint #${checkpoint.checkpointId} captured pre-operation state; rollback ${rollback}.` +
			(undoCheckpointId !== null ? ` Pre-rollback snapshot: checkpoint #${undoCheckpointId}.` : '') +
			`${safetyNote}]`;
		throw error;
	}
}

async function executeMoveProjectFile(root, { source_path, destination_path }, uncontained, recoveryCtx = {}) {
	const source = await resolveWriteTarget(root, source_path, uncontained);
	const destination = await resolveWriteTarget(root, destination_path, uncontained);
	let stat;
	try {
		stat = await fs.lstat(source);
	} catch (error) {
		if (error.code === "ENOENT") throw new Error(`Source does not exist: ${source_path}.`);
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error("Refusing to move a symbolic link.");
	try {
		await fs.lstat(destination);
		throw new Error(`Destination already exists: ${destination_path}.`);
	} catch (error) {
		if (error.message.startsWith("Destination already exists")) throw error;
		if (error.code !== "ENOENT") throw error;
	}
	// Capture the full source tree (directories walk recursively) and the
	// destination state before the first irreversible step. resolveWriteTarget
	// already confined both paths; capture re-resolves defensively.
	const move = async () => {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		try {
			await fs.rename(source, destination);
		} catch (error) {
			if (error.code !== "EXDEV") throw error;
			if (stat.isDirectory()) throw new Error("Cannot move a directory across filesystems.");
			await fs.copyFile(source, destination);
			await fs.unlink(source);
		}
		// The copy/unlink fallback is non-atomic: verify the end state so a
		// partial move is detectable and recoverable instead of silent.
		const sourceGone = await fs.lstat(source).then(() => false, (error) => {
			if (error.code === "ENOENT") return true;
			throw error;
		});
		const destPresent = await fs.lstat(destination).then(() => true, (error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		});
		if (!sourceGone || !destPresent) {
			throw new Error(
				`Move completed partially (source ${sourceGone ? "removed" : "still present"}, ` +
				`destination ${destPresent ? "present" : "missing"}).`,
			);
		}
		return { success: true, source_path, destination_path };
	};
	return withFileRecovery(root, {
		chatSessionId: recoveryCtx.chatSessionId ?? null,
		toolName: "move_project_file",
		op: { kind: "move", source: source_path, dest: destination_path },
		paths: [source_path, destination_path],
		uncontained,
	}, move);
}

// ---------------------------------------------------------------------------
// delete_project_file: durable, permission-gated single-file deletion.
//
// There is no new deletion framework: the before-image is captured through the
// existing recovery store and the operation is gated by the existing
// permission/approval flow (see toolPermissions guardTool). This module owns
// only the mechanics: strict single-file validation, a content fingerprint
// binding the approved bytes, fail-closed TOCTOU re-checks, the irreversible
// unlink, and honest outcomes. Deletion is always workspace-contained — the
// one escape hatch other writes have (an approved outside-workspace write) is
// deliberately unavailable here.
// ---------------------------------------------------------------------------

// Outcome vocabulary returned to the model and UI. `deleted` is the only
// success; a missing file is never reported as deleted.
const DELETE_OUTCOMES = Object.freeze({
	DELETED: 'deleted',
	NOT_FOUND: 'not_found',
	PERMISSION_DENIED: 'permission_denied',
	APPROVAL_DENIED: 'approval_denied',
	INVALID_PATH: 'invalid_path',
	NOT_A_FILE: 'not_a_file',
	CONFLICT: 'conflict',
	RECOVERY_FAILED: 'recovery_failed',
	CANCELLED: 'cancelled',
	ERROR: 'error',
});

// Typed deletion failure: the `.deleteOutcome` marker lets the dispatcher
// report a precise outcome while the message stays human-readable.
function deleteFail(outcome, message) {
	const error = new Error(message);
	error.deleteOutcome = outcome;
	return error;
}

// Streaming SHA-256 so a large file is hashed without buffering it whole in
// memory (recovery capture, not this hash, is what caps deletion size).
async function sha256File(abs) {
	const hash = require("node:crypto").createHash("sha256");
	let size = 0;
	const stream = require("node:fs").createReadStream(abs);
	for await (const chunk of stream) {
		size += chunk.length;
		hash.update(chunk);
	}
	return { hash: hash.digest("hex"), size };
}

// Fingerprint binds the exact path AND content bytes the user approves, so a
// rename, content edit, or size change between approval and execution rejects.
function deleteFingerprint(rel, hash, size) {
	return require("node:crypto").createHash("sha256")
		.update(rel).update("\0").update(hash).update("\0").update(String(size)).digest("hex");
}

/**
 * Resolve and validate a single-file deletion target under `root`. Fails
 * closed on every shape that is not an existing regular in-workspace file:
 * absolute paths, `..` traversal, `.git` internals, symlinks (including
 * in-workspace ones), directories, and the workspace root itself. Containment
 * uses the same ancestor/symlink-aware resolver every other write tool uses —
 * never a string-prefix comparison — and canonicalizes the parent so an
 * intermediate symlink cannot redirect the unlink outside the workspace.
 * Returns a snapshot { rel, abs, size, hash, mode, fingerprint }.
 */
async function prepareFileDelete(root, value, { signal } = {}) {
	signal?.throwIfAborted();
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, "Invalid path: provide a non-empty project-relative file path.");
	if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\"))
		throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, "Invalid path: use a project-relative file path.");
	const normalized = value.replace(/\\/g, "/");
	const segments = normalized.split("/");
	if (segments.some((part) => part === ".."))
		throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, "Execution blocked: path escapes the project root.");
	// Repository history is never a deletion target.
	if (segments.some((part) => part === ".git"))
		throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, "Execution blocked: refusing to delete inside the .git directory.");
	let target;
	try {
		target = await scopedPath(root, normalized, false);
	} catch (error) {
		throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, `Execution blocked: ${error.message}`);
	}
	if (path.resolve(target) === path.resolve(root))
		throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, "Execution blocked: refusing to delete the project root.");
	// A trailing slash asserts a directory (POSIX unlink would fail ENOTDIR);
	// deletion is file-only, so refuse it as not-a-file rather than silently
	// resolving to the file behind it.
	if (normalized.endsWith("/"))
		throw deleteFail(DELETE_OUTCOMES.NOT_A_FILE, `Not a regular file: ${normalized}.`);
	let stat;
	try {
		stat = await fs.lstat(target);
	} catch (error) {
		if (error.code === "ENOENT")
			throw deleteFail(DELETE_OUTCOMES.NOT_FOUND, `File does not exist: ${normalized}.`);
		throw error;
	}
	// The final component must be a regular file: a symlink (even one that
	// resolves inside the workspace) and a directory are both refused.
	if (stat.isSymbolicLink())
		throw deleteFail(DELETE_OUTCOMES.NOT_A_FILE, "Execution blocked: refusing to delete a symbolic link.");
	if (!stat.isFile())
		throw deleteFail(DELETE_OUTCOMES.NOT_A_FILE, `Not a regular file: ${normalized}.`);
	const { hash, size } = await sha256File(target);
	signal?.throwIfAborted();
	return { rel: normalized, abs: target, size, hash, mode: stat.mode & 0o7777,
		fingerprint: deleteFingerprint(normalized, hash, size) };
}

/**
 * Delete one authorized project file. Callers must already have passed the
 * permission/approval gate (guardTool): `approval.deleteFingerprint` is the
 * approved bytes, absent only in Full Access. Steps, in order:
 *   1. Re-validate the target and re-hash it (never trust the approval view).
 *   2. Honor the optional expected_hash precondition.
 *   3. Reject any change since approval (fingerprint mismatch).
 *   4. Capture the before-image through the recovery store; a capture failure
 *      blocks the deletion (never silent, never unprotected).
 *   5. Honor cancellation before the irreversible step, then re-hash once more
 *      and unlink only if the bytes are still exactly what was approved.
 *   6. Record the post-state (best-effort) so a later restore can tell this
 *      operation's own effect from later edits.
 */
async function executeDeleteProjectFile(root, args, { signal, recoveryCtx = {}, approval = null, fullAccess = false } = {}) {
	signal?.throwIfAborted();
	const snapshot = await prepareFileDelete(root, args?.path, { signal });

	if (args?.expected_hash !== undefined) {
		if (typeof args.expected_hash !== "string" || !/^[a-f0-9]{64}$/.test(args.expected_hash))
			throw deleteFail(DELETE_OUTCOMES.INVALID_PATH, "Invalid expected_hash: provide a lowercase SHA-256 hex digest.");
		if (args.expected_hash !== snapshot.hash)
			throw deleteFail(DELETE_OUTCOMES.CONFLICT,
				`File content changed: expected ${args.expected_hash.slice(0, 12)}… but found ${snapshot.hash.slice(0, 12)}….`);
	}

	if (!fullAccess) {
		if (!approval?.deleteFingerprint || approval.deleteFingerprint !== snapshot.fingerprint)
			throw deleteFail(DELETE_OUTCOMES.CONFLICT,
				"File content changed since approval. Review and approve the deletion again.");
	}

	let checkpoint;
	try {
		checkpoint = await recoveryStore.captureOperation({
			root,
			chatSessionId: recoveryCtx.chatSessionId ?? null,
			toolName: "delete_project_file",
			op: { kind: "delete", path: snapshot.rel, size: snapshot.size },
			paths: [snapshot.rel],
			// The file is about to disappear: any capture gap on it must block
			// the deletion instead of leaving it unprotected.
			required: [snapshot.rel],
			uncontained: false,
		});
	} catch (error) {
		throw deleteFail(DELETE_OUTCOMES.RECOVERY_FAILED,
			`Recovery capture failed; refusing to delete ${snapshot.rel} to protect its content: ${error.message}`);
	}

	// Cancellation is honored only before the irreversible step; after the
	// unlink the truthful outcome is `deleted`.
	signal?.throwIfAborted();
	const fresh = await prepareFileDelete(root, args?.path, { signal });
	if (fresh.abs !== snapshot.abs || fresh.hash !== snapshot.hash || fresh.size !== snapshot.size)
		throw deleteFail(DELETE_OUTCOMES.CONFLICT,
			`File changed immediately before deletion (${snapshot.rel}); nothing was deleted.`);

	await fs.unlink(snapshot.abs);
	try {
		await recoveryStore.recordOpPostState(checkpoint.checkpointId, { [snapshot.rel]: { k: "absent" } });
	} catch {
		/* Best-effort: a missing post-state only makes a later restore stricter. */
	}
	return {
		success: true,
		outcome: DELETE_OUTCOMES.DELETED,
		path: snapshot.rel,
		size: snapshot.size,
		sha256: snapshot.hash,
		recoveryCheckpointId: checkpoint.checkpointId,
	};
}

const MAX_BATCH_EDITS = 20;

async function executeEditProjectFiles(root, { edits }, uncontained, recoveryCtx = {}) {
	if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_BATCH_EDITS) {
		throw new Error(`edits must be an array of 1 to ${MAX_BATCH_EDITS} replacements.`);
	}
	// Phase 1 — validate everything before touching the filesystem. Several
	// edits may target the same file: each is applied, in order, to that file's
	// working copy, so a later edit's old_str is matched against the result of
	// the earlier ones (this is what makes a multi-spot single-file batch work
	// instead of silently clobbering). Every edit must still match exactly
	// once, or the whole batch is rejected with nothing written.
	const byTarget = new Map();
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index];
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
			throw new Error(`Edit ${index} must be an object with relative_path, old_str, and new_str.`);
		}
		const { relative_path, old_str, new_str } = edit;
		requireText(relative_path, "relative_path");
		requireText(new_str, "new_str", true);
		const target = await resolveWriteTarget(root, relative_path, uncontained);
		let entry = byTarget.get(target);
		if (!entry) {
			let content;
			try {
				content = await fs.readFile(target, "utf8");
			} catch (error) {
				if (error.code === "ENOENT") throw new Error(`Edit ${index}: file does not exist: ${relative_path}.`);
				throw error;
			}
			if (content.includes("\0")) throw new Error(`Edit ${index}: refusing binary file: ${relative_path}.`);
			entry = { target, relative_path, content };
			byTarget.set(target, entry);
		}
		const { start, end } = locateReplacement(entry.content, old_str);
		entry.content = entry.content.slice(0, start) + new_str + entry.content.slice(end);
	}
	// One entry per distinct file, in first-seen order.
	const planned = [...byTarget.values()].map(({ target, relative_path, content }) => ({
		target,
		relative_path,
		updated: content,
	}));
	// Phase 2 — all validated, write atomically per file. Before-images for
	// every target are captured first: validation is not atomicity, and a
	// disk error mid-sequence must still leave a complete recovery point
	// (plus a best-effort rollback) rather than a half-written batch.
	const writeAll = async () => {
		for (const { target, updated } of planned) await atomicWriteFile(target, updated);
		return { success: true, edited: planned.map(({ relative_path }) => relative_path) };
	};
	return withFileRecovery(root, {
		chatSessionId: recoveryCtx.chatSessionId ?? null,
		toolName: "edit_project_files",
		paths: planned.map(({ relative_path }) => relative_path),
		uncontained,
	}, writeAll);
}

// Minimal unified-diff application: exact context matching, validate-all-
// then-write. Supports modification hunks and file creation (--- /dev/null);
// file deletion is refused (use an explicit delete path instead).
const MAX_PATCH_HUNKS = 50;
const MAX_PATCH_CHARS = 200000;

function parseUnifiedPatch(patch) {
	requireText(patch, "patch", true);
	if (patch.length > MAX_PATCH_CHARS) {
		throw new Error(`Patch exceeds ${MAX_PATCH_CHARS} characters. Split it into smaller patches.`);
	}
	const files = [];
	const lines = patch.split("\n");
	let index = 0;
	const fileHeader = (line, marker) => {
		if (!line.startsWith(marker)) return null;
		let name = line.slice(marker.length).trim();
		if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
			try { name = JSON.parse(name); } catch { name = name.slice(1, -1); }
		}
		return name;
	};
	while (index < lines.length) {
		while (index < lines.length && lines[index].trim() === "") index++;
		if (index >= lines.length) break;
		const oldName = fileHeader(lines[index], "--- ");
		if (oldName === null) throw new Error(`Expected a --- file header at line ${index + 1}.`);
		const newName = fileHeader(lines[index + 1], "+++ ");
		if (newName === null) throw new Error(`Expected a +++ file header at line ${index + 2}.`);
		index += 2;
		const stripPrefix = (name) => name.replace(/^a\/|^b\//, "");
		const hunks = [];
		while (index < lines.length) {
			const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
			if (!header) break;
			index++;
			const hunk = { oldLines: [], newLines: [], header: lines[index - 1] };
			while (index < lines.length && /^[ +-\\]/.test(lines[index]) && !lines[index].startsWith("--- ")) {
				const marker = lines[index][0];
				const text = lines[index].slice(1);
				if (marker === " ") { hunk.oldLines.push(text); hunk.newLines.push(text); }
				else if (marker === "-") hunk.oldLines.push(text);
				else if (marker === "+") hunk.newLines.push(text);
				else if (marker === "\\") break;
				index++;
			}
			hunks.push(hunk);
		}
		if (!hunks.length) throw new Error(`No hunks found for ${oldName}.`);
		files.push({ oldName: stripPrefix(oldName), newName: stripPrefix(newName), hunks });
	}
	if (!files.length) throw new Error("No file patches found. Provide ---/+++ headers and @@ hunks.");
	if (files.length > MAX_PATCH_HUNKS) throw new Error(`Patch touches too many files (maximum ${MAX_PATCH_HUNKS}).`);
	return files;
}

async function executeApplyPatch(root, { patch }, uncontained, recoveryCtx = {}) {
	const parsed = parseUnifiedPatch(patch);
	// Phase 1 — validate everything before touching the filesystem.
	const planned = [];
	for (const file of parsed) {
		if (file.newName === "/dev/null") throw new Error(`Refusing to delete ${file.oldName}; delete files explicitly instead.`);
		const creating = file.oldName === "/dev/null";
		const target = await resolveWriteTarget(root, creating ? file.newName : file.oldName, uncontained);
		let lines = [];
		if (!creating) {
			let content;
			try {
				content = await fs.readFile(target, "utf8");
			} catch (error) {
				if (error.code === "ENOENT") throw new Error(`File does not exist: ${file.oldName}.`);
				throw error;
			}
			if (content.includes("\0")) throw new Error(`Refusing binary file: ${file.oldName}.`);
			lines = content.split("\n");
		}
		// Apply hunks against a working copy, tracking the line offset so
		// later hunks in the same file land correctly.
		let offset = 0;
		for (const hunk of file.hunks) {
			const needle = hunk.oldLines;
			let at = -1;
			if (needle.length) {
				for (let start = 0; start <= lines.length - needle.length; start++) {
					if (!needle.every((line, i) => line === lines[start + i])) continue;
					if (at !== -1) throw new Error(`Hunk is ambiguous in ${file.oldName} (${hunk.header.trim()}); add more context lines.`);
					at = start;
				}
				if (at === -1) throw new Error(`Hunk does not match ${file.oldName} (${hunk.header.trim()}); context must match exactly.`);
			} else {
				at = Math.max(0, Math.min(lines.length, offset));
			}
			const next = [...lines.slice(0, at), ...hunk.newLines, ...lines.slice(at + needle.length)];
			offset += hunk.newLines.length - needle.length;
			lines = next;
		}
		planned.push({ target, relative: creating ? file.newName : file.oldName, content: lines.join("\n"), creating });
	}
	// Phase 2 — all validated, write atomically per file. Every affected
	// file (including about-to-be-created ones, recorded as absent) is
	// captured before the first mutation.
	const writeAll = async () => {
		for (const { target, content, creating } of planned) {
			if (creating) await fs.mkdir(path.dirname(target), { recursive: true });
			await atomicWriteFile(target, content);
		}
		return { success: true, files: planned.map(({ relative }) => relative) };
	};
	return withFileRecovery(root, {
		chatSessionId: recoveryCtx.chatSessionId ?? null,
		toolName: "apply_patch",
		paths: planned.map(({ relative }) => relative),
	}, writeAll);
}

async function executeAgentTool({ id = null, name, arguments: rawArguments, sessionId, signal, engine, permissionMode, permissionGranted = false, rootPath, approval, onChildSession = null, budgetScope }) {	try {
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
        const { guardTool, effectiveMode, sessionProject } = require('../toolPermissions');
        const project = sessionProject(sessionId);
        permissionMode = effectiveMode(permissionMode, project);
        // Without an explicit permission grant the model cannot approve itself:
        // the inner guard runs with no approval channel, so anything that would
        // prompt is denied here. The IPC path grants after the real prompt and
        // passes that decision in as `approval`.
        let guardDecision = approval;
        if (!permissionGranted) guardDecision = await guardTool({ name, args, permissionMode, project, signal });
        // Uncontained means the user explicitly consented (full access, or an
        // approval grant): paths resolve freely and commands run outside the
        // bwrap sandbox. Everything else stays workspace-scoped and sandboxed.
        const uncontained = permissionMode === 'full_access' || guardDecision?.approved === true;
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
		if (name === "web_search") return await require("./webSearchProvider").searchWeb({ query: args.query, max_results: args.max_results, signal });
		if (name === "extract_web_page_data") return await require("../subAgentRunner").extractWebPageData({ ...args, engine, signal, parentSessionId: sessionId, budgetScope });
		if (name === "generate_image") return await require("./generateImage").generateImage({ ...args, signal });
		// Durable, session-owned task state: no filesystem or workspace access
		// is needed, so this resolves before the root checks below. Permission,
		// workspace scoping, and casual-session rejection are enforced by the
		// PLAN_WRITE capability and by workspacePlan itself.
		if (name === "update_plan") {
			signal?.throwIfAborted();
			return require("../workspacePlan").updatePlan(sessionId, args);
		}
		const readingFiles = ['spawn_sub_agent', 'delegate_task', 'read_project_file', 'list_directory', 'search_project_content', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame'].includes(name);
		// rootPath is an explicit root from the delegating caller (the child
		// agent loop passes its execution's project root, since a child session
		// has no database project of its own). It is honored only for read-only
		// tools: writes and commands keep resolving their root from the session
		// project, so this override can never redirect a mutation.
		const root = readingFiles ? path.resolve(rootPath ?? project?.root_path ?? process.cwd())
			: await fs.realpath(project?.root_path ?? (uncontained ? process.cwd() : sessionRoot(sessionId)));
		if (!readingFiles && !(await fs.stat(root)).isDirectory()) throw new Error("Project root is not a directory.");
		if (name === "spawn_sub_agent")
			return await executeSpawnSubagent({ ...args, rootPath: root, engine, signal, parentSessionId: sessionId,
				budgetScope, parentToolCallId: typeof id === 'string' ? id : null,
				...(typeof onChildSession === 'function' ? { onSpawn: onChildSession } : {}) });
		if (name === "delegate_task")
			return await require("../subAgentRunner").runSubAgent({
				...args,
				rootPath: root,
				engine,
				signal,
				parentSessionId: sessionId, budgetScope,
			});
		if (name === "execute_command") {
			// Contained commands run inside the bwrap sandbox (workspace_write and
			// unapproved ask_approval alike); an approval grant or full access runs
			// them directly, since explicit consent is the escape hatch.
			// Phase 2 recovery: shell can change unknown paths, so the whole
			// eligible workspace is captured before and diffed after. Guard and
			// sandboxing above are unchanged; without a workspace there is
			// nothing authorized to capture and the command runs as before.
			const { result } = await runScopedCommand("execute_command", args, {
				root,
				signal,
				uncontained,
				sessionId,
				recoveryRoot: project?.root_path,
				timeoutMs: 45000,
			});
			return result;
		}
		if (name === "run_tests") {
			// Same execution path as execute_command; the raw result is then
			// classified into a structured pass/fail verdict. Permission,
			// sandbox, workspace, timeout, cancellation, and recovery behavior
			// are inherited unchanged.
			return await runVerification(args, {
				root,
				signal,
				uncontained,
				sessionId,
				recoveryRoot: project?.root_path,
			});
		}
		if (name === "search_project_content") return await searchContent(root, args, signal);
		if (name.startsWith("git_")) {
			// Git inspection needs a real project workspace: without one the
			// fallback root would be the app directory itself, which must
			// never be exposed to the model as a git repository.
			if (!project?.root_path && !rootPath) throw new Error("Git tools require a project workspace.");
			if (!(await fs.stat(root)).isDirectory()) throw new Error("Project root is not a directory.");
			return await executeGitTool(root, name, args, signal, uncontained, guardDecision, permissionMode === 'full_access');
		}
		if (name === "delete_project_file") {
			// Deletion never uses the full-access / process.cwd fallback root:
			// it must always have a real project workspace, and it stays
			// workspace-contained even in full_access (there is deliberately no
			// outside-workspace escape for deletion). `root` above already
			// resolved from project.root_path.
			if (!project?.root_path)
				return { success: false, outcome: "permission_denied", error: "Execution blocked: File deletion requires a project workspace." };
			return await executeDeleteProjectFile(root, args, {
				signal,
				recoveryCtx: { chatSessionId: sessionId ?? null },
				approval: guardDecision,
				fullAccess: permissionMode === "full_access",
			});
		}
		const target = ["read_project_file", "list_directory"].includes(name)
			? await readablePath(root, args.relative_path ?? ".")
			: uncontained ? path.resolve(root, args.relative_path ?? ".") : await scopedPath(root, args.relative_path ?? ".", true);
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
			const write = async () => {
				await fs.mkdir(path.dirname(target), { recursive: true });
				await atomicWriteFile(target, args.content);
				return { success: true };
			};
			return await withFileRecovery(root, {
				chatSessionId: sessionId ?? null,
				toolName: "write_project_file",
				paths: [args.relative_path],
				uncontained,
			}, write);
		}
		if (name === "move_project_file")
			return await executeMoveProjectFile(root, args, uncontained, { chatSessionId: sessionId ?? null });
		if (name === "edit_project_files")
			return await executeEditProjectFiles(root, args, uncontained, { chatSessionId: sessionId ?? null });
		if (name === "apply_patch")
			return await executeApplyPatch(root, args, uncontained, { chatSessionId: sessionId ?? null });
		return await executeStrReplaceEditor(target, args, {
			root, rel: args.relative_path, chatSessionId: sessionId ?? null, uncontained,
		});
	} catch (error) {
		const result = { success: false, error: error.message };
		if (name === "delete_project_file") {
			// A truthful outcome for every non-deleted end state, including
			// failures raised by the permission guard (which runs inside this
			// try, so its typed errors land here too).
			result.outcome = error?.deleteOutcome
				?? (error?.code === "APPROVAL_DENIED" ? "approval_denied"
					: error?.code === "PERMISSION_DENIED" ? "permission_denied"
						: error?.name === "AbortError" || error?.code === "ABORT_ERR" ? "cancelled"
							: "error");
		}
		if (name === "web_search") {
			// web_search classifies its own provider outcomes and only throws
			// for guard denials, cancellation, or malformed input. Type those
			// same three cases here so the tool result stays truthful.
			result.outcome = error?.code === "APPROVAL_DENIED" || error?.code === "PERMISSION_DENIED"
				? "permission_denied"
				: error?.name === "AbortError" || error?.code === "ABORT_ERR" ? "cancelled"
					: "error";
		}
		return result;
	}
}

module.exports = {
	prepareGitCommit,
	prepareGitPush,
	// Deletion permission gate + execution share this exact validation, so the
	// approved snapshot and the executed snapshot can never diverge silently.
	prepareFileDelete,
	approvedMutations,
	agentTools,
	executeAgentTool,
	getRecentChatHistory,
	hasProjectWorkspace,
	truncateOutput,
	scopedPath,
	isPathAllowed,
	screenshot,
	atomicWriteFile,
	// Verification primitive: raw command runner plus the pure classifier used
	// by run_tests, exported so focused tests can assert outcome distinctions
	// without a full model round trip.
	executeCommand,
	structureVerification,
	verificationStatus,
	// Reused by the recovery diff-review IPC for sandboxed read-only git
	// inspection (status/numstat/diff). Same runner, same guarantees.
	runGit,
};
