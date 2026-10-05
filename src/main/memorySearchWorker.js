'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { searchMemoryDatabase } = require('./memorySearchCore');

let connection;
try {
  connection = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
  const result = searchMemoryDatabase(connection, { ...workerData.request, deadline: Date.now() + 30000 });
  parentPort.postMessage({ result: result.text });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  connection?.close();
}
