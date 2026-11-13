'use strict';

// Preserve original schemas. Unsupported dialects/keywords fail explicitly,
// rather than stripping constraints to manufacture compatibility.
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const options = { strict: true, allErrors: false, validateFormats: true, allowUnionTypes: true };
const validator = addFormats(new Ajv(options));
const Ajv2020 = require('ajv/dist/2020');
const validator2020 = addFormats(new Ajv2020(options));
const cache = new Map();
function compile(schema) {
  const key = JSON.stringify(schema);
  let compiled = cache.get(key);
  if (!compiled) {
    try { compiled = (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(schema?.$schema || '') ? validator2020 : validator).compile(schema); }
    catch (cause) { throw new Error(`TOOL_SCHEMA_UNSUPPORTED: Authoritative JSON schema could not be compiled: ${String(cause.message).slice(0, 400)}. Changing tool arguments will not fix this schema; report the compatibility error.`, { cause }); }
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
