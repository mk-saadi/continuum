'use strict';

// Preserve original schemas. Unsupported dialects/keywords fail explicitly,
// rather than stripping constraints to manufacture compatibility.
const Ajv = require('ajv');
const validator = new Ajv({ strict: true, allErrors: false, validateFormats: true });
const Ajv2020 = require('ajv/dist/2020');
const validator2020 = new Ajv2020({ strict: true, allErrors: false, validateFormats: true });
const cache = new Map();
function compile(schema) {
  const key = JSON.stringify(schema);
  let compiled = cache.get(key);
  if (!compiled) {
    try { compiled = (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(schema?.$schema || '') ? validator2020 : validator).compile(schema); }
    catch { throw new Error('TOOL_SCHEMA_UNSUPPORTED: Authoritative JSON schema is incompatible with this validator.'); }
    if (cache.size >= 256) cache.clear();
    cache.set(key, compiled);
  }
  return compiled;
}
function validate(schema, args) {
  if (schema?.properties?.edits?.items?.required?.join(',') === 'relative_path,old_str,new_str') {
    const details = require('./tools/editDiagnostics').argumentError(args);
    if (details) require('./tools/editDiagnostics').throwDetails(details);
  }
  const compiled = compile(schema);
  if (!compiled(args)) throw new Error(`TOOL_ARGUMENTS_INVALID: ${validator.errorsText(compiled.errors).slice(0, 400)}`);
}
module.exports = { validate, compile };
