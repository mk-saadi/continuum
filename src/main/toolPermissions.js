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
// Workspace Write auto execution is bound to the isolated workspace profile.
// Other opaque execution requires approval; Full Access authorizes the host.
// ---------------------------------------------------------------------------

const { CAPABILITIES, capabilityOf, baseDecision, decideToolApproval } = require('./toolApprovalPolicy');

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
// Coarse system-affecting denylist used alongside sandbox and path facts.
// A negative match alone never authorizes a command. This is NOT a security
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

	// Distinguish global from local installs. Both still pass the separate
	// opaque-command approval gate; this heuristic authorizes neither.
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

async function evaluateTool({ name, args = {}, permissionMode, project, requestApproval: approvalHandlerFn, signal, native = true, serverName, annotations, serverTrusted = false, sessionId }) {
	const root = projectRoot(project);
	const mode = normalizeMode(resolveMode(permissionMode, project), root);
	signal?.throwIfAborted();
	const policyInput = { tool: name, args, mode, workspaceRoot: root, native, serverName, annotations, serverTrusted };
	if (native && name === 'git_switch' && mode === 'workspace_write' && root)
		policyInput.gitWorktreeDirty = await require('./tools/agentTools').gitWorktreeDirty(root, signal);
	let policy = decideToolApproval(policyInput);
	if (policy.decision === 'block') throw Object.assign(new Error(policy.reason), { code: 'PERMISSION_DENIED' });
	if (policy.route === 'command') {
		if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0')) throw new Error('Invalid command.');
		if (mode !== 'full_access' && (args.command.length > 4000 || (typeof args.cwd === 'string' && args.cwd.length > 4000)))
			throw new Error('Execution blocked: Command or cwd exceeds the reviewable approval limit (4000 characters).');
		// Full Access authorizes the host. Workspace Write may auto-authorize
		// only the verified isolated profile below.
		if (mode === 'full_access') return { mode, approved: true, commandUncontained: true };
		let uncontained = !root;
		if (root) {
			try {
				const cwd = await workspacePath(root, args.cwd ?? '.');
				if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Execution blocked: Command cwd must be a directory.');
			} catch (error) {
				if (mode !== 'ask_approval' || !String(error.message).startsWith('Execution blocked:')) throw error;
				uncontained = true;
			}
		}
		let commandFacts = {};
		if (mode === 'workspace_write' && root && !uncontained) {
			const cwd = await workspacePath(root, args.cwd ?? '.');
			const systemAffecting = isSystemAffecting(args.command);
			const packageOperation = require('./workspaceCommandPolicy').isPackageOperation(args.command);
			const inspection = systemAffecting || packageOperation ? { resolvedPaths: [cwd], reviewRequired: true }
				: await require('./workspaceCommandPolicy').inspectWorkspaceCommand(root, cwd, args.command, workspacePath);
			commandFacts = { containment: { contained: true }, resolvedPaths: inspection.resolvedPaths, commandReviewRequired: inspection.reviewRequired,
				systemAffecting, packageOperation };
		}
		const sandbox = await require('./workspaceSandboxProfile').getWorkspaceSandboxProfile({ workspaceRoot: root, uncontained });
		policy = decideToolApproval({ ...policyInput, ...commandFacts, sandbox, uncontained });
		if (policy.decision === 'ask') await requestApproval('tool', name, { ...args, execution_scope: uncontained
			? 'Uncontained opaque process: host filesystem, inherited environment and network access; may perform external actions.'
			: 'Opaque process: workspace writes, read-only host filesystem, isolated network and restricted environment.' }, approvalHandlerFn, signal);
		return { mode, approved: policy.decision === 'ask', commandUncontained: uncontained,
			...(policy.decision === 'allow' ? { executionProfile: 'bwrap_workspace' } : {}) };
	}
	if (policy.route === 'full_access') return { mode, approved: true };
	if (policy.route === 'immediate') return { mode, approved: policy.decision === 'ask'
		? await requestApproval('tool', name, args, approvalHandlerFn, signal) : false };
	if (policy.route === 'git_sync') {
		if (!root) throw new Error('Git tools require a project workspace.');
		if (!['fetch', 'pull', 'push'].includes(args.action)) throw new Error('action must be one of "fetch", "pull", or "push".');
		const incoming = mode === 'workspace_write' && args.action === 'pull'
			? await require('./tools/agentTools').prepareGitPullReview(root, args, signal) : null;
		// Remote preparation may invoke repository-controlled transport helpers. Ask
		// before preparation, which can itself contact the remote.
		if (policy.decision === 'ask') await requestApproval('tool', name, { ...args, action: args.action === 'push' ? 'prepare_push' : args.action, ...(incoming ? { incoming } : {}),
			execution_scope: 'Git remote operation with network access and repository configuration; may execute transport helpers. Push preparation reads remote state; publication requires a separate history review.' }, approvalHandlerFn, signal);
		const snapshot = args.action === 'push' ? await require('./tools/agentTools').prepareGitPush(root, args, signal) : null;
		if (snapshot && decideToolApproval({ ...policyInput, stage: 'git_publication' }).decision === 'ask') await requestApproval('tool', name, { action: 'push', remote: snapshot.remote, branch: snapshot.branch, outgoing: snapshot.summary }, approvalHandlerFn, signal);
		return { mode, approved: policy.decision === 'ask', ...(snapshot ? { gitPushFingerprint: snapshot.fingerprint } : {}) };
	}
	if (policy.route === 'git_commit') {
		if (!root) throw new Error('Git tools require a project workspace.');
		const snapshot = await require('./tools/agentTools').prepareGitCommit(root, signal);
		const approved = policy.decision === 'ask' ? await requestApproval('tool', name, { ...args, staged_diff: snapshot.stagedDiff }, approvalHandlerFn, signal) : false;
		return { mode, approved, gitCommitFingerprint: snapshot.fingerprint,
			...(mode === 'workspace_write' ? { gitCommitReview: { message: args.message, staged_diff: snapshot.stagedDiff } } : {}) };
	}

	const capability = capabilityOf(name, native);

	if (policy.route === 'delete') {
		// baseDecision already denied casual chats (no workspace) and read-only
		// chats; a root exists here. Workspace Write captures first; other
		// writable modes retain explicit review. The approval payload names
		// the exact file and size, and a content fingerprint is
		// bound so any change between approval and execution is rejected. The
		// deletion itself stays workspace-contained: there is deliberately no
		// outside-workspace approval escape.
		const snapshot = await require('./tools/agentTools').prepareFileDelete(root, args?.path, { signal });
		if (mode === 'workspace_write') {
			let checkpoint = null;
			let checkpointCoverage = { path: snapshot.rel, complete: false, captured: false };
			try {
				checkpoint = await require('./recoveryStore').captureOperation({ root, chatSessionId: sessionId ?? null,
					toolName: name, op: { kind: 'delete', path: snapshot.rel, size: snapshot.size },
					paths: [snapshot.rel], required: [snapshot.rel], uncontained: false });
				const record = checkpoint.manifest?.paths?.[snapshot.rel];
				checkpointCoverage = { ...checkpoint.coverage, path: snapshot.rel,
					captured: Boolean(checkpoint.checkpointId && record?.kind === 'file' && record.hash === snapshot.hash && record.size === snapshot.size) };
			} catch { /* An uncovered deletion requires explicit consent. */ }
			policy = decideToolApproval({ ...policyInput, checkpointCoverage });
			const approved = policy.decision === 'ask' ? await requestApproval('tool', name,
				{ operation: 'delete', path: snapshot.rel, size: snapshot.size, recovery: 'No complete checkpoint; deletion may be irreversible.' }, approvalHandlerFn, signal) : false;
			// captureOperation creates unpinned checkpoints. Denial/abort leaves
			// them eligible for normal retention cleanup, never a pinned orphan.
			return { mode, approved, deleteFingerprint: snapshot.fingerprint,
				deleteCapture: { checkpoint, covered: policy.decision === 'allow', fallbackApproved: approved } };
		}
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
			if (decideToolApproval({ ...policyInput, stage: 'containment', containment: { blocked: true, reason: message } }).decision === 'ask') {
				// Workspace-relative writes stay contained; a write outside the
				// workspace prompts the user instead of failing outright.
				return { mode, approved: await requestApproval('outside', name, args, approvalHandlerFn, signal) };
			}
			// Traversal, symlink escapes and invalid input fail closed in
			// workspace_write mode (and for non-containment errors everywhere).
			throw error;
		}
		// Contained in-workspace writes run autonomously in both workspace modes.
		return { mode, approved: false, ...(name === 'git_switch' && mode === 'workspace_write' ? { gitWorktreeDirty: policyInput.gitWorktreeDirty } : {}) };
	}

	// External mutations (image generation, MCP management, MCP-hosted tools)
	// and unknown capabilities in ask_approval: one explicit approval prompt.
	if (policy.decision === 'ask') {
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
 if (decideToolApproval({ tool: options.name, args: options.args, mode: result.mode, native: options.native,
  workspaceRoot: projectRoot(options.project), stage: 'opaque_git', approved: result.approved,
  gitWorktreeDirty: options.name === 'git_switch' && result.gitWorktreeDirty }).decision === 'ask') {
  await requestApproval('tool', options.name, { ...options.args,
   execution_scope: 'Workspace Git mutation; repository configuration may execute filters or signing programs.' }, options.requestApproval, options.signal);
  result.approved = true;
 }
 options.signal?.throwIfAborted();
 if (sessionId && contexts.revision(sessionId) !== revision) {
  const error = new Error('Execution blocked: Permission changed while authorizing this operation.');
  error.code = 'PERMISSION_REVOKED'; throw error;
 }
 const { deleteCapture, ...publicResult } = result;
 const decision = { ...publicResult, ...(sessionId ? { policyRevision: revision } : {}) };
 if (deleteCapture) require('./nativeExecutionPolicy').issueDelete(decision, deleteCapture, options);
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
