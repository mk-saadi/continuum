'use strict';
// ELECTRON_RUN_AS_NODE=1 <packaged-electron> scripts/audits/r4PackagedMemory.cjs <resources/app.asar>
// Never opens user data. A nonzero exit means the distribution must not pass this acceptance check.
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const artifact = path.resolve(process.argv[2]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-packaged-memory-'));
const databasePath = path.join(directory, 'memory.db');
async function main() {
 const seed = cp.spawnSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("CREATE TABLE permanent_memories(id INTEGER PRIMARY KEY,category TEXT,content TEXT,scope TEXT,is_active INTEGER,superseded_by INTEGER); INSERT INTO permanent_memories VALUES(1,'rule','r4 packaged sentinel','global',1,NULL); INSERT INTO permanent_memories VALUES(2,'rule','r4 private sentinel','private-model',1,NULL);")
c.commit()`, databasePath], { encoding: 'utf8' });
 assert.equal(seed.status, 0, seed.stderr);
 const worker = new Worker(path.join(artifact, 'src/main/memorySearchWorker.js'), { workerData: { databasePath, request: { query: 'r4', modelId: 'fixture', target: 'permanent' } } });
 const timer = setTimeout(() => worker.terminate(), 10000);
 try {
  const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => reject(Error(`worker exited before response (${code})`))); });
  assert.equal(message.error, undefined, message.error);
  assert.match(message.result, /packaged sentinel/);
  assert.doesNotMatch(message.result, /private sentinel/);
  console.log(JSON.stringify({ artifact, success: true, readonly: true, scopeIsolation: true, result: message.result }));
 } finally { clearTimeout(timer); await worker.terminate(); }
}
main().catch(error => { console.error(JSON.stringify({ artifact, success: false, error: error.message })); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
