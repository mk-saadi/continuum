'use strict';
// Drain asynchronous chat/indexing/compression work before closing SQLite.
let migrating = false;
let active = 0;
let drained;
async function withDataAccess(action) {
  if (migrating) throw new Error('App data is migrating. Please wait.');
  active++;
  try { return await action(); }
  finally { if (--active === 0) drained?.(); }
}
async function exclusiveMigration(action) {
  if (migrating) throw new Error('An app data migration is already in progress.');
  migrating = true;
  try {
    if (active) await new Promise(resolve => { drained = resolve; });
    return await action();
  } finally { drained = null; migrating = false; }
}
module.exports = { withDataAccess, exclusiveMigration, isMigrating: () => migrating };
