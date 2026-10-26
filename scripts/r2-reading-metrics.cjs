'use strict';
// Disposable native-dispatch measurement; run with node scripts/r2-reading-metrics.cjs.
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-metrics-')), load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db'); db.initDatabase(directory);
const root = path.join(directory, 'project'); fs.mkdirSync(root);
const project = require('../src/main/projectManager').createProject({ name: 'R2 metrics', root_path: root });
require('../src/main/sessionManager').getOrCreateSession('metrics', 'fixture', project.id);
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const text = Array.from({ length: 2000 }, (_, i) => `\tconst line${i + 1} = "value ${i + 1} α😀";\r\n`).join('');
fs.writeFileSync(path.join(root, 'source.js'), text);
let bytes = 0;
const realOpen = fsp.open, realReadFile = fsp.readFile;
fsp.open = async function(file, ...args) {
  const handle = await realOpen.call(this, file, ...args);
  if (file === path.join(root, 'source.js')) {
    const read = handle.read.bind(handle);
    handle.read = async (...params) => { const result = await read(...params); bytes += result.bytesRead; return result; };
  }
  return handle;
};
fsp.readFile = async function(file, ...args) {
  const result = await realReadFile.call(this, file, ...args);
  if (file === path.join(root, 'source.js')) bytes += Buffer.byteLength(result);
  return result;
};
const run = args => executeAgentTool({ name: 'read_project_file', arguments: { relative_path: 'source.js', ...args }, sessionId: 'metrics', permissionMode: 'workspace_write' });
(async () => {
  try {
    const records = {};
    for (const [name, args] of [['default', {}], ['selected_450_520', { start_line: 450, end_line: 520 }]]) {
      bytes = 0; const result = await run(args);
      const visible = result.content ?? '';
      const returned = [...visible.matchAll(/const line(\d+) =/g)].map(m => Number(m[1]));
      records[name] = { tool_calls: 1, model_visible_source_characters: visible.length, serialized_result_characters: JSON.stringify(result).length,
        serialized_result_utf8_bytes: Buffer.byteLength(JSON.stringify(result)), unrelated_lines: returned.filter(n => n < 450 || n > 520).length,
        selected_lines_delivered: returned.filter(n => n >= 450 && n <= 520).length, file_bytes_internally_read: bytes,
        start_line: result.start_line ?? null, end_line: result.end_line ?? null, next_start_line: result.next_start_line ?? null,
        content_hash: result.content_hash, total_lines: result.total_lines ?? null, content_truncated: result.content_truncated ?? null };
    }
    const first = await run({ start_line: 450, end_line: 520 });
    const second = await run({ start_line: first.next_start_line, end_line: 600, expected_content_hash: first.content_hash });
    const schema = agentTools.find(t => t.function.name === 'read_project_file');
    const output = { fixture: { lines: 2000, bytes: Buffer.byteLength(text) }, records,
      pagination: { boundary_correct: second.start_line === 521, revision_equal: second.content_hash === first.content_hash },
      schema_json_characters: JSON.stringify(schema).length, tokenizer_measured: false };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally { fsp.open = realOpen; fsp.readFile = realReadFile; db.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
