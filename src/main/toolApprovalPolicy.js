'use strict';

// Pure approval policy. No I/O, Electron, session state or approval lifecycle.
// The caller supplies authoritative facts gathered at the existing enforcement
// points; stages preserve the order of validation, snapshotting and dispatch.
const { requiresGitApproval, requiresOutboundApproval } = require('./mcpPermissionPolicy');
const { isCommand, isOpaqueGit } = require('./nativeExecutionKinds');

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

function capabilityDecision({ capability, mode, hasWorkspace, native }) {
	if (capability === CAPABILITIES.LSP) return hasWorkspace && ['workspace_write', 'full_access'].includes(mode)
		? { decision: 'allow' } : { decision: 'deny', reason: 'Execution blocked: LSP requires a workspace and Workspace Write or Full Access.' };
	// Plan reads (like plan writes) are meaningless without a Workspace session
	// to scope them to: a Casual Chat must never reach another chat's plan, in
	// any mode. Checked before the per-mode branches so visibility and
	// execution agree everywhere (including read_only and full_access).
	if (!hasWorkspace && capability === CAPABILITIES.PLAN_READ) {
		return { decision: 'deny', reason: 'Execution blocked: Task plans require a project workspace.' };
	}

	// Full Access authorizes host execution as well as ordinary tools.
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

	// Contained writes run autonomously in both workspace modes. Outside writes
	// prompt in ask_approval and fail closed in workspace_write. Opaque process
	// execution and Git mutations have separate approval gates below.
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
 * @param {object} input
 * @param {string} input.tool
 * @param {object} [input.args]
 * @param {string} input.mode Effective, workspace-normalized permission mode.
 * @param {string|null} [input.workspaceRoot]
 * @param {'evaluate'|'base'|'containment'|'opaque_git'|'git_publication'|'mcp_dispatch'} [input.stage]
 * @param {object} [input.containment] { blocked, reason } from live path checks.
 * @param {string[]} [input.resolvedPaths] Live-resolved workspace targets.
 * @param {object} [input.annotations] MCP readOnlyHint/destructiveHint (inert in Phase 1).
 * @param {boolean} [input.serverTrusted=false] Inert in Phase 1.
 * @param {object} [input.checkpointCoverage] Inert in Phase 1.
 * @param {object} [input.sandbox] { bwrapAvailable, netUnshared, profile }; inert in Phase 1.
 * @returns {{decision:'allow'|'ask'|'block', reason:string, route?:string}}
 */
function decideToolApproval(input) {
  const { tool, args = {}, mode, workspaceRoot, native = true, serverName = '',
    stage = 'evaluate', containment, approved = false } = input;
  const allow = (route) => ({ decision: 'allow', reason: '', ...(route ? { route } : {}) });
  const ask = (reason, route) => ({ decision: 'ask', reason, ...(route ? { route } : {}) });
  const block = reason => ({ decision: 'block', reason });

  if (stage === 'mcp_dispatch') {
    // Order and mode/session exceptions match the independent dispatch backstop.
    if (['workspace_write', 'ask_approval'].includes(mode) && tool === 'delete_project_file' && !approved)
      return ask('File deletion requires explicit approval.');
    if (input.dispatchPhase === 'deletion') return allow();
    if (mode !== 'full_access' && requiresOutboundApproval(tool, args) && !approved)
      return ask('Outbound or consequential mutation requires explicit user approval.');
    if (input.workspaceMcp && requiresGitApproval(tool, args, serverName) && !approved)
      return ask('Git commit or push requires explicit approval.');
    if (mode !== 'full_access' && !input.workspaceMcp &&
        !(input.permissionGranted && mode === 'ask_approval') && input.mutationRequiresConfirmation)
      return ask('Mutation payload requires a scoped approval challenge.', 'mutation_challenge');
    return allow();
  }
  if (stage === 'opaque_git') return native !== false && isOpaqueGit(tool) && !approved
    ? ask('Workspace Git mutation may execute repository-configured programs.') : allow();
  if (stage === 'git_publication') return ask('Review outgoing Git history before publication.');
  if (stage === 'containment') {
    if (!containment?.blocked) return allow();
    return mode === 'ask_approval' && containment.reason.startsWith('Execution blocked:')
      ? ask('Approve a write outside the project workspace.') : block(containment.reason);
  }

  const capability = Object.hasOwn(input, 'capability') ? input.capability : capabilityOf(tool, native);
  if (stage === 'base') {
    const result = capabilityDecision({ capability, mode, hasWorkspace: Boolean(workspaceRoot), native: input.native });
    return result.decision === 'deny' ? block(result.reason) : result.decision === 'approve'
      ? ask('This tool requires explicit user approval.') : allow();
  }
  if (native && isCommand(tool)) return mode === 'read_only'
    ? block('Execution blocked: Chat is in Read Only mode.')
    : mode === 'full_access' ? allow('command') : ask('Opaque process execution requires specific approval.', 'command');
  if (mode === 'full_access') {
    // Preserve the execution guard's historically distinct LSP message.
    if (capability === CAPABILITIES.LSP && !workspaceRoot) return block('LSP requires a project workspace.');
    if (!workspaceRoot && [CAPABILITIES.PLAN_WRITE, CAPABILITIES.PLAN_READ, CAPABILITIES.FILE_DELETE].includes(capability))
      return block(capability === CAPABILITIES.FILE_DELETE ? 'Execution blocked: File deletion requires a project workspace.'
        : 'Execution blocked: Task plans require a project workspace.');
    return allow('full_access');
  }
  if (native && ((tool === 'manage_mcp_servers' && args.action === 'search') || (tool === 'find_and_prepare_mcp_tools' && mode === 'read_only'))) return allow('immediate');
  if (native && tool === 'approve_mcp_mutation' && mode !== 'read_only') return ask('Approve the scoped MCP mutation challenge.', 'immediate');
  if (!native && mode !== 'read_only' && requiresOutboundApproval(tool, args)) return ask('Connected tool may perform outbound or consequential actions.', 'immediate');
  if (mode === 'workspace_write' && workspaceRoot && ((native && ['manage_mcp_servers', 'find_and_prepare_mcp_tools'].includes(tool)) || !native)) {
    return !native && (tool === 'delete_project_file' || requiresGitApproval(tool, args, serverName))
      ? ask('Connected tool deletes a project file or publishes Git history.', 'immediate') : allow('immediate');
  }
  if (native && tool === 'git_sync' && mode !== 'read_only') return ask('Git remote preparation may execute transport helpers.', 'git_sync');
  if (tool === 'git_commit' && mode !== 'read_only') return ask('Review the staged changes before committing.', 'git_commit');
  const result = decideToolApproval({ ...input, stage: 'base', capability, native });
  if (result.decision !== 'block' && capability === CAPABILITIES.FILE_DELETE)
    return ask('Review the exact file before deletion.', 'delete');
  if (result.decision === 'allow' && native && isOpaqueGit(tool))
    return ask('Workspace Git mutation may execute repository-configured programs.', 'opaque_git');
  return result;
}

// Compatibility for visibility and existing consumers of the capability table.
function baseDecision({ capability, mode, hasWorkspace, native }) {
  const result = decideToolApproval({ stage: 'base', capability, mode, workspaceRoot: hasWorkspace ? '<workspace>' : null, native });
  return { decision: { ask: 'approve', block: 'deny', allow: 'allow' }[result.decision],
    ...(result.decision === 'block' ? { reason: result.reason } : {}) };
}
module.exports = { decideToolApproval, CAPABILITIES, capabilityOf, baseDecision };
