'use strict';

// Packaged-runtime LSP smoke test (Phase 2.6A-4).
//
// Runs the *packaged* Electron binary as a Node host and drives the *packaged*
// application code (inside app.asar) against a temporary JS/TS workspace:
//
//   ELECTRON_RUN_AS_NODE=1 <appDir>/<binary> scripts/lsp-packaged-smoke.cjs <appDir>
//
// It proves, on the real packaged layout, that:
//   1. the bundled language server resolves from app.asar.unpacked,
//   2. the server actually starts under the packaged Electron runtime,
//   3. all six read-only LSP operations return real semantic results,
//   4. shutdown removes the child process (no orphan).
//
// No model, provider, network or paid inference is involved.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const appDir = path.resolve(process.argv[2] || 'release-lsp4/linux-unpacked');
const asar = path.join(appDir, 'resources', 'app.asar');
const output = { appDir, asar, ok: false, operations: {}, checks: {} };

function fail(message) { throw new Error(message); }

async function main() {
  if (!fs.existsSync(asar)) fail(`Packaged app.asar not found: ${asar}`);
  const { LspManager, runtimePath } = require(path.join(asar, 'src', 'main', 'lspManager.js'));
  const { LspCodeIntelligence } = require(path.join(asar, 'src', 'main', 'lspCodeIntelligence.js'));
  output.checks.loadedFromAsar = true;
  output.execPath = process.execPath;
  output.runtime = { electron: process.versions.electron, node: process.versions.node };

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-packaged-smoke-'));
  const root = path.join(directory, 'workspace with spaces');
  fs.mkdirSync(root);
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: 'preserve', noEmit: true, target: 'es2020', module: 'esnext', moduleResolution: 'bundler' }, include: ['**/*'] }),
    'a.ts': 'export function answer(): number { return 42; }\nexport class Service { method() { return answer(); } }\n',
    'b.ts': 'import { answer } from "./a";\nconst value: string = answer();\n' + Array.from({ length: 20 }, (_, i) => `const result${i} = answer();`).join('\n'),
    'plain.js': 'export const plain = 1;\n',
    'view.tsx': 'export const ViewTS = () => <div />;\n',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);

  const manager = new LspManager({ authorize: () => root });
  const api = new LspCodeIntelligence(manager);
  const context = { permissionMode: 'workspace_write' };
  try {
    const cold = performance.now();
    const entry = await manager.acquire(context);
    output.checks.startupMs = Math.round(performance.now() - cold);
    output.checks.serverState = entry.state;
    output.checks.serverPid = entry.client.child.pid;
    output.checks.serverExecutable = entry.client.child.spawnfile;

    // The launched CLI must come from the unpacked asar payload, never from a
    // global npm installation or the repository source tree.
    const resolved = require.resolve(path.join(asar, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'));
    const cli = runtimePath(resolved);
    output.checks.resolvedCli = resolved;
    output.checks.runtimeCli = cli;
    output.checks.cliInsideUnpacked = cli.includes('app.asar.unpacked');
    output.checks.cliExistsOnDisk = fs.existsSync(cli);
    output.checks.spawnArgs = entry.client.child.spawnargs;
    output.checks.spawnedCliMatches = entry.client.child.spawnargs.includes(cli);
    if (!output.checks.cliInsideUnpacked) fail(`Bundled CLI did not resolve to app.asar.unpacked: ${cli}`);
    if (!output.checks.cliExistsOnDisk) fail(`Unpacked CLI is missing on disk: ${cli}`);
    if (!output.checks.spawnedCliMatches) fail(`Server was not launched with the bundled CLI: ${JSON.stringify(entry.client.child.spawnargs)}`);
    const tsserver = runtimePath(require.resolve(path.join(asar, 'node_modules', 'typescript', 'lib', 'tsserver.js')));
    output.checks.runtimeTsserver = tsserver;
    output.checks.tsserverExistsOnDisk = fs.existsSync(tsserver);
    if (!output.checks.tsserverExistsOnDisk) fail(`Unpacked tsserver is missing on disk: ${tsserver}`);

    // Position inside the `answer` identifier on the usage line. The first
    // character of an import alias resolves to the alias declaration itself,
    // so the probe deliberately sits inside the identifier.
    const bLines = files['b.ts'].split('\n');
    const column = bLines[1].indexOf('answer') + 3;
    const measure = async (name, fn) => {
      const t = performance.now();
      const value = await fn();
      output.operations[name] = { ms: Math.round((performance.now() - t) * 100) / 100, bytes: Buffer.byteLength(JSON.stringify(value)), value };
      return value;
    };

    const definition = await measure('definition', () => api.definition({ executionContext: context, filePath: 'b.ts', line: 2, column }));
    if (!definition.success || !definition.results.length) fail('definition returned no location');
    if (definition.results.some(r => r.path.startsWith('/') || r.path.includes('..'))) fail('definition escaped the workspace');

    // Cross-module proof: the references of the declaration in a.ts must
    // include the importing file b.ts.
    const references = await measure('references', () => api.references({ executionContext: context, filePath: 'a.ts', line: 1, column: 17, includeDeclaration: true, pageSize: 10 }));
    if (!references.success || references.totalCount < 20) fail('references did not return the expected count');
    if (!references.results.some(r => r.path === 'b.ts')) fail('references did not cross the module boundary');
    if (!references.nextCursor) fail('references did not produce a continuation cursor');
    const page2 = await measure('referencesPage2', () => api.references({ executionContext: context, cursor: references.nextCursor, pageSize: 10 }));
    if (!page2.success || page2.snapshotId !== references.snapshotId) fail('continuation did not preserve the snapshot');
    const hover = await measure('hover', () => api.hover({ executionContext: context, filePath: 'b.ts', line: 2, column }));
    if (!hover.success || !/answer/.test(hover.content || '')) fail('hover did not report the answer signature');
    if (!/number/.test(hover.content || '')) fail('hover did not resolve the cross-module type');
    const symbols = await measure('documentSymbols', () => api.documentSymbols({ executionContext: context, filePath: 'a.ts' }));
    if (!symbols.success || !symbols.results.some(s => s.name === 'Service')) fail('document symbols missed Service');
    const workspaceSymbols = await measure('workspaceSymbols', () => api.workspaceSymbols({ executionContext: context, query: 'answer' }));
    if (!workspaceSymbols.success || !workspaceSymbols.results.some(s => s.name === 'answer')) fail('workspace symbols missed answer');

    // Diagnostics: bounded, event-driven wait for the first publication.
    const diagnostics = await measure('diagnostics', () => api.diagnostics({ executionContext: context, filePath: 'b.ts' }));
    if (!diagnostics.success) fail('diagnostics failed');
    output.checks.diagnosticState = diagnostics.state;
    output.checks.diagnosticCount = diagnostics.results.length;

    // A JavaScript-only file must still answer symbol queries.
    const jsSymbols = await measure('jsDocumentSymbols', () => api.documentSymbols({ executionContext: context, filePath: 'plain.js' }));
    if (!jsSymbols.success) fail('javascript document symbols failed');
    const tsxSymbols = await measure('tsxDocumentSymbols', () => api.documentSymbols({ executionContext: context, filePath: 'view.tsx' }));
    if (!tsxSymbols.success) fail('typescriptreact document symbols failed');

    const pid = entry.client.child.pid;
    const t = performance.now();
    await manager.close();
    output.checks.shutdownMs = Math.round(performance.now() - t);
    output.checks.instancesAfterClose = manager.instances.size;
    await new Promise(r => setTimeout(r, 200));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    output.checks.serverAliveAfterShutdown = alive;
    if (alive) fail('language server process survived shutdown');
    output.checks.noOrphan = true;
    output.ok = true;
  } finally {
    try { await manager.close(); } catch {}
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('LSP_PACKAGED_SMOKE ' + JSON.stringify(output));
  process.exit(output.ok ? 0 : 1);
}).catch(error => {
  console.log('LSP_PACKAGED_SMOKE_FAILED ' + JSON.stringify({ ...output, error: error.message, stack: error.stack }));
  process.exit(1);
});
