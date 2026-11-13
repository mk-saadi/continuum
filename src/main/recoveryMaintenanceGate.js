'use strict';
// Concurrent recovery workflows share access; maintenance takes exclusive
// access only after every capture → mutation → post-state workflow finishes.
// Reentrancy lets a workflow call individual store operations without waiting
// behind a cleanup that is itself waiting for that workflow.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const pending = [];
let readers = 0;
let backgroundReaders = 0;
let writer = false;
function drain() {
  if (writer) return;
  while (pending.length) {
    let index = 0;
    if (pending[0].exclusive && readers) {
      // A long command keeps its recovery checkpoint protected. Maintenance
      // must wait, but must not queue every independent tool behind that job.
      if (!backgroundReaders) return;
      index = pending.findIndex(next => !next.exclusive);
      if (index < 0) return;
    }
    const [next] = pending.splice(index, 1);
    if (next.exclusive) writer = true;
    else readers++;
    if (next.background) backgroundReaders++;
    const scope = { active: true };
    Promise.resolve().then(() => context.run(scope, next.work)).then(next.resolve, next.reject).finally(() => {
      scope.active = false;
      if (next.exclusive) writer = false;
      else readers--;
      if (next.background) backgroundReaders--;
      drain();
    });
    if (next.exclusive) return;
  }
}
function enqueue(work, exclusive, background = false) {
  if (context.getStore()?.active) return work();
  return new Promise((resolve, reject) => {
    pending.push({ work, exclusive, background, resolve, reject });
    drain();
  });
}
module.exports = { withoutWorkflow: work => context.exit(work), background: work => context.exit(() => enqueue(work, false, true)), run: work => enqueue(work, false), exclusive: work => enqueue(work, true) };
