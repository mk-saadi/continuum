'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

function nativePlaywrightConfig(configDirectory) {
  // The child runtime and browser tooling need physical paths. These dependencies
  // are unpacked by electron-builder, so resolve their physical release paths.
  const manifest = require.resolve('@playwright/mcp/package.json')
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const packageRequire = createRequire(manifest);
  const cli = path.join(path.dirname(manifest), packageRequire('./package.json').bin['playwright-mcp']);
  const executable = packageRequire('playwright-core').chromium.executablePath();
  return {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    args: [cli, '--headless', '--executable-path', executable],
    ...(configDirectory ? { cwd: configDirectory } : {}),
    enabled: true,
  };
}

function resolveNativePlaywright(name, definition) {
  if (name !== 'playwright-native' || definition.url !== undefined) return definition;
  // Recognize our bundled CLI across AppImage mount changes, including legacy
  // configurations that launched host Node. Leave replacement servers alone.
  const cli = definition.args?.[0];
  if (typeof cli !== 'string' || !/[\\/]node_modules[\\/]@playwright[\\/]mcp[\\/]cli\.js$/.test(cli)) return definition;
  if (definition.command !== 'node' && definition.env?.ELECTRON_RUN_AS_NODE !== '1') return definition;
  const native = nativePlaywrightConfig();
  const args = [...definition.args];
  args[0] = native.args[0];
  return { ...definition, command: process.execPath, args,
    env: { ...definition.env, ELECTRON_RUN_AS_NODE: '1' } };
}

async function prepareNativePlaywright(name, definition) {
  if (name !== 'playwright-native') return;
  const native = nativePlaywrightConfig();
  // A user's replacement command is their configuration, not our installer.
  if (definition.command !== native.command || definition.args?.[0] !== native.args[0]) return;
  const executableIndex = definition.args.indexOf('--executable-path');
  if (executableIndex < 0 || definition.args[executableIndex + 1] !== native.args[3]) return;
  try { await fs.access(native.args[3]); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  // Use this MCP package's matching browser revision, without npx or a global
  // Playwright installation. Subsequent launches reuse the browser cache.
  try {
    await runFile(process.execPath, [native.args[0], 'install-browser', 'chromium', '--no-shell'], {
      env: { ...process.env, ...definition.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    await fs.access(native.args[3]);
  } catch (error) {
    throw new Error(`Native Playwright browser setup failed: ${error.message}`);
  }
}

module.exports = { nativePlaywrightConfig, resolveNativePlaywright, prepareNativePlaywright };
