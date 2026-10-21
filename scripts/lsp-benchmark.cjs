'use strict';

// Phase 2.6A-4 — LSP process, memory and latency benchmark.
//
// Measures the real bundled language server through the production manager
// and adapter. No model, provider, network or paid inference is involved.
//
// Scenarios
//   A  idle server        — initialize, one small query, then idle
//   B  repeated queries  — bounded sequence of the six operations
//   C  concurrent agents  — several authorized callers in one workspace
//   D  workspace switch  — release one workspace, activate another
//   E  shutdown           — close the manager, verify the children are gone
//
// Memory is read from /proc/<pid>/status (RSS) on Linux and reported as
// unavailable elsewhere. Latency numbers are wall-clock milliseconds.
//
// Usage: node scripts/lsp-benchmark.cjs [outputJsonPath]

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');

const outputPath = process.argv[2] || '/tmp/lsp-benchmark-evidence.json';
// The native tool layer resolves the workspace through the real session and
// project records, so the benchmark runs against a temporary database with the
// same electron surface the main process provides.
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-bench-db-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => databaseDirectory }, ipcMain: { handle: () => {}, removeHandler: () => {} } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const { LspManager } = require('../src/main/lspManager');
const { LspCodeIntelligence } = require('../src/main/lspCodeIntelligence');

const report = { environment: {}, scenarios: {}, resultSizes: {}, notes: [] };

function rss(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return match ? Number(match[1]) * 1024 : null;
  } catch { return null; }
}

function descendants(pid) {
  try {
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    return children.flatMap(child => [Number(child), ...descendants(Number(child))]);
  } catch { return []; }
}

function treeRss(pid) {
  const pids = [pid, ...descendants(pid)];
  let total = 0; let measured = 0;
  for (const p of pids) { const value = rss(p); if (value != null) { total += value; measured++; } }
  return measured ? { bytes: total, processes: measured } : null;
}

function processCount(pattern) {
  try {
    return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(name => {
      if (Number(name) === process.pid) return false;
      try { const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '); return cmd.includes(pattern) && !cmd.includes('/bin/sh') && !cmd.includes('/bin/bash'); } catch { return false; }
    }).length;
  } catch { return null; }
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

const FILES = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: 'preserve', noEmit: true }, include: ['**/*'] }),
  'a.ts': 'export function answer(): number { return 42; }\nexport class Service { method() { return answer(); } }\n',
  'b.ts': 'import { answer } from "./a";\nconst value: string = answer();\n' + Array.from({ length: 60 }, (_, i) => `const result${i} = answer();`).join('\n'),
  'c.ts': 'import { Service } from "./a";\nexport const service = new Service();\n',
  'plain.js': 'export const plain = 1;\n',
};

async function makeRoot(tag) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `lsp-bench-${tag}-`));
  for (const [name, text] of Object.entries(FILES)) await fsp.writeFile(path.join(root, name), text);
  return root;
}

async function main() {
  report.environment = {
    platform: process.platform, arch: process.arch,
    node: process.versions.node, electron: process.versions.electron ?? null,
    cpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
    loadAverage: os.loadavg(), timestamp: new Date().toISOString(),
  };

  const rootA = await makeRoot('a');
  const rootB = await makeRoot('b');
  const roots = { a: rootA, b: rootB };
  initDatabase(databaseDirectory);
  const project = require('../src/main/projectManager').createProject({ name: 'lsp-benchmark', root_path: rootA });
  require('../src/main/sessionManager').getOrCreateSession('benchmark-session', 'model', project.id);
  const manager = new LspManager({ authorize: c => (c?.root === 'b' ? rootB : rootA), requestTimeout: 20000, initializationTimeout: 30000, shutdownTimeout: 500 });
  const api = new LspCodeIntelligence(manager, { diagnosticWait: 800 });
  const context = { permissionMode: 'workspace_write', root: 'a' };

  try {
    // --- Scenario A: idle server -------------------------------------------
    const startupBegan = performance.now();
    const entry = await manager.acquire(context);
    const startupMs = performance.now() - startupBegan;
    const pid = entry.client.child.pid;
    const idle = await api.hover({ executionContext: context, filePath: 'a.ts', line: 1, column: 17 });
    await new Promise(r => setTimeout(r, 500));
    report.scenarios.A_idle = {
      startupMs: Number(startupMs.toFixed(2)),
      serverPid: pid,
      serverProcessCount: processCount('cli.mjs --stdio'),
      treeRssBytes: treeRss(pid),
      memoryAvailable: rss(pid) != null,
      hoverBytes: Buffer.byteLength(JSON.stringify(idle)),
    };

    // --- Scenario B: repeated queries --------------------------------------
    const latencies = { definition: [], references: [], hover: [], documentSymbols: [], workspaceSymbols: [], diagnostics: [] };
    const sizes = { definition: [], references: [], hover: [], documentSymbols: [], workspaceSymbols: [], diagnostics: [] };
    const before = treeRss(pid);
    const began = performance.now();
    for (let i = 0; i < 60; i++) {
      const ops = [
        ['definition', { filePath: 'a.ts', line: 1, column: 17 }],
        ['references', { filePath: 'a.ts', line: 1, column: 17, includeDeclaration: true }],
        ['hover', { filePath: 'a.ts', line: 1, column: 17 }],
        ['documentSymbols', { filePath: 'a.ts' }],
        ['workspaceSymbols', { query: 'answer' }],
        ['diagnostics', { filePath: 'b.ts' }],
      ];
      for (const [op, args] of ops) {
        const t = performance.now();
        const result = await api[op]({ executionContext: context, ...args });
        latencies[op].push(performance.now() - t);
        sizes[op].push(Buffer.byteLength(JSON.stringify(result)));
      }
    }
    const totalMs = performance.now() - began;
    report.scenarios.B_repeated = {
      operations: Object.values(latencies).reduce((n, l) => n + l.length, 0),
      totalMs: Number(totalMs.toFixed(2)),
      treeRssBefore: before,
      treeRssAfter: treeRss(pid),
      perOperation: Object.fromEntries(Object.entries(latencies).map(([op, list]) => {
        const sorted = [...list].sort((x, y) => x - y);
        return [op, {
          count: list.length,
          p50Ms: Number(pct(sorted, 0.5).toFixed(2)),
          p95Ms: Number(pct(sorted, 0.95).toFixed(2)),
          maxMs: Number(Math.max(...list).toFixed(2)),
          resultBytesMean: Math.round(sizes[op].reduce((n, b) => n + b, 0) / sizes[op].length),
        }];
      })),
    };

    // Raw protocol payload sizes are captured while the server is live; the
    // model-facing sizes are captured after the lifecycle scenarios.
    const docUri = pathToFileURL(path.join(rootA, 'a.ts')).href;
    const rawSizes = {};
    for (const [op, method, params] of [
      ['definition', 'textDocument/definition', { textDocument: { uri: docUri }, position: { line: 0, character: 16 } }],
      ['references', 'textDocument/references', { textDocument: { uri: docUri }, position: { line: 0, character: 16 }, context: { includeDeclaration: true } }],
      ['hover', 'textDocument/hover', { textDocument: { uri: docUri }, position: { line: 0, character: 16 } }],
      ['documentSymbols', 'textDocument/documentSymbol', { textDocument: { uri: docUri } }],
      ['workspaceSymbols', 'workspace/symbol', { query: 'answer' }],
    ]) {
      try { rawSizes[op] = Buffer.byteLength(JSON.stringify(await entry.client.request(method, params))); } catch { rawSizes[op] = null; }
    }

    // --- Scenario C: concurrent agents -------------------------------------
    const concurrency = { callers: 4, perCaller: 12 };
    const callers = Array.from({ length: concurrency.callers }, (_, i) => ({ permissionMode: 'workspace_write', root: i === 3 ? 'b' : 'a' }));
    const results = await Promise.all(callers.map(async (caller, index) => {
      const lat = [];
      for (let i = 0; i < concurrency.perCaller; i++) {
        const t = performance.now();
        await api.hover({ executionContext: { ...caller, root: caller.root }, filePath: 'a.ts', line: 1, column: 17 });
        lat.push(performance.now() - t);
      }
      return { index, sorted: lat.sort((x, y) => x - y) };
    }));
    report.scenarios.C_concurrent = {
      callers: concurrency.callers, operations: concurrency.callers * concurrency.perCaller,
      serverProcessCount: processCount('cli.mjs --stdio'),
      instances: manager.stats().count,
      perCallerP95Ms: results.map(r => Number(pct(r.sorted, 0.95).toFixed(2))),
    };

    // --- Scenario D: workspace switch --------------------------------------
    const beforeSwitch = manager.stats().count;
    await manager.closeRoot(rootA);
    const afterRelease = manager.stats().count;
    const switched = await manager.acquire({ permissionMode: 'workspace_write', root: 'b' });
    report.scenarios.D_workspaceSwitch = {
      instancesBeforeRelease: beforeSwitch,
      instancesAfterRelease: afterRelease,
      instancesAfterSwitch: manager.stats().count,
      switchedRoot: switched.root === rootB,
      serverProcessCount: processCount('cli.mjs --stdio'),
    };

    // --- Scenario E: shutdown ----------------------------------------------
    const pids = [...manager.instances.values()].map(e => e.client?.child?.pid).filter(Boolean);
    const shutdownBegan = performance.now();
    await manager.close();
    const shutdownMs = performance.now() - shutdownBegan;
    const immediately = processCount('cli.mjs --stdio');
    await new Promise(r => setTimeout(r, 1500));
    report.scenarios.E_shutdown = {
      shutdownMs: Number(shutdownMs.toFixed(2)),
      instancesAfterClose: manager.stats().count,
      survivors: pids.filter(p => { try { process.kill(p, 0); return true; } catch { return false; } }),
      serverProcessCountImmediately: immediately,
      serverProcessCountAfterSettle: processCount('cli.mjs --stdio'),
      tsserverProcessCountAfterSettle: processCount('tsserver.js'),
    };

    // --- Result size comparison against the raw protocol payload ----------
    // The model only ever sees the native tool result, so that is what the
    // size budget must be measured against. The raw protocol payload is shown
    // for comparison; it is never handed to the model. This runs after the
    // lifecycle scenarios because the native tool path owns its own server.
    const { executeLspTool } = require('../src/main/tools/lspTools');
    const contexts = require('../src/main/lspExecutionContext');
    const trusted = contexts.forTool('benchmark-session', 'full_access');
    const toolNames = { definition: 'lsp_definition', references: 'lsp_references', hover: 'lsp_hover', documentSymbols: 'lsp_document_symbols', workspaceSymbols: 'lsp_workspace_symbols', diagnostics: 'lsp_diagnostics' };
    const toolArgs = {
      definition: { path: 'a.ts', line: 1, column: 17 },
      references: { path: 'a.ts', line: 1, column: 17, include_declaration: true },
      hover: { path: 'a.ts', line: 1, column: 17 },
      documentSymbols: { path: 'a.ts' },
      workspaceSymbols: { query: 'answer' },
    };
    report.resultSizes = { toolSchemaBytes: Buffer.byteLength(JSON.stringify(require('../src/main/tools/lspTools').lspTools)), operations: {}, note: 'Tokens are a characters/4 estimate, not a tokenizer measurement.' };
    for (const op of Object.keys(toolArgs)) {
      const toolResult = await executeLspTool(toolNames[op], toolArgs[op], trusted);
      const modelBytes = Buffer.byteLength(JSON.stringify(toolResult));
      report.resultSizes.operations[op] = {
        rawProtocolBytes: rawSizes[op] ?? null,
        modelFacingBytes: modelBytes,
        metadataOverheadBytes: rawSizes[op] != null ? modelBytes - rawSizes[op] : null,
        approxModelTokens: Math.ceil(modelBytes / 4),
      };
    }
    const diagnosticTool = await executeLspTool('lsp_diagnostics', { path: 'b.ts' }, trusted);
    report.resultSizes.operations.diagnostics = {
      modelFacingBytes: Buffer.byteLength(JSON.stringify(diagnosticTool)),
      approxModelTokens: Math.ceil(Buffer.byteLength(JSON.stringify(diagnosticTool)) / 4),
      state: diagnosticTool.state ?? null,
    };
    await require('../src/main/lspManager').manager.close();
  } finally {
    await manager.close();
    await fsp.rm(rootA, { recursive: true, force: true });
    await fsp.rm(rootB, { recursive: true, force: true });
    try { closeDatabase(); } catch {}
    Module._load = originalLoad;
    try { fs.rmSync(databaseDirectory, { recursive: true, force: true }); } catch {}
  }

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log('LSP_BENCHMARK ' + JSON.stringify(report));
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
