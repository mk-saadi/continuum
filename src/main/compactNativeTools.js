'use strict';

// Advertisement profile only: never a dispatcher, alias, or permission grant.
// Keep common contracts verbatim so stored calls and guarded handlers agree.
const DEFAULT_NAMES = Object.freeze([
  'manage_native_tools', 'ask_user', 'list_directory', 'search_project_content',
  'read_project_file', 'str_replace_editor', 'write_project_file', 'execute_command',
  'get_command_status', 'stop_background_command', 'update_plan', 'get_project_plans',
  'git_status', 'git_diff', 'find_and_prepare_mcp_tools',
]);
// Advertisement profile only: the native web tools are research primitives, so
// every profile exposes them from the first request instead of hiding them
// behind manage_native_tools activation. Permission policy is unchanged.
const ALWAYS_ON_GROUPS = Object.freeze(['web']);
function configuredProfile() {
  // Shared default for normal development and packaged launches. Full remains
  // an explicit diagnostic override; specialized tools load within the run.
  return process.env.CONTINUUM_NATIVE_TOOL_PROFILE === 'full' ? 'full' : 'compact';
}
function select(authorized, activatedGroups, groups, nativeNames) {
  const exposed = new Set([
    ...DEFAULT_NAMES,
    ...ALWAYS_ON_GROUPS.flatMap(group => groups[group] || []),
    ...activatedGroups.flatMap(group => groups[group] || []),
  ]);
  // External MCP schemas are governed exclusively by MCP's existing selection.
  return authorized.filter(tool => !nativeNames.has(tool.function.name) || exposed.has(tool.function.name));
}
module.exports = { DEFAULT_NAMES, ALWAYS_ON_GROUPS, configuredProfile, select };
