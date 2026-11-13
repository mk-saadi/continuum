import test from 'node:test';
import assert from 'node:assert/strict';
import { observeChangeSection } from '../src/lib/observeChangeSections.mjs';

test('large reviews share one observer and release every element on unmount', () => {
  const original = globalThis.IntersectionObserver;
  let created = 0, disconnected = 0, notify;
  const observed = new Set();
  globalThis.IntersectionObserver = class {
    constructor(callback) { created++; notify = callback; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
    disconnect() { disconnected++; observed.clear(); }
  };
  try {
    for (let cycle=0;cycle<5;cycle++) {
      let updates=0;
      const elements = Array.from({length:500}, () => ({}));
      const cleanup = elements.map(element => observeChangeSection(element, () => updates++));
      assert.equal(created,cycle+1);
      assert.equal(observed.size,500);
      notify([{target:elements[0],isIntersecting:true}]);
      assert.equal(updates,1);
      cleanup.forEach(dispose => dispose());
      assert.equal(observed.size,0);
      assert.equal(disconnected,cycle+1);
      notify([{target:elements[0],isIntersecting:true}]);
      assert.equal(updates,1,'disposed callbacks must never receive updates');
    }
  } finally { globalThis.IntersectionObserver = original; }
});
