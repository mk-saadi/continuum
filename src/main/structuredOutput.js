'use strict';
// Serialization repair only. Never synthesize closing delimiters or values.
function normalizeJSON(input) {
  if (typeof input !== 'string' || input.length > 1000000) throw Object.assign(new Error('invalid-json'), { code: 'invalid-json' });
  let source = input.replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  if (fence && !fence[1].includes('```')) source = fence[1].trim();
  let output = '', quoted = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === ',') {
      let next = i + 1;
      while (/\s/.test(source[next] ?? '') && next < source.length) next++;
      // Only a trailing comma following a real value may be removed. Invalid
      // empty arrays/objects and doubled commas remain invalid JSON.
      const previous = output.trimEnd().at(-1);
      if (['}', ']'].includes(source[next]) && previous && !['[', '{', ',', ':'].includes(previous)) continue;
    }
    output += char;
  }
  try { return { value: JSON.parse(output), disposition: output === input ? 'unchanged' : 'repaired' }; }
  catch { throw Object.assign(new Error('invalid-json'), { code: 'invalid-json' }); }
}
module.exports = { normalizeJSON };
