'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Deliberately narrow, implementation-reviewed semantics. These native tools
// consume concrete paths and do not produce handles required by sibling calls.
// MCP annotations alone are not an enforced independence guarantee.
async function preflightIndependentRead(call, { tools, nativeNames, root, authorize, signal }) {
  signal?.throwIfAborted();
  if (!nativeNames.has(call.function.name) || !['read_project_file', 'list_directory'].includes(call.function.name) || !root) return false;
  const schema = tools.find(tool => tool.function.name === call.function.name)?.function.parameters;
  if (!schema) return false;
  const args = JSON.parse(call.function.arguments || '{}');
  require('./toolSchemaValidation').validate(schema, args);
  const allowed = call.function.name === 'read_project_file'
    ? ['relative_path', 'start_line', 'end_line', 'char_start', 'if_content_hash', 'expected_content_hash'] : ['relative_path'];
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (call.function.name === 'read_project_file') {
    // R2's range relationships are stricter than the JSON field schemas.
    for (const value of [args.start_line, args.end_line]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 1000000000)) return false;
    }
    if (args.end_line !== undefined && args.end_line < (args.start_line ?? 1)) return false;
    if (args.char_start !== undefined && (!Number.isSafeInteger(args.char_start) || args.char_start < 0 || args.start_line === undefined || args.end_line !== args.start_line)) return false;
    if (args.if_content_hash && args.expected_content_hash) return false;
  }
  // Never open devices, pipes or sockets during overflow partial execution.
  const realRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(realRoot, args.relative_path ?? '.'));
  const relative = path.relative(realRoot, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  const stat = await fs.stat(target);
  if (call.function.name === 'read_project_file' ? !stat.isFile() : !stat.isDirectory()) return false;
  // Binary/PDF branches allocate whole-file payloads. Keep automatic overflow
  // on the R2 bounded text branch; ordinary <=24 batches retain all formats.
  if (call.function.name === 'read_project_file' && /\.(png|jpe?g|webp|gif|pdf)$/i.test(target)) return false;
  // No approval UI may be opened by a classification pass. The caller uses
  // the regular live guard, with approval requests failing closed.
  await authorize(call.function.name, args);
  signal?.throwIfAborted();
  return true;
}
module.exports = { preflightIndependentRead };
