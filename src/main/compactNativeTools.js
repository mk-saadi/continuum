'use strict';

// Advertisement profile only: never a dispatcher, alias, or permission grant.
// Keep common contracts verbatim so stored calls and guarded handlers agree.
const DEFAULT_NAMES = Object.freeze([
  'manage_native_tools', 'ask_user', 'list_directory', 'search_project_content',
  'read_project_file', 'str_replace_editor', 'write_project_file', 'execute_command',
  'get_command_status', 'stop_background_command', 'update_plan', 'get_project_plans',
  'git_status', 'git_diff', 'get_recent_chat_history', 'find_and_prepare_mcp_tools',
]);
function configuredProfile() {
  return process.env.CONTINUUM_NATIVE_TOOL_PROFILE === 'compact' ? 'compact' : 'full';
}
function select(authorized, activatedGroups, groups, nativeNames) {
  const exposed = new Set([...DEFAULT_NAMES, ...activatedGroups.flatMap(group => groups[group] || [])]);
  // External MCP schemas are governed exclusively by MCP's existing selection.
  return authorized.filter(tool => !nativeNames.has(tool.function.name) || exposed.has(tool.function.name));
}
module.exports = { DEFAULT_NAMES, configuredProfile, select };
