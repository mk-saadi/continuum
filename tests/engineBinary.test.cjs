const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveEngineCommand,
  describeEngineSpawnError,
  ENGINE_BINARY_ENV,
} = require('../src/main/engineManager');

function executable(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-engine-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'llama-server');
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('the managed loader resolves the bare binary when no override is set', () => {
  assert.equal(resolveEngineCommand({ PATH: '/usr/bin' }), 'llama-server');
  assert.equal(resolveEngineCommand({ [ENGINE_BINARY_ENV]: '   ' }), 'llama-server');
});

test('an explicit executable path overrides the PATH lookup', (t) => {
  const file = executable(t);
  assert.equal(resolveEngineCommand({ [ENGINE_BINARY_ENV]: file }), file);
});

test('an unusable override fails before spawn with an actionable error', (t) => {
  const missing = path.join(os.tmpdir(), 'continuum-does-not-exist', 'llama-server');
  assert.throws(() => resolveEngineCommand({ [ENGINE_BINARY_ENV]: missing }), new RegExp(ENGINE_BINARY_ENV));
  const file = executable(t);
  fs.chmodSync(file, 0o644);
  assert.throws(() => resolveEngineCommand({ [ENGINE_BINARY_ENV]: file }), /not an executable file/);
});

test('a bare-name ENOENT explains PATH lookup and the override', () => {
  const error = Object.assign(new Error('spawn llama-server ENOENT'), {
    code: 'ENOENT',
    errno: -2,
    syscall: 'spawn llama-server',
  });
  const message = describeEngineSpawnError(error, 'llama-server', { PATH: ['/one', '/two'].join(path.delimiter) });
  assert.match(message, /\(ENOENT\)/);
  assert.match(message, /not found in any directory on the app's PATH/);
  assert.match(message, new RegExp(path.join('/one', 'llama-server').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(message, new RegExp(ENGINE_BINARY_ENV));
});

test('ENOTFOUND and EACCES are reported instead of leaking the raw errno', () => {
  const notFound = Object.assign(new Error('spawn llama-server ENOTFOUND'), { code: 'ENOTFOUND' });
  assert.match(describeEngineSpawnError(notFound, 'llama-server', { PATH: '/bin' }), /\(ENOTFOUND\)/);
  const denied = Object.assign(new Error('spawn llama-server EACCES'), { code: 'EACCES' });
  assert.match(describeEngineSpawnError(denied, '/opt/engine/llama-server'), /not allowed to execute/);
});

test('an explicit path ENOENT names the stale symlink or moved build', () => {
  const error = Object.assign(new Error('spawn /opt/engine/llama-server ENOENT'), { code: 'ENOENT' });
  const message = describeEngineSpawnError(error, '/opt/engine/llama-server', { PATH: '/bin' });
  assert.match(message, /stale symlink or a build that was moved/);
  assert.doesNotMatch(message, /Tried:/);
});

test('errors that are not executable-resolution failures keep their own message', () => {
  const error = Object.assign(new Error('Previous local engine did not stop.'), { code: 'ETIMEDOUT' });
  assert.equal(describeEngineSpawnError(error, 'llama-server'), 'Previous local engine did not stop.');
});
