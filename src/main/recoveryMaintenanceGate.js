'use strict';
// Concurrent recovery workflows share access; maintenance takes exclusive
// access only after every capture → mutation → post-state workflow finishes.
// Reentrancy lets a workflow call individual store operations without waiting
// behind a cleanup that is itself waiting for that workflow.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const pending = [];
let readers = 0;
let writer = false;
function drain() {
  if (writer) return;
  while (pending.length) {
    const next = pending[0];
    if (next.exclusive && readers) return;
    pending.shift();
    if (next.exclusive) writer = true;
    else readers++;
    const scope = { active: true };
    Promise.resolve().then(() => context.run(scope, next.work)).then(next.resolve, next.reject).finally(() => {
      scope.active = false;
      if (next.exclusive) writer = false;
      else readers--;
      drain();
    });
    if (next.exclusive) return;
  }
}
function enqueue(work, exclusive) {
  if (context.getStore()?.active) return work();
  return new Promise((resolve, reject) => {
    pending.push({ work, exclusive, resolve, reject });
    drain();
  });
}
module.exports = { withoutWorkflow: work => context.exit(work), run: work => enqueue(work, false), exclusive: work => enqueue(work, true) };
