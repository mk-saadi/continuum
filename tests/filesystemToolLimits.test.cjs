const { test } = require('node:test');
const assert = require('node:assert/strict');
const { limitFilesystemResult, MAX_CHARACTERS } = require('../src/main/filesystemToolLimits');

test('all directory and search tools cap line output across MCP blocks', () => {
  for (const name of ['list_directory', 'list_directory_with_size', 'search_files']) {
    const result = { content: Array.from({ length: 392 }, (_, i) => ({ type: 'text', text: `/tmp/file-${i}` })) };
    const text = limitFilesystemResult(name, result).content[0].text;
    assert.equal(text.split('\n').filter(line => line.startsWith('/tmp/')).length, 50);
    assert.match(text, /342 more items omitted/);
    assert.doesNotMatch(text, /file-50\b/);
    assert.equal(result.content.length, 392);
  }
});

test('structured and JSON listings are capped without duplicate output', () => {
  const entries = Array.from({ length: 75 }, (_, i) => ({ name: `file-${i}`, size: i }));
  for (const result of [
    { content: [{ type: 'text', text: JSON.stringify({ entries }) }] },
    { content: [{ type: 'text', text: 'UNCAPPED DUPLICATE' }], structuredContent: { entries }, _meta: { large: 'UNCAPPED METADATA' } },
  ]) {
    const limited = limitFilesystemResult('list_directory_with_size', result);
    const text = limited.content[0].text;
    assert.match(text, /25 more items omitted/);
    assert.equal((text.match(/"name":/g) || []).length, 50);
    assert.doesNotMatch(JSON.stringify(limited), /UNCAPPED/);
  }
});

test('text files and huge listing entries obey the character cap including warnings', () => {
  for (const name of ['read_text_file', 'search_files']) {
    const result = { content: [{ type: 'text', text: 'x'.repeat(60000) }], isError: false };
    const limited = limitFilesystemResult(name, result);
    assert.equal(limited.content[0].text.length, MAX_CHARACTERS);
    assert.match(limited.content[0].text, /Output truncated/);
    assert.equal(limited.isError, false);
  }
  const error = limitFilesystemResult('read_text_file', { content: [{ type: 'text', text: 'Access denied' }], isError: true });
  assert.equal(error.isError, true);
  assert.equal(error.content[0].text, 'Access denied');
  const other = { content: [{ type: 'text', text: 'x'.repeat(60000) }] };
  assert.equal(limitFilesystemResult('unrelated_tool', other), other);
});

test('MCP execution applies the cap before serialization', async () => {
  const manager = require('../src/main/mcpManager');
  manager.servers.set('limit-fixture', {
    enabled: true, status: 'connected', disabledTools: new Set(), tools: [{ name: 'read_text_file' }],
    client: { callTool: async () => ({ structuredContent: { text: 'x'.repeat(60000) } }) },
  });
  try {
    const result = JSON.parse(await manager.callTool('limit-fixture', 'read_text_file', {}));
    assert.equal(result.content[0].text.length, MAX_CHARACTERS);
    assert.equal(result.structuredContent, undefined);
  } finally { manager.servers.delete('limit-fixture'); }
});
