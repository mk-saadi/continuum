'use strict';
// Per-file mutation queue: serializes operations on the same file path
// while allowing concurrent operations on different files.
// Based on Pi's withFileMutationQueue implementation.

const queues = new Map();

function canonicalPath(path) {
  try { return require('node:fs').realpathSync(path); } catch { return path; }
}

/**
 * Execute a mutation function with serialized access to the given path.
 * Different paths can run concurrently; same path runs sequentially.
 * @param {string} filePath - The file path to serialize on
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>} Result of fn
 */
async function withFileMutationQueue(filePath, fn) {
  const key = canonicalPath(filePath);
  const queue = queues.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const promise = queue.then(
    () => fn().finally(release),
    err => { release(); throw err; }
  );
  queues.set(key, promise);
  try { return await promise; }
  finally {
    // Clean up resolved queue entries to prevent memory growth
    if (queues.get(key) === promise) queues.delete(key);
  }
}

module.exports = { withFileMutationQueue };
