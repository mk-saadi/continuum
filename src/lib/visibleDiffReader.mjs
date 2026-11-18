// A review owns this queue and its bounded concurrency. Closing it settles
// queued requests without starting more Git work; active IPC reads may finish.
export function createVisibleDiffReader(read, limit = 2) {
 let closed = false;
 let active = 0;
 const pending = [];
 function drain() {
  while (!closed && active < limit && pending.length) {
   const job = pending.shift();
   active++;
   Promise.resolve().then(() => read(job.path)).then(job.resolve, error => job.resolve({ error: error.message })).finally(() => { active--; drain(); });
  }
 }
 return {
  read(path) {
   if (closed) return Promise.resolve(null);
   return new Promise(resolve => { pending.push({ path, resolve }); drain(); });
  },
  close() { closed = true; for (const job of pending.splice(0)) job.resolve(null); },
 };
}
