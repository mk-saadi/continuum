'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function searchMemoryInWorker(request, signal) {
  const { getDatabasePath } = require('./db');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'memorySearchWorker.js'), {
      workerData: { databasePath: getDatabasePath(), request },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { worker.terminate(); finish(signal.reason instanceof Error ? signal.reason : new Error('Memory search cancelled.')); };
    const timer = setTimeout(() => {
      worker.terminate();
      finish(null, 'Search incomplete: the 30-second limit was reached. No result was returned in this pass. Try a narrower project, chat, or date filter, or order: "oldest".');
    }, 30500);
    worker.once('message', message => {
      worker.terminate();
      if (message.error) finish(new Error(message.error)); else finish(null, message.result);
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (code !== 0) finish(new Error('Memory search worker stopped unexpectedly.')); });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

module.exports = { searchMemoryInWorker };
