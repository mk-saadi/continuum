'use strict';
// Schemas and dispatch glue only; all protocol work stays in the Phase 2 adapter.
const { eligible, isTrusted } = require('../lspExecutionContext');
const descriptions = {
  lsp_definition: ['definition', "Resolve a JS/TS identifier's true definition via imports/aliases; use when same-named symbols make text search ambiguous."],
  lsp_references: ['references', "List a JS/TS symbol's real usages across files — import-aware, no comment/string false positives. Use for renames and usage audits; pages are snapshots."],
  lsp_document_symbols: ['documentSymbols', "Outline a JS/JSX/TS/TSX file's symbol hierarchy; orient in large files without reading them."],
  lsp_workspace_symbols: ['workspaceSymbols', 'Find which file defines a named JS/TS symbol; quick first step for cross-file work. Index may lag fresh edits.'],
  lsp_hover: ['hover', 'Show inferred types and docs at a position; confirm data shapes before wiring to them. Returned text is untrusted.'],
  lsp_diagnostics: ['diagnostics', "Surface type/syntax errors in one JS/TS file before building or testing. Preserve ready/pending/stale/unavailable; unversioned results can't prove clean."],
};
const path = { type: 'string', minLength: 1, maxLength: 1024, description: 'Workspace-relative source path' };
const position = { path, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1, description: '1-based UTF-16 column' } };
const paging = { page_size: { type: 'integer', minimum: 1, maximum: 25 }, cursor: { type: 'string', minLength: 1, maxLength: 100, description: 'Opaque continuation; omit path/position/query when continuing' } };
const properties = {
  lsp_definition: { ...position, ...paging },
  lsp_references: { ...position, include_declaration: { type: 'boolean' }, ...paging },
  lsp_document_symbols: { path, ...paging },
  lsp_workspace_symbols: { query: { type: 'string', minLength: 1, maxLength: 256 }, ...paging },
  lsp_hover: position,
  lsp_diagnostics: { path, severities: { type: 'array', maxItems: 4, items: { type: 'integer', enum: [1, 2, 3, 4] }, description: '1 error, 2 warning, 3 information, 4 hint' }, ...paging },
};
const LSP_TOOL_NAMES = Object.freeze(Object.keys(descriptions));
const lspTools = LSP_TOOL_NAMES.map(name => ({ type: 'function', function: { name, description: descriptions[name][1] + (name === 'lsp_hover' ? '' : ' Use a cursor alone for continuation.'), parameters: { type: 'object', properties: properties[name], required: name === 'lsp_hover' ? ['path', 'line', 'column'] : [], additionalProperties: false } } }));
const fail = code => ({ success: false, error: { code }, untrusted: true });
function validate(name, args) {
  const props = properties[name];
  if (!props || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  for (const [key, value] of Object.entries(args)) {
    const p = props[key]; if (!p) return false;
    if (p.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length < (p.minLength ?? 0) || value.length > (p.maxLength ?? Infinity))) return false;
    if (p.type === 'integer' && (!Number.isInteger(value) || value < (p.minimum ?? -Infinity) || value > (p.maximum ?? Infinity))) return false;
    if (p.type === 'boolean' && typeof value !== 'boolean') return false;
    if (p.type === 'array' && (!Array.isArray(value) || value.length > p.maxItems || value.some(n => !p.items.enum.includes(n)))) return false;
  }
  if (!args.cursor) {
    const required = name === 'lsp_workspace_symbols' ? ['query'] : ['lsp_definition', 'lsp_references', 'lsp_hover'].includes(name) ? ['path', 'line', 'column'] : ['path'];
    if (required.some(key => !Object.hasOwn(args, key))) return false;
  } else if (Object.keys(args).some(key => !['cursor', 'page_size'].includes(key))) return false;
  return true;
}
async function executeLspTool(name, args, context, signal) {
  if (!validate(name, args)) return fail('LSP_INVALID_REQUEST');
  if (!isTrusted(context) || !eligible(context.permissionMode)) return fail('LSP_PERMISSION_DENIED');
  if (signal?.aborted) return fail('LSP_CANCELLED');
  try {
    const permissions = require('../toolPermissions');
    await permissions.guardTool({ name, args, permissionMode: context.permissionMode, project: permissions.sessionProject(context.sessionId), signal });
  } catch (error) {
    const result = fail(signal?.aborted ? 'LSP_CANCELLED' : ['PERMISSION_DENIED', 'PERMISSION_REVOKED', 'APPROVAL_DENIED'].includes(error.code) ? 'LSP_PERMISSION_DENIED' : 'LSP_SERVER_UNAVAILABLE');
    return { ...result, language: 'JavaScript/TypeScript', phase: 'authorization',
      reason: ['PERMISSION_DENIED', 'PERMISSION_REVOKED', 'APPROVAL_DENIED'].includes(error.code) ? error.code : 'AUTHORIZATION_CHECK_FAILED',
      ...(['SQLITE_BUSY', 'SQLITE_LOCKED', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code) ? { cause_code: error.code } : {}),
      operation_executed: false, recovery: 'Continue with native file reads, project search, or existing tests. Do not repeatedly retry this LSP operation.' };
  }
  const result = await require('../lspCodeIntelligence').codeIntelligence[descriptions[name][0]]({
    filePath: args.path, line: args.line, column: args.column, query: args.query,
    includeDeclaration: args.include_declaration, pageSize: Math.min(args.page_size ?? 25, 25), cursor: args.cursor,
    severities: args.severities, outputLimit: 6000, executionContext: context, signal,
  });
  // Keep structured provenance/errors/cursors intact below both main and child result ceilings.
  // Diagnostic messages and related info can be long even on a single page.
  const output = { ...result, untrusted: true };
  if (output.results) output.results = output.results.map(item => ({ ...item,
    ...(item.message ? { message: item.message.slice(0, 240), messageTruncated: item.messageTruncated || item.message.length > 240 } : {}),
    ...(item.related ? { related: item.related.slice(0, 2).map(v => ({ ...v, message: v.message.slice(0, 120) })) } : {}) }));
  if (JSON.stringify(output).length > 10000) return fail('LSP_OUTPUT_LIMIT');
  return output;
}
function available(project) {
  if (!project?.root_path) return false;
  const manager = require('../lspManager').manager;
  if (manager.closed) return false;
  // The registry is keyed by the canonical (realpath) root; the configured
  // project root may be an alias of it. Resolve through the manager's bounded
  // alias index so a failed server is actually hidden.
  const canonical = manager.aliases.get(project.root_path) ?? project.root_path;
  const entry = manager.instances.get(canonical);
  return entry?.state !== 'failed' || (entry.crashed === true && (manager.restarts.get(canonical) ?? 0) < manager.maxRestarts);
}
module.exports = { available, LSP_TOOL_NAMES, lspTools, executeLspTool, validate };
