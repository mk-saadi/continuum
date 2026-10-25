'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-git-relay-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => path.join(directory, 'userdata') } };
  return load.call(this, name, ...args);
};
const { runGit } = require('../src/main/tools/agentTools');
Module._load = load;
const git = (args, cwd) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
test('contained Git push/fetch use read-only askpass relay with minimal environment', async () => {
  // resolveFilesystem obtains Electron only while preparing each run.
  Module._load = function(name, ...args) { if (name === 'electron') return { app: { getPath: () => path.join(directory, 'userdata') } }; return load.call(this, name, ...args); };
  const work = path.join(directory, 'work'), remote = path.join(directory, 'remote.git'), helpers = path.join(directory, 'helper');
  fs.mkdirSync(work); fs.mkdirSync(helpers); git(['init', '-b', 'main'], work); git(['init', '--bare', remote], directory);
  git(['config', 'http.receivepack', 'true'], remote);
  fs.writeFileSync(path.join(work, 'file'), 'fixture'); git(['add', 'file'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], work);
  let relayRequests = 0;
  const relay = http.createServer((req, res) => { relayRequests++; res.end('synthetic-relay-token'); });
  const remoteServer = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture:synthetic-relay-token').toString('base64')) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const backend = cp.spawn('git', ['http-backend'], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'fixture' } });
    req.pipe(backend.stdin); let buffer = Buffer.alloc(0), headersDone = false;
    backend.stdout.on('data', chunk => {
      if (headersDone) { res.write(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]); const split = buffer.indexOf('\r\n\r\n'); if (split < 0) return;
      const headers = {}; let status = 200;
      for (const line of buffer.subarray(0, split).toString().split('\r\n')) { const i = line.indexOf(':'); if (i < 0) continue; const key = line.slice(0, i), value = line.slice(i + 1).trim(); if (key.toLowerCase() === 'status') status = parseInt(value); else headers[key] = value; }
      res.writeHead(status, headers); headersDone = true; res.write(buffer.subarray(split + 4));
    });
    backend.stdout.on('end', () => res.end()); backend.stderr.resume();
  });
  const oldSecret = process.env.CONTINUUM_TEST_SECRET; process.env.CONTINUUM_TEST_SECRET = 'must-not-enter';
  try {
    await listen(relay); await listen(remoteServer);
    const helper = path.join(helpers, 'askpass.sh');
    fs.writeFileSync(helper, `#!/bin/sh\ntest -z "$CONTINUUM_TEST_SECRET" || exit 99\ncase "$1" in *Username*) echo fixture;; *) exec curl -fsS http://127.0.0.1:${relay.address().port}/token;; esac\n`, { mode: 0o700 });
    const url = `http://127.0.0.1:${remoteServer.address().port}/remote.git`;
    await runGit(work, ['push', url, 'main'], undefined, { network: true, write: true, askpass: helper });
    await runGit(work, ['fetch', url, 'main'], undefined, { network: true, write: true, askpass: helper });
    assert.ok(relayRequests >= 2); assert.equal(git(['rev-parse', 'main'], remote), git(['rev-parse', 'HEAD'], work));
  } finally {
    if (oldSecret === undefined) delete process.env.CONTINUUM_TEST_SECRET; else process.env.CONTINUUM_TEST_SECRET = oldSecret;
    await close(remoteServer); await close(relay); Module._load = load; fs.rmSync(directory, { recursive: true, force: true });
  }
});
