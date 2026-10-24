'use strict';

// Exposure is run-scoped. Authorization remains in toolPermissions and the
// existing dispatcher. No tool operations are performed by activation.
const runs = new Map();
const groups = Object.freeze({
  files: ['list_directory', 'search_project_content', 'read_project_file'],
  editing: ['str_replace_editor', 'edit_project_files', 'write_project_file', 'apply_patch', 'move_project_file', 'delete_project_file'],
  lsp: ['lsp_definition', 'lsp_references', 'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_hover', 'lsp_diagnostics'],
  commands: ['execute_command', 'run_tests', 'get_command_status', 'stop_background_command'],
  git_read: ['git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_blame'],
  git_write: ['git_stage', 'git_unstage', 'git_commit', 'git_create_branch', 'git_switch', 'git_sync', 'git_stash'],
  tasks: ['update_plan', 'get_project_plans'],
  subagents: ['spawn_sub_agent', 'delegate_task'],
  web: ['web_search', 'get_single_web_page_content', 'extract_web_page_data'],
  memory: ['search_memory', 'save_memory', 'get_recent_chat_history'],
  media: ['take_screenshot', 'generate_image'],
  skills: ['use_skill', 'propose_skill'],
  mcp: ['manage_mcp_servers', 'approve_mcp_mutation', 'find_and_prepare_mcp_tools'],
});
const tool = { type: 'function', function: {
  name: 'manage_native_tools',
  description: 'Discover authorized native tool groups (list), or activate selected groups. Schemas appear on the next request in this same run. Activation performs no operations and grants no permissions; approvals and workspace boundaries still apply.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'activate'] },
    groups: { type: 'array', items: { type: 'string', enum: Object.keys(groups) }, maxItems: Object.keys(groups).length },
  }, required: ['action'], additionalProperties: false },
} };
function begin(sessionId, runId) {
  if (sessionId) runs.set(sessionId, { runId, groups: new Set(), count: 0 });
}
function end(sessionId, runId) {
  if (runs.get(sessionId)?.runId === runId) runs.delete(sessionId);
}
function snapshot(sessionId) {
  const state = runs.get(sessionId);
  return { dynamicToolActivationCount: state?.count ?? 0, activatedToolGroups: [...(state?.groups ?? [])] };
}
function filter(tools, sessionId, modelId) {
  // Sessionless tooling/legacy integrations retain their existing contract.
  if (!sessionId || (!modelId && !runs.has(sessionId))) return tools;
  const active = new Set(snapshot(sessionId).activatedToolGroups.flatMap(group => groups[group]));
  return tools.filter(item => ['manage_native_tools', 'find_and_prepare_mcp_tools', 'ask_user'].includes(item.function.name) || active.has(item.function.name));
}
function manage({ action, groups: requested = [] }, sessionId, availableTools, runId) {
  if (!['list', 'activate'].includes(action) || !Array.isArray(requested) || requested.length > Object.keys(groups).length || requested.some(group => !Object.hasOwn(groups, group)))
    throw new Error('Invalid native tool activation request.');
  const available = new Set(availableTools.map(item => item.function.name));
  const catalog = Object.entries(groups).map(([group, names]) => ({ group, tools: names.filter(name => available.has(name)) })).filter(entry => entry.tools.length);
  if (action === 'activate') {
    const state = runs.get(sessionId);
    if (!state || (runId && state.runId !== runId)) throw new Error('Native activation requires the current owning run.');
    for (const group of requested) {
      if (!catalog.some(entry => entry.group === group)) throw new Error(`No authorized tools in group: ${group}`);
    }
    for (const group of requested) if (!state.groups.has(group)) { state.groups.add(group); state.count++; }
  }
  return { success: true, ...snapshot(sessionId), groups: action === 'list' ? catalog : catalog.filter(entry => requested.includes(entry.group)), instructions: [requested.includes('subagents') ? require('./promptBuilder').subAgentProtocol : '', requested.includes('mcp') ? 'Search MCP capabilities by purpose. Inspect one server if its tools are unknown, then activate only required tool_names using manage_mcp_servers. For browser automation search for browser navigation. Use browser_snapshot to read accessibility state when navigation returns a snapshot file. If a server is disabled, use an authorized enable action before inspect. Prefer bundled playwright-native for browser automation without extension setup. If a tool reports missing runtime or browser extension connection, do not repeat it until setup changes; use another permitted capability or report the exact setup step. In Workspace Write, configured MCP server management and tool calls are authorized without per-call confirmation; Git commits, pushes, and delete_project_file calls still require approval. Report setup errors honestly. When asked to create an MCP server, build under mcp-plugins/, install dependencies, read and merge the central configuration without overwriting unrelated entries, use absolute script paths and explicit cwd, then enable it through manage_mcp_servers. Config: ' + require('./mcpManager').configPath : ''].filter(Boolean).join('\n'), message: 'Only listed tools are available under current permissions. Activation never grants execution approval. Continue in this run.' };
}
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'description' && typeof item === 'string' ? item.replace(/\s+/g, ' ').slice(0, 320) : compact(item)]));
}
module.exports = { forgetSession: sessionId => runs.delete(sessionId), compact, tool, groups, begin, end, snapshot, filter, manage };
