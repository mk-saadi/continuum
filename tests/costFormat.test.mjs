import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { costChipText, formatSignedUsd, formatUsd } from '../src/lib/costFormat.mjs';

const require = createRequire(import.meta.url);
const pricing = require('../src/lib/cloudPricing.cjs');

// The renderer cannot import the CommonJS pricing module through Vite's dev
// server, so the two presentation helpers are mirrored in costFormat.mjs. This
// test keeps the mirror exact across normal values, tiny amounts, and nulls.
const VALUES = [
  null, undefined, Number.NaN, 0, 0.000001, 0.00002, 0.0001, 0.00099,
  0.001234, 0.0121, 0.1234, 0.5, 1, 1.234, 12.3456, 1234.567, -0.00002, -0.006,
];

test('renderer cost formatting matches the pricing module exactly', () => {
  for (const value of VALUES) {
    assert.equal(formatUsd(value), pricing.formatUsd(value), `formatUsd(${String(value)})`);
    assert.equal(formatSignedUsd(value), pricing.formatSignedUsd(value), `formatSignedUsd(${String(value)})`);
  }
});

 test('saved live costs are labeled as estimates and partial costs stay explicit', () => {
  assert.equal(costChipText({ total: 0.03, completeness: 'estimated', estimated: true }), '$0.03 (estimated)');
  assert.equal(costChipText({ total: 0.03, completeness: 'partial', estimated: true }), '$0.03 (partial)');
  assert.equal(costChipText({ total: 0.03, completeness: 'complete' }), '$0.03');
});
