'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

// Shared catalog (single source of truth with the renderer's permission
// selector in src/lib/permissionModes.mjs). The renderer reads the same JSON,
// so the UI and this engine can never disagree about which modes exist or
// what the per-context defaults are. tests/permissionSelector.test.mjs pins
// the two sides together.
const { modes, defaults } = require('../lib/permissionModes.json');
if (!Array.isArray(modes) || !modes.length ||
	![defaults?.casual, defaults?.workspace].every(mode => modes.includes(mode))) {
	throw new Error('Invalid shared permission mode catalog.');
}
const MODES = Object.freeze([...modes]);

// ---------------------------------------------------------------------------
// Capability model (single source of truth)
//
// Every tool maps to exactly one capability. The capability table below
// determines, per permission mode, whether a tool is visible to the model and
// whether it executes without prompting. Visibility (getToolContext) and
// executability (guardTool) both read this same table, so they can never
// disagree: a tool the policy denies is hidden, a tool the policy allows or
// approves is advertised.
//
// The bwrap sandbox and workspace path checks are the real security boundary.
// Opaque process execution requires specific approval. The legacy command
// heuristic remains exported for compatibility and is not an authorization gate.
// ---------------------------------------------------------------------------

const CAPABILITIES = Object.freeze({
	LSP: 'lsp', // trusted bundled JS/TS process; exact feature-specific mode policy
	READ: 'read', // reads files, searches, history, screenshots
	WORKSPACE_WRITE: 'workspace_write', // create/edit/delete files in the workspace
	LOCAL_EXECUTION: 'local_execution', // shell commands (sandboxed unless approved)
	EXTERNAL_MUTATION: 'external_mutation', // generates or side-effects outside the workspace
	MEMORY_WRITE: 'memory_write', // persists into assistant memory
	PLAN_WRITE: 'plan_write', // updates the session-owned workspace task plan
	PLAN_READ: 'plan_read', // reads same-project workspace task plans (read-only)
	AGENT_SPAWN: 'agent_spawn', // spawns a sub-agent (child runs read-only)
	FILE_DELETE: 'file_delete', // deletes one in-workspace file; always confirms, workspace-contained
});

// Built-in tool -> capability mapping. `native` is true for main-process tools
// and false for MCP-hosted tools, which resolve dynamically in capabilityOf.
const TOOL_CAPABILITIES = Object.freeze({
	// LSP
	...Object.fromEntries(['lsp_definition', 'lsp_references', 'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_hover', 'lsp_diagnostics'].map(name => [name, CAPABILITIES.LSP])),
	// READ
	manage_native_tools: CAPABILITIES.READ,
	find_and_prepare_mcp_tools: CAPABILITIES.EXTERNAL_MUTATION,
	get_recent_chat_history: CAPABILITIES.READ,
    get_command_status: CAPABILITIES.READ,
    stop_background_command: CAPABILITIES.READ,
	search_project_content: CAPABILITIES.READ,
	search_code: CAPABILITIES.READ,
	read_project_file: CAPABILITIES.READ,
	read_file: CAPABILITIES.READ,
	list_directory: CAPABILITIES.READ,
	take_screenshot: CAPABILITIES.READ,
	search_memory: CAPABILITIES.READ,
	web_search: CAPABILITIES.READ,
	get_single_web_page_content: CAPABILITIES.READ,
	extract_web_page_data: CAPABILITIES.READ,
	use_skill: CAPABILITIES.READ,
	propose_skill: CAPABILITIES.READ,
	git_status: CAPABILITIES.READ,
	git_diff: CAPABILITIES.READ,
	git_log: CAPABILITIES.READ,
	git_show: CAPABILITIES.READ,
	git_branch: CAPABILITIES.READ,
	git_blame: CAPABILITIES.READ,
	// Staging stays in-workspace (contained like other writes). Committing
	// creates persistent shared history, so it always confirms: modeled as an
	// external mutation, which prompts in every mode except full_access.
	git_stage: CAPABILITIES.WORKSPACE_WRITE,
	git_unstage: CAPABILITIES.WORKSPACE_WRITE,
	git_stash: CAPABILITIES.WORKSPACE_WRITE,
	// Push publishes history beyond the workspace, so the whole sync tool
	// prompts like a commit; fetch/pull refine that per-action in guardTool.
	git_sync: CAPABILITIES.EXTERNAL_MUTATION,
	git_commit: CAPABILITIES.EXTERNAL_MUTATION,
	// Branch create/switch mutates refs and the worktree, so it stays a
	// contained workspace write (sandboxed, never a read-only child tool).
	// Commit-like history creation still prompts via EXTERNAL_MUTATION above.
	git_create_branch: CAPABILITIES.WORKSPACE_WRITE,
	git_switch: CAPABILITIES.WORKSPACE_WRITE,
	// WORKSPACE_WRITE
	write_project_file: CAPABILITIES.WORKSPACE_WRITE,
	write_file: CAPABILITIES.WORKSPACE_WRITE,
	str_replace_editor: CAPABILITIES.WORKSPACE_WRITE,
	edit_project_files: CAPABILITIES.WORKSPACE_WRITE,
	apply_patch: CAPABILITIES.WORKSPACE_WRITE,
	move_project_file: CAPABILITIES.WORKSPACE_WRITE,
	edit_file: CAPABILITIES.WORKSPACE_WRITE,
	delete_file: CAPABILITIES.WORKSPACE_WRITE,
	// Deletion is the most destructive in-workspace action: it is modeled as
	// its own capability so it always confirms (except Full Access) and is
	// denied without a workspace, while reusing the existing approval flow.
	delete_project_file: CAPABILITIES.FILE_DELETE,
	// LOCAL_EXECUTION
	execute_command: CAPABILITIES.LOCAL_EXECUTION,
	run_tests: CAPABILITIES.LOCAL_EXECUTION,
	// EXTERNAL_MUTATION
	generate_image: CAPABILITIES.EXTERNAL_MUTATION,
	manage_mcp_servers: CAPABILITIES.EXTERNAL_MUTATION,
	approve_mcp_mutation: CAPABILITIES.EXTERNAL_MUTATION,
	// MEMORY_WRITE
	save_memory: CAPABILITIES.MEMORY_WRITE,
	// PLAN_WRITE
	update_plan: CAPABILITIES.PLAN_WRITE,
	// PLAN_READ (read-only, same-project)
	get_project_plans: CAPABILITIES.PLAN_READ,
	// AGENT_SPAWN
	spawn_sub_agent: CAPABILITIES.AGENT_SPAWN,
	delegate_task: CAPABILITIES.AGENT_SPAWN,
});

/**
 * Resolve the capability of a tool. Returns null for unknown tools so the
 * policy fails closed (deny outside ask_approval) instead of guessing.
 */
function capabilityOf(name, native = true) {
	if (typeof name !== 'string' || !name) return null;
	if (native === false) {
		// MCP tools are externally hosted. Workspace Write authorizes ordinary
		// calls, with approval for Git publication and project file deletion.
		// Ask for Approval prompts; Full Access bypasses approval gates.
		return CAPABILITIES.EXTERNAL_MUTATION;
	}
	return TOOL_CAPABILITIES[name] ?? null;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

function resolveMode(mode, project) {
	const value = mode ?? project?.permissionMode ?? project?.permission_mode ?? (project ? defaults.workspace : defaults.casual);
	if (!MODES.includes(value)) throw new Error('Invalid permission mode.');
	return value;
}

/**
 * The configured project workspace root, or null when there is none. Mode
 * normalization and visibility decisions use this presence check; guardTool's
 * containment checks re-verify the directory for real (workspacePath fails
 * closed when the root does not exist).
 */
function projectRoot(project) {
	if (!project || typeof project !== 'object') return null;
	const raw = project.rootDirectory ?? project.root_path ?? project.rootPath;
	return typeof raw === 'string' && raw.trim() ? raw : null;
}

/**
 * Casual chats (no project workspace) never run in workspace_write mode:
 * workspace file writes are meaningless without a workspace, so the mode
 * normalizes to ask_approval, which keeps reads available and prompts for
 * anything mutating.
 */
function normalizeMode(permissionMode, root) {
	if (permissionMode === 'workspace_write' && !root) return 'ask_approval';
	return permissionMode;
}

/**
 * The effective permission mode every policy decision (visibility and
 * guardTool) is based on: resolve the mode, then normalize it against the
 * presence of a project workspace.
 */
function effectiveMode(permissionMode, project) {
	return normalizeMode(resolveMode(permissionMode, project), projectRoot(project));
}

/**
 * The permission modes a chat in this context may run under: exactly those
 * whose effective mode equals themselves. Anything the engine would silently
 * normalize (workspace_write without a workspace root) is excluded, so the
 * permission selector UI never advertises a mode that would not be honored.
 * The renderer mirrors this rule in src/lib/permissionModes.mjs; tests assert
 * the two agree.
 */
function availableModes(project) {
	const root = projectRoot(project);
	return MODES.filter(mode => normalizeMode(mode, root) === mode);
}

function sessionProject(sessionId) {
	if (!sessionId) return null;
	return require('./db').db.prepare('SELECT p.* FROM projects p JOIN sessions s ON s.project_id = p.id WHERE s.id = ?').get(sessionId) ?? null;
}

/**
 * Every filesystem path a write tool may touch, for containment checks.
 * Unknown shapes fail closed (empty list → invalid input below).
 */
function writeTargets(name, args) {
	if (name === "move_project_file") return [args?.source_path, args?.destination_path];
	if (name === "git_stage" || name === "git_unstage") {
		if (!Array.isArray(args?.paths)) return [];
		return args.paths;
	}
	// Branch, stash, and sync tools touch no caller-supplied path; containing
	// them to the project root itself verifies the workspace without opening
	// any escape.
	if (name === "git_create_branch" || name === "git_switch" || name === "git_stash" || name === "git_sync") return ["."];
	if (name === "edit_project_files") {
		if (!Array.isArray(args?.edits)) return [];
		return args.edits.map((edit) => edit?.relative_path);
	}
	if (name === "apply_patch" && typeof args?.patch === "string") {
		const paths = [];
		for (const line of args.patch.split("\n")) {
			if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
			const name = line
				.slice(4)
				.trim()
				.replace(/^["']|["']$/g, "")
				.replace(/^a\/|^b\//, "");
			if (name && name !== "/dev/null") paths.push(name);
		}
		return paths;
	}
	return [args?.relative_path ?? args?.path ?? args?.file_path ?? args?.filePath];
}

/**
 * Containment validator: resolve `value` against `root`, rejecting lexical
 * traversal, sibling-prefix paths and symlinks (including dangling ones) that
 * escape the workspace. Every failure message starts with "Execution blocked:"
 * so callers can distinguish containment violations from input errors.
 */
async function workspacePath(root, value) {
	if (!root) throw new Error('Workspace Write requires a project root.');
	if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path.');
	root = await fs.realpath(root);
	const target = path.resolve(root, value);
	if (!inside(root, target)) throw new Error('Execution blocked: Path escapes the project root.');
	let current = root;
	for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try { await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
		if (!inside(root, await fs.realpath(current))) throw new Error('Execution blocked: Symlink escapes the project root.');
	}
	return target;
}

function inside(root, target) {
	const relative = path.relative(root, target);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// Policy table
//
// Coarse, synchronous decision used for BOTH tool visibility and as the base
// of the async execution guard. Async containment checks (workspacePath,
// directory stats) only ever refine a decision downwards (allow -> approve or
// deny); they never turn a coarse deny into an allow.
// ---------------------------------------------------------------------------

function baseDecision({ capability, mode, hasWorkspace, native }) {
	if (capability === CAPABILITIES.LSP) return hasWorkspace && ['workspace_write', 'full_access'].includes(mode)
		? { decision: 'allow' } : { decision: 'deny', reason: 'Execution blocked: LSP requires a workspace and Workspace Write or Full Access.' };
	// Plan reads (like plan writes) are meaningless without a Workspace session
	// to scope them to: a Casual Chat must never reach another chat's plan, in
	// any mode. Checked before the per-mode branches so visibility and
	// execution agree everywhere (including read_only and full_access).
	if (!hasWorkspace && capability === CAPABILITIES.PLAN_READ) {
		return { decision: 'deny', reason: 'Execution blocked: Task plans require a project workspace.' };
	}

	// Full access is unrestricted (the OS sandbox/bwrap boundary still applies).
	// A plan, however, has no meaning without a Workspace session to own it; a
	// casual chat stays casual even in full access. File deletion is likewise
	// meaningless without a workspace (there is nothing to delete into), so it
	// stays denied rather than offering an outside-workspace escape.
	if (mode === 'full_access') {
		if (!hasWorkspace && (capability === CAPABILITIES.PLAN_WRITE || capability === CAPABILITIES.FILE_DELETE)) {
			return {
				decision: 'deny',
				reason: capability === CAPABILITIES.FILE_DELETE
					? 'Execution blocked: File deletion requires a project workspace.'
					: 'Execution blocked: Task plans require a project workspace.',
			};
		}
		return { decision: 'allow' };
	}

	// Read only: reads, agent spawns (children are read-only), and same-project
	// plan reads (a workspace exists at this point).
	if (mode === 'read_only') {
		if (capability === CAPABILITIES.READ || capability === CAPABILITIES.AGENT_SPAWN ||
			capability === CAPABILITIES.PLAN_READ) return { decision: 'allow' };
		return { decision: 'deny', reason: 'Execution blocked: Chat is in Read Only mode.' };
	}

	// Unknown capability (a native tool the policy does not know): never run
	// silently. Prompt in ask_approval, fail closed everywhere else.
	if (capability === null) {
		return mode === 'ask_approval'
			? { decision: 'approve' }
			: { decision: 'deny', reason: 'Execution blocked: This tool cannot be confined to the project workspace. Select Ask for Approval or Full Access.' };
	}

	// Reads, agent spawns and memory writes are safe in every non-read mode.
	if (capability === CAPABILITIES.READ ||
		capability === CAPABILITIES.AGENT_SPAWN ||
		capability === CAPABILITIES.MEMORY_WRITE) {
		return { decision: 'allow' };
	}

	// Casual chat (no project workspace): there is nothing to write into.
	if (!hasWorkspace) {
		if (capability === CAPABILITIES.WORKSPACE_WRITE) {
			return { decision: 'deny', reason: 'Execution blocked: File writes require a project workspace.' };
		}
		if (capability === CAPABILITIES.FILE_DELETE) {
			return { decision: 'deny', reason: 'Execution blocked: File deletion requires a project workspace.' };
		}
		if (capability === CAPABILITIES.PLAN_WRITE) {
			return { decision: 'deny', reason: 'Execution blocked: Task plans require a project workspace.' };
		}
		// Shell commands and external mutations have no workspace to contain
		// them in casual mode -> always prompt.
		return { decision: 'approve' };
	}

	// Workspace context: in-workspace work runs autonomously in both workspace
	// modes. guardTool refines these with async containment checks: anything
	// outside the workspace or system-affecting is approved in ask_approval and
	// denied in workspace_write.
	if (capability === CAPABILITIES.WORKSPACE_WRITE || capability === CAPABILITIES.LOCAL_EXECUTION ||
		capability === CAPABILITIES.PLAN_WRITE || capability === CAPABILITIES.PLAN_READ) {
		return { decision: 'allow' };
	}

	// External mutations: MCP tools run autonomously in workspace_write;
	// Git publication is checked separately by evaluateTool. Everything else
	// (image generation, MCP server management) prompts unless approved.
	if (capability === CAPABILITIES.EXTERNAL_MUTATION) {
		if (!native && mode === 'workspace_write') return { decision: 'allow' };
		return { decision: 'approve' };
	}

	return { decision: 'approve' };
}

/**
 * Whether a tool is visible in the current permission context. Uses the same
 * policy table as guardTool so what the model sees always matches what it can
 * execute.
 */
function isToolVisible(name, { permissionMode, project, native = true } = {}) {
	if (native && ['manage_mcp_servers', 'find_and_prepare_mcp_tools'].includes(name)) return true; // Search is read-only; mutation actions are guarded separately.
	const root = projectRoot(project);
	const mode = normalizeMode(resolveMode(permissionMode, project), root);
	const { decision } = baseDecision({
		capability: capabilityOf(name, native),
		mode,
		hasWorkspace: Boolean(root),
		native,
	});
	return decision !== 'deny';
}

// ---------------------------------------------------------------------------
// System-affecting command heuristic (prompt gating ONLY)
//
// Deliberately a coarse denylist deciding whether an in-workspace shell
// command must request approval before running. It is NOT a security
// boundary: real containment comes from the bwrap sandbox and workspace path
// checks. Commands that mutate the system outside the workspace cannot be
// confined to it, so they ask for approval instead of failing outright.
// ---------------------------------------------------------------------------

const SYSTEM_PREFIXES = new Set([
	'sudo', 'doas', 'pkexec',
	'apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'pacman', 'zypper', 'apk', 'brew',
	'systemctl', 'service', 'initctl', 'update-rc.d', 'chkconfig',
	'shutdown', 'reboot', 'halt', 'poweroff',
	'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd', 'chpasswd',
	'crontab',
	'mkfs', 'fdisk', 'parted', 'mount', 'umount', 'losetup', 'swapon', 'swapoff',
	'modprobe', 'rmmod', 'insmod',
	'sysctl', 'iptables', 'nft', 'ufw',
	'docker', 'podman', 'nerdctl', 'lxc',
	'chroot', 'nsenter',
	'ifconfig', 'nmcli',
]);

function isSystemAffecting(command) {
	// Fail closed: only a real command string can be judged non-system-affecting.
	if (typeof command !== 'string' || !command.trim() || command.includes('\0')) return true;
	// Remove quote characters so quoted arguments are inspected like the shell
	// would see them ('sudo' true runs sudo; rm -rf "/home" deletes /home).
	const normalized = command.trim().toLowerCase().replace(/["']/g, '');

	// Global package installs. Local installs stay autonomous: they write into
	// the workspace (node_modules, vendor) or the sandbox-local home.
	if (/\b(?:npm|pnpm|yarn|pipx?|pip\d+)\s+(?:install|add|i)\b[^|;&]*(?:\s-g\b|\s--global\b)/.test(normalized)) return true;
	if (/\byarn\s+global\s+(?:add|install|upgrade)\b/.test(normalized)) return true;
	// Publishing reaches outside the workspace (public registries).
	if (/\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish|deprecate)\b/.test(normalized)) return true;

	// Fetch-and-execute pipelines.
	if (/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sh|bash|zsh|fish)\b/.test(normalized)) return true;

	// Redirects to absolute system locations (relative redirects stay inside
	// the sandboxed working directory; /tmp is the workspace-local temp area).
	for (const match of normalized.matchAll(/(^|[^>])>>?\s*(~[^\s;|&]*|\/[^\s;|&]*)/g)) {
		const target = match[2];
		if (target.startsWith('~/')) return true;
		const top = `/${(target.split('/')[1] ?? '')}`;
		if (!['/tmp', '/dev', '/proc'].includes(top)) return true;
	}

	// Permission changes on system locations.
	if (/\b(?:chmod|chown)\b[^;&|]*\s\/(?!tmp\/|dev\/|proc\/)/.test(normalized)) return true;

	// Recursive deletes of system, home or parent locations.
	if (/\brm\s+(?:-[a-z]*r[a-z]*|--recursive)\b[^;&|]*\s(?:\/|~|\$home\b|\.\.(?:\/|\s|$))/.test(normalized)) return true;

	// Any invocation of a system-affecting program as the first token of a
	// shell segment (including suffixed variants like mkfs.ext4).
	const systemPrefixes = [...SYSTEM_PREFIXES];
	for (const segment of normalized.split(/&&|\|\||[;|]/)) {
		const token = segment.trim().split(/\s+/)[0] ?? '';
		if (!token) continue;
		const base = token.split('/').pop();
		if (SYSTEM_PREFIXES.has(token) || SYSTEM_PREFIXES.has(base) ||
			systemPrefixes.some((prefix) => base.startsWith(`${prefix}.`))) return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function requestToolApproval({ controller, sender, requestId, sessionId, name, args }) {
	return new Promise(resolve => {
		const approvalId = require('node:crypto').randomUUID();
		const finish = allowed => {
			if (!controller.toolApprovals?.delete(approvalId)) return;
			clearTimeout(timer);
			controller.signal.removeEventListener('abort', stop);
			if (!sender.isDestroyed()) sender.send('engine:request-tool-approval', { requestId, sessionId, approvalId, resolved: true });
			resolve(allowed);
		};
		const stop = () => finish(false);
		const timer = setTimeout(stop, 120000);
		controller.toolApprovals ??= new Map();
		controller.toolApprovals.set(approvalId, finish);
		controller.signal.addEventListener('abort', stop, { once: true });
		if (controller.signal.aborted || sender.isDestroyed()) return stop();
		sender.send('engine:request-tool-approval', { requestId, sessionId, approvalId, name, args });
	});
}

function approvalDeniedMessage(kind) {
	const label = {
		tool: 'Tool',
		image: 'Image generation',
		system: 'System-affecting command',
		outside: 'Outside-workspace write',
	}[kind] || 'Tool';
	return `Execution blocked: ${label} approval denied.`;
}

// Keep approval payloads bounded without hiding what is approved: truncation
// is explicit so the user can see there is more content than shown.
function sanitizeParams(params) {
	if (!params || typeof params !== 'object') return {};
	const out = {};
	for (const [key, value] of Object.entries(params)) {
		if (typeof value === 'string' && value.length > 4000) out[key] = `${value.slice(0, 4000)}…[truncated]`;
		else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
		else out[key] = Array.isArray(value) ? `[${value.length} items]` : '[object]';
	}
	return out;
}

async function requestApproval(kind, name, args, requestApprovalHandler, signal) {
	let approved = false;
	try {
		approved = Boolean(requestApprovalHandler) &&
			Boolean(await requestApprovalHandler({ name, args: sanitizeParams(args) }));
	} catch {
		approved = false;
	}
	if (!approved) {
		const error = new Error(approvalDeniedMessage(kind));
		error.code = 'APPROVAL_DENIED';
		throw error;
	}
	signal?.throwIfAborted();

	return true;
}

// ---------------------------------------------------------------------------
// Execution guard
//
// Returns the effective mode and explicit consent decision. For commands,
// commandUncontained separately controls sandbox escape; approval alone does
// not remove workspace containment. guardTool issues a single-use capability.
// ---------------------------------------------------------------------------

async function evaluateTool({ name, args = {}, permissionMode, project, requestApproval: approvalHandlerFn, signal, native = true, serverName }) {
	const root = projectRoot(project);
	const mode = normalizeMode(resolveMode(permissionMode, project), root);
	signal?.throwIfAborted();
	if (native && require('./nativeExecutionPolicy').isCommand(name)) {
		if (mode === 'read_only') throw Object.assign(new Error('Execution blocked: Chat is in Read Only mode.'), { code: 'PERMISSION_DENIED' });
		if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0')) throw new Error('Invalid command.');
		if (args.command.length > 4000 || (typeof args.cwd === 'string' && args.cwd.length > 4000))
			throw new Error('Execution blocked: Command or cwd exceeds the reviewable approval limit (4000 characters).');
		// No command text, development-script name or model-supplied flag proves
		// an arbitrary program's effects. Every process invocation needs consent.
		let uncontained = mode === 'full_access' || !root;
		if (root && mode !== 'full_access') {
			try {
				const cwd = await workspacePath(root, args.cwd ?? '.');
				if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Execution blocked: Command cwd must be a directory.');
			} catch (error) {
				if (mode !== 'ask_approval' || !String(error.message).startsWith('Execution blocked:')) throw error;
				uncontained = true;
			}
		}
		await requestApproval('tool', name, { ...args, execution_scope: uncontained
			? 'Uncontained opaque process: host filesystem, inherited environment and network access; may perform external actions.'
			: 'Opaque process: workspace writes, read-only host filesystem, isolated network and restricted environment.' }, approvalHandlerFn, signal);
		return { mode, approved: true, commandUncontained: uncontained };
	}
	if (native && ((name === 'manage_mcp_servers' && args?.action === 'search') || (name === 'find_and_prepare_mcp_tools' && mode === 'read_only'))) return { mode, approved: false };
	if (native && name === 'approve_mcp_mutation' && mode !== 'read_only') return { mode, approved: await requestApproval('tool', name, args, approvalHandlerFn, signal) };
	if (!native && mode !== 'read_only' && require('./mcpPermissionPolicy').requiresOutboundApproval(name, args)) {
        return { mode, approved: await requestApproval('tool', name, args, approvalHandlerFn, signal) };
    }
	if (!native && mode === 'full_access' && require('./mcpPermissionPolicy').requiresGitApproval(name, args, serverName)) {
		return { mode, approved: await requestApproval('tool', name, args, approvalHandlerFn, signal) };
	}
	if (mode === 'workspace_write' && root && ((native && ['manage_mcp_servers', 'find_and_prepare_mcp_tools'].includes(name)) || !native)) {
		if (!native && (name === 'delete_project_file' || require('./mcpPermissionPolicy').requiresGitApproval(name, args, serverName))) {
			return { mode, approved: await requestApproval('tool', name, args, approvalHandlerFn, signal) };
		}
		return { mode, approved: false };
	}
	if (native && name === 'git_sync' && mode !== 'read_only') {
		if (!root) throw new Error('Git tools require a project workspace.');
		if (!['fetch', 'pull', 'push'].includes(args.action)) throw new Error('action must be one of "fetch", "pull", or "push".');
		// Even fetch may invoke repository-controlled transport helpers. Ask
		// before preparation, which can itself contact the remote.
		await requestApproval('tool', name, { ...args, action: args.action === 'push' ? 'prepare_push' : args.action,
			execution_scope: 'Git remote operation with network access and repository configuration; may execute transport helpers. Push preparation reads remote state; publication requires a separate history review.' }, approvalHandlerFn, signal);
		const snapshot = args.action === 'push' ? await require('./tools/agentTools').prepareGitPush(root, args, signal) : null;
		if (snapshot) await requestApproval('tool', name, { action: 'push', remote: snapshot.remote, branch: snapshot.branch, outgoing: snapshot.summary }, approvalHandlerFn, signal);
		return { mode, approved: true, ...(snapshot ? { gitPushFingerprint: snapshot.fingerprint } : {}) };
	}
	if (mode === 'full_access') {
		// Full access does not create a workspace: a task plan still needs the
		// session to own a project, and file deletion has nothing to target.
		// Keep this in step with baseDecision so visibility and execution never
		// disagree.
		const fullAccessCapability = capabilityOf(name, native);
		if (fullAccessCapability === CAPABILITIES.LSP && !root) { const error = new Error('LSP requires a project workspace.'); error.code = 'PERMISSION_DENIED'; throw error; }
		if (!root && (fullAccessCapability === CAPABILITIES.PLAN_WRITE || fullAccessCapability === CAPABILITIES.FILE_DELETE ||
			fullAccessCapability === CAPABILITIES.PLAN_READ)) {
			const error = new Error(fullAccessCapability === CAPABILITIES.FILE_DELETE
				? 'Execution blocked: File deletion requires a project workspace.'
				: 'Execution blocked: Task plans require a project workspace.');
			error.code = 'PERMISSION_DENIED';
			throw error;
		}
		return { mode, approved: false };
	}
	if (name === 'git_commit' && mode !== 'read_only') {
		if (!root) throw new Error('Git tools require a project workspace.');
		const snapshot = await require('./tools/agentTools').prepareGitCommit(root, signal);
		const approved = await requestApproval('tool', name, { ...args, staged_diff: snapshot.stagedDiff }, approvalHandlerFn, signal);
		return { mode, approved, gitCommitFingerprint: snapshot.fingerprint };
	}

	const capability = capabilityOf(name, native);
	const { decision, reason } = baseDecision({ capability, mode, hasWorkspace: Boolean(root), native });
	if (decision === 'deny') {
		const error = new Error(reason);
		error.code = 'PERMISSION_DENIED';
		throw error;
	}

	if (capability === CAPABILITIES.FILE_DELETE) {
		// baseDecision already denied casual chats (no workspace) and read-only
		// chats; a root exists here. Deletion always confirms — even for a
		// contained in-workspace file — mirroring git_commit. The approval
		// payload names the exact file and size, and a content fingerprint is
		// bound so any change between approval and execution is rejected. The
		// deletion itself stays workspace-contained: there is deliberately no
		// outside-workspace approval escape.
		const snapshot = await require('./tools/agentTools').prepareFileDelete(root, args?.path, { signal });
		const approved = await requestApproval('tool', name,
			{ operation: 'delete', path: snapshot.rel, size: snapshot.size }, approvalHandlerFn, signal);
		return { mode, approved, deleteFingerprint: snapshot.fingerprint };
	}

	if (capability === CAPABILITIES.READ) {
		// The capture is read-only, but its optional saved artifact must stay in
		// the workspace (parity with the legacy screenshot containment check).
		if (mode === 'workspace_write' && root && name === 'take_screenshot') {
			await workspacePath(root, '.llm_workspace/screenshots');
		}
		return { mode, approved: false };
	}
	if (capability === CAPABILITIES.AGENT_SPAWN || capability === CAPABILITIES.MEMORY_WRITE ||
		capability === CAPABILITIES.PLAN_WRITE || capability === CAPABILITIES.PLAN_READ) {
		return { mode, approved: false };
	}

	if (capability === CAPABILITIES.WORKSPACE_WRITE) {
		// baseDecision already denied casual writes (no workspace), so a root
		// exists here; workspacePath re-verifies it fails closed.
		// Multi-path tools expose every path they will touch so each one is
		// contained before execution (which re-validates content anyway).
		const targets = writeTargets(name, args);
		try {
			for (const target of targets) await workspacePath(root, target);
		} catch (error) {
			const message = String(error?.message ?? '');
			if (message.startsWith('Execution blocked:') && mode === 'ask_approval') {
				// Workspace-relative writes stay contained; a write outside the
				// workspace prompts the user instead of failing outright.
				return { mode, approved: await requestApproval('outside', name, args, approvalHandlerFn, signal) };
			}
			// Traversal, symlink escapes and invalid input fail closed in
			// workspace_write mode (and for non-containment errors everywhere).
			throw error;
		}
		// Contained in-workspace writes run autonomously in both workspace modes.
		return { mode, approved: false };
	}

	// External mutations (image generation, MCP management, MCP-hosted tools)
	// and unknown capabilities in ask_approval: one explicit approval prompt.
	if (decision === 'approve') {
		const kind = native === true && name === 'generate_image' ? 'image' : 'tool';
		return { mode, approved: await requestApproval(kind, name, args, approvalHandlerFn, signal) };
	}
	return { mode, approved: false };
}

// Policy is re-read for every call; a pending approval is invalid after any
// transition, including a downgrade followed by an upgrade to the same mode.
async function guardTool(options) {
 if (options.sessionId && require('./db').isInitialized?.()) require('./sessionDeletion').assertAvailable(options.sessionId);
 options = { ...options, args: structuredClone(options.args ?? {}) };
 const contexts = require('./lspExecutionContext');
 const { sessionId } = options;
 const revision = contexts.revision(sessionId);
 const permissionMode = sessionId ? contexts.currentMode(sessionId, options.permissionMode) : options.permissionMode;
 const handler = options.requestApproval;
 if (handler) options.requestApproval = async payload => {
  const allowed = await handler(payload);
  options.signal?.throwIfAborted();
  if (sessionId && contexts.revision(sessionId) !== revision) return false;
  return allowed;
 };
 let result;
 try { result = await evaluateTool({ ...options, permissionMode }); }
 catch (error) {
  if (sessionId && contexts.revision(sessionId) !== revision)
   throw Object.assign(new Error('Execution blocked: Permission changed while authorizing this operation.'), { code: 'PERMISSION_REVOKED' });
  throw error;
 }
 // Git mutations may invoke repository-controlled filters/signers. Read-only
 // inspection uses fixed argv with helpers disabled; mutation is opaque.
 if (options.native !== false && require('./nativeExecutionPolicy').isOpaqueGit(options.name) && !result.approved) {
  await requestApproval('tool', options.name, { ...options.args,
   execution_scope: 'Workspace Git mutation; repository configuration may execute filters or signing programs.' }, options.requestApproval, options.signal);
  result.approved = true;
 }
 options.signal?.throwIfAborted();
 if (sessionId && contexts.revision(sessionId) !== revision) {
  const error = new Error('Execution blocked: Permission changed while authorizing this operation.');
  error.code = 'PERMISSION_REVOKED'; throw error;
 }
 const decision = { ...result, ...(sessionId ? { policyRevision: revision } : {}) };
 return options.native !== false && require('./nativeExecutionPolicy').isProtected(options.name)
  ? require('./nativeExecutionPolicy').issue(decision, options) : decision;
}

module.exports = {
	CAPABILITIES,
	capabilityOf,
	resolveMode,
	normalizeMode,
	effectiveMode,
	availableModes,
	baseDecision,
	isToolVisible,
	isSystemAffecting,
	sessionProject,
	workspacePath,
	guardTool,
	requestToolApproval,
};
