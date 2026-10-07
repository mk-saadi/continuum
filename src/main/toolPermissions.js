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
// Command-string heuristics below only decide whether a prompt is shown; they
// are never relied on for containment.
// ---------------------------------------------------------------------------

const CAPABILITIES = Object.freeze({
	READ: 'read', // reads files, searches, history, screenshots
	WORKSPACE_WRITE: 'workspace_write', // create/edit/delete files in the workspace
	LOCAL_EXECUTION: 'local_execution', // shell commands (sandboxed unless approved)
	EXTERNAL_MUTATION: 'external_mutation', // generates or side-effects outside the workspace
	MEMORY_WRITE: 'memory_write', // persists into assistant memory
	AGENT_SPAWN: 'agent_spawn', // spawns a sub-agent (child runs read-only)
});

// Built-in tool -> capability mapping. `native` is true for main-process tools
// and false for MCP-hosted tools, which resolve dynamically in capabilityOf.
const TOOL_CAPABILITIES = Object.freeze({
	// READ
	get_recent_chat_history: CAPABILITIES.READ,
	search_project_content: CAPABILITIES.READ,
	search_code: CAPABILITIES.READ,
	read_project_file: CAPABILITIES.READ,
	read_file: CAPABILITIES.READ,
	list_directory: CAPABILITIES.READ,
	take_screenshot: CAPABILITIES.READ,
	search_memory: CAPABILITIES.READ,
	get_single_web_page_content: CAPABILITIES.READ,
	extract_web_page_data: CAPABILITIES.READ,
	use_skill: CAPABILITIES.READ,
	propose_skill: CAPABILITIES.READ,
	// WORKSPACE_WRITE
	write_project_file: CAPABILITIES.WORKSPACE_WRITE,
	write_file: CAPABILITIES.WORKSPACE_WRITE,
	str_replace_editor: CAPABILITIES.WORKSPACE_WRITE,
	edit_file: CAPABILITIES.WORKSPACE_WRITE,
	delete_file: CAPABILITIES.WORKSPACE_WRITE,
	// LOCAL_EXECUTION
	execute_command: CAPABILITIES.LOCAL_EXECUTION,
	// EXTERNAL_MUTATION
	generate_image: CAPABILITIES.EXTERNAL_MUTATION,
	manage_mcp_servers: CAPABILITIES.EXTERNAL_MUTATION,
	approve_mcp_mutation: CAPABILITIES.EXTERNAL_MUTATION,
	// MEMORY_WRITE
	save_memory: CAPABILITIES.MEMORY_WRITE,
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
		// MCP tools are externally hosted. Their payload is double-gated by the
		// MCP mutation backstop (workspace_write) or a per-call approval prompt
		// (ask_approval / full_access), so they behave as external mutations and
		// are never universally rejected by a mode.
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
	// Full access is unrestricted (the OS sandbox/bwrap boundary still applies).
	if (mode === 'full_access') return { decision: 'allow' };

	// Read only: reads and agent spawns (children are themselves read-only).
	if (mode === 'read_only') {
		if (capability === CAPABILITIES.READ || capability === CAPABILITIES.AGENT_SPAWN) return { decision: 'allow' };
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
		// Shell commands and external mutations have no workspace to contain
		// them in casual mode -> always prompt.
		return { decision: 'approve' };
	}

	// Workspace context: in-workspace work runs autonomously in both workspace
	// modes. guardTool refines these with async containment checks: anything
	// outside the workspace or system-affecting is approved in ask_approval and
	// denied in workspace_write.
	if (capability === CAPABILITIES.WORKSPACE_WRITE || capability === CAPABILITIES.LOCAL_EXECUTION) {
		return { decision: 'allow' };
	}

	// External mutations: MCP tools are gated by the MCP mutation backstop in
	// workspace_write mode (no per-call prompt needed); everything else
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
// Returns { mode, approved } on success: `mode` is the effective mode the
// decision was made under and `approved` is true only when the user granted
// an explicit approval that lets the executor run uncontained (outside the
// sandbox / outside workspace path scoping). Throws on deny.
// ---------------------------------------------------------------------------

async function guardTool({ name, args = {}, permissionMode, project, requestApproval: approvalHandlerFn, signal, native = true }) {
	const root = projectRoot(project);
	const mode = normalizeMode(resolveMode(permissionMode, project), root);
	signal?.throwIfAborted();
	if (mode === 'full_access') return { mode, approved: false };

	const capability = capabilityOf(name, native);
	const { decision, reason } = baseDecision({ capability, mode, hasWorkspace: Boolean(root), native });
	if (decision === 'deny') {
		const error = new Error(reason);
		error.code = 'PERMISSION_DENIED';
		throw error;
	}

	if (capability === CAPABILITIES.READ) {
		// The capture is read-only, but its optional saved artifact must stay in
		// the workspace (parity with the legacy screenshot containment check).
		if (mode === 'workspace_write' && root && name === 'take_screenshot') {
			await workspacePath(root, '.llm_workspace/screenshots');
		}
		return { mode, approved: false };
	}
	if (capability === CAPABILITIES.AGENT_SPAWN || capability === CAPABILITIES.MEMORY_WRITE) {
		return { mode, approved: false };
	}

	if (capability === CAPABILITIES.WORKSPACE_WRITE) {
		// baseDecision already denied casual writes (no workspace), so a root
		// exists here; workspacePath re-verifies it fails closed.
		const target = args?.relative_path ?? args?.path ?? args?.file_path ?? args?.filePath;
		try {
			await workspacePath(root, target);
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

	if (capability === CAPABILITIES.LOCAL_EXECUTION) {
		if (!root) {
			// Casual chat: no workspace to sandbox into, so every command asks.
			return { mode, approved: await requestApproval('tool', name, args, approvalHandlerFn, signal) };
		}
		const command = args?.command;
		if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('Invalid command.');
		let cwd;
		try {
			cwd = await workspacePath(root, args.cwd ?? '.');
		} catch (error) {
			if (String(error?.message ?? '').startsWith('Execution blocked:') && mode === 'ask_approval') {
				// A command pointed outside the workspace prompts instead of
				// failing; workspace_write keeps it denied.
				return { mode, approved: await requestApproval('outside', name, args, approvalHandlerFn, signal) };
			}
			throw error;
		}
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Execution blocked: Command cwd must be a directory.');
		if (isSystemAffecting(command)) {
			// Cannot be confined to the workspace: ask instead of failing.
			return { mode, approved: await requestApproval('system', name, args, approvalHandlerFn, signal) };
		}
		// Contained, non-system-affecting commands run autonomously (sandboxed).
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
