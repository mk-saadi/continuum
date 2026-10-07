'use strict';

const MAX_ITEMS = 50;
const MAX_CHARACTERS = 20000;
const LIST_TOOLS = new Set(['list_directory', 'list_directory_with_size', 'search_files']);

function limitFilesystemResult(toolName, result) {
  const listing = LIST_TOOLS.has(toolName);
  if (!listing && toolName !== 'read_text_file') return result;

  // Use one representation: MCP servers often duplicate the entire output in
  // content and structuredContent. Never serialize that uncapped copy as well.
  let value = result?.structuredContent;
  if (value == null) {
    value = Array.isArray(result?.content)
      ? result.content.map(block => block.type === 'text' ? block.text : block.resource?.text ?? '').filter(Boolean).join('\n')
      : result;
  }
  if (listing && typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* Newline-delimited listing. */ }
  }

  let remaining = MAX_ITEMS;
  let omitted = 0;
  function capItems(value) {
    if (Array.isArray(value)) {
      const count = Math.min(value.length, remaining);
      remaining -= count;
      omitted += value.length - count;
      return value.slice(0, count).map(capItems);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, capItems(entry)]));
    }
    if (typeof value === 'string' && value.includes('\n')) {
      const lines = value.split(/\r?\n/).filter(line => line.trim());
      const count = Math.min(lines.length, remaining);
      remaining -= count;
      omitted += lines.length - count;
      return lines.slice(0, count).join('\n');
    }
    return value;
  }
  if (listing) value = capItems(value);
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  const itemNotice = omitted
    ? `\n...and ${omitted} more items omitted to save context space. Please use search_files with a narrower path or specific query.` : '';
  const characterNotice = '\n[Output truncated to 20,000 characters to save context space. Request a smaller file section or a more specific query.]';
  if (text.length + itemNotice.length > MAX_CHARACTERS) {
    // Notices count toward the hard limit, including for a single huge entry.
    text = text.slice(0, MAX_CHARACTERS - itemNotice.length - characterNotice.length) + itemNotice + characterNotice;
  } else text += itemNotice;
  return { content: [{ type: 'text', text }], ...(result?.isError !== undefined ? { isError: result.isError } : {}) };
}

module.exports = { limitFilesystemResult, MAX_ITEMS, MAX_CHARACTERS };
