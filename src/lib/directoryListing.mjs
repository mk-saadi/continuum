export const isDirectoryTool = name => /^(?:mcp_)?list_directory(?:_with_size)?$/.test(name);

const absolute = value => typeof value === 'string' && !value.includes('\0') &&
  (/^\/(?!\/)/.test(value) || /^[a-z]:[\\/]/i.test(value)) && !value.split(/[\\/]/).includes('..');

function itemPath(item, directory) {
  if (absolute(item.path)) return item.path;
  const name = item.path ?? item.name;
  if (!absolute(directory) || typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) return null;
  return directory.replace(/[\\/]$/, '') + (directory.includes('\\') ? '\\' : '/') + name;
}

// Return null for unrecognized output so the original tool response stays visible.
export function parseDirectoryListing(result, args = {}) {
  let value = result;
  let notice = '';
  for (let depth = 0; depth < 6; depth++) {
    if (value?.isError || value?.success === false) return null;
    if (typeof value === 'string') {
      const match = value.match(/\n(?:\.\.\.and \d+ more items omitted|\[Output truncated)[\s\S]*$/);
      if (match) { notice = match[0].trim(); value = value.slice(0, match.index); }
      try { value = JSON.parse(value); continue; } catch { break; }
    }
    if (Array.isArray(value)) break;
    if (value?.structuredContent != null) { value = value.structuredContent; continue; }
    if (Array.isArray(value?.content)) {
      value = value.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      continue;
    }
    if (Array.isArray(value?.entries) || Array.isArray(value?.items)) { value = value.entries ?? value.items; continue; }
    return null;
  }
  if (typeof value === 'string') {
    const lines = value.split(/\r?\n/).filter(line => line.trim());
    const entries = [];
    for (const line of lines) {
      const match = line.match(/^\[(DIR|FILE)\]\s+(.+)$/);
      if (!match) {
        if (/^(Total(?: (?:files|directories|size))?:|Combined size:|\d+ directories?, \d+ files?)/.test(line)) continue;
        return null;
      }
      // The filesystem MCP server pads names before its human-readable sizes.
      const parts = match[2].match(/^(.*?)\s{2,}(\d+(?:\.\d+)?\s*(?:bytes?|[KMGT]?B))$/i);
      entries.push({ type: match[1] === 'DIR' ? 'directory' : 'file', name: parts ? parts[1] : match[2], size: parts?.[2] });
    }
    if (!entries.length) return null;
    value = entries;
  }
  if (!Array.isArray(value)) return null;
  const items = [];
  for (const item of value) {
    if (!item || !['directory', 'file'].includes(item.type)) return null;
    const path = itemPath(item, args?.path);
    if (!path) return null;
    items.push({ ...item, path, name: item.name || path.split(/[\\/]/).filter(Boolean).pop() || path });
  }
  return { items, notice };
}

export const localMediaUrl = path => `local://media/${encodeURIComponent(path)}`;
