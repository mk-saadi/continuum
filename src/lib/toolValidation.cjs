'use strict';

// Bounded, application-owned diagnostics: never interpolate source, arguments,
// paths, URLs or arbitrary error text into a banner or a system instruction.
const diagnostics = {
  INVALID_READ_SOURCE: {
    field: 'relative_path / attachment_id',
    summary: 'Choose exactly one file identifier: relative_path or attachment_id.',
    action: 'Include relative_path for a workspace file or attachment_id for an uploaded file, never both. Line ranges and hashes do not identify a file. For an ordinary read omit hashes.',
  },
  EMPTY_UPDATE: {
    field: 'steps / remove_step_ids / objective',
    summary: 'Plan update contains no changes.',
    action: 'Include non-empty steps, non-empty remove_step_ids, or an objective. To inspect the plan use action="get". expected_revision alone is not an update.',
  },
  EDIT_ARGUMENT_INVALID: {
    field: 'edits',
    summary: 'Invalid edit arguments; edits must be an array of valid edit objects.',
    action: 'Pass edits as a JSON array, not a string. Each edit needs relative_path, old_str and new_str. Correct the reported field; do not coerce or replay the invalid batch.',
  },
  EDIT_TARGET_NOT_FOUND: {
    field: 'old_str',
    summary: 'Edit target text does not match the current file.',
    action: 'Read a small relevant source range and copy a unique old_str from that result before retrying. Do not guess source text.',
  },
  SUBAGENT_TARGET_REQUIRED: {
    field: 'target_file / url / investigate',
    summary: 'Subagent call has no source or investigation mode.',
    action: 'For a local file pass its absolute path in target_file; mentioning a path in task is insufficient. Alternatively supply url (or one URL in task) or investigate=true for discovery.',
  },
};
const toolCodes = {
  read_project_file: ['INVALID_READ_SOURCE'],
  update_plan: ['EMPTY_UPDATE'],
  edit_project_files: ['EDIT_ARGUMENT_INVALID', 'EDIT_TARGET_NOT_FOUND'],
  spawn_sub_agent: ['SUBAGENT_TARGET_REQUIRED'],
};
function parseOutput(output) {
  if (typeof output !== 'string') return output;
  try { return JSON.parse(output); } catch { return null; }
}
function validationDiagnostic(output, toolName) {
  const result = parseOutput(output);
  if (!result || (result.success !== false && result.isError !== true)) return null;
  // Older saved subagent results predate typed diagnostics.
  const code = result.code ?? (typeof result.error === 'string' &&
    result.error.startsWith('Provide a url or target_file parameter (or set investigate: true).')
    ? 'SUBAGENT_TARGET_REQUIRED' : null);
  if (typeof code !== 'string' || !Object.hasOwn(diagnostics, code) ||
      (toolName && (!Object.hasOwn(toolCodes, toolName) || !toolCodes[toolName].includes(code)))) return null;
  return { code, ...diagnostics[code] };
}
function withValidationGuidance(output, toolName) {
  const result = parseOutput(output);
  const diagnostic = validationDiagnostic(result, toolName);
  return diagnostic ? { ...result, code: diagnostic.code,
    error_type: 'validation', validation_field: diagnostic.field,
    suggested_action: result.suggested_action || diagnostic.action } : output;
}
function validationSummary(output, toolName) {
  const diagnostic = validationDiagnostic(output, toolName);
  return diagnostic ? `${diagnostic.code}: ${diagnostic.summary} ${diagnostic.action}` : null;
}
// Only statically provable invalid shapes qualify for semantic retry blocking.
// A matching code alone must never block a corrected call or a different edit.
function invalidShape(toolName, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const has = key => Object.hasOwn(args, key);
  if (toolName === 'read_project_file' && has('relative_path') === has('attachment_id'))
    return `INVALID_READ_SOURCE:${has('relative_path') ? 'both' : 'missing'}`;
  if (toolName === 'update_plan' && args.action === 'update' && args.objective === undefined &&
      (args.steps === undefined || Array.isArray(args.steps) && !args.steps.length) &&
      (args.remove_step_ids === undefined || Array.isArray(args.remove_step_ids) && !args.remove_step_ids.length))
    return 'EMPTY_UPDATE';
  if (toolName === 'edit_project_files' && !Array.isArray(args.edits)) return 'EDIT_ARGUMENT_INVALID:edits';
  if (toolName === 'spawn_sub_agent' && args.target_file === undefined && args.url === undefined &&
      args.investigate !== true && !/https?:\/\//i.test(args.task ?? '')) return 'SUBAGENT_TARGET_REQUIRED';
  return null;
}
module.exports = { validationDiagnostic, validationSummary, withValidationGuidance, invalidShape };
