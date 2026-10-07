const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMemoryContent } = require('../src/main/memoryNormalization');

test('normalizes the requested raw sentence to an atomic preference', () => {
  assert.equal(normalizeMemoryContent('  Remember that I prefer TypeScript over JavaScript for all new files.  '),
    'Prefers TypeScript over JavaScript');
});

test('normalizes favorite facts and stacked conversational prefixes', () => {
  assert.equal(normalizeMemoryContent("user's favorite color is black"), 'Favorite color: black');
  assert.equal(normalizeMemoryContent('Please remember that from now on, my favourite color is black.'), 'Favorite color: black');
});

test('preserves negation, technical names, and project constraints', () => {
  assert.equal(normalizeMemoryContent('Remember that I do not prefer JavaScript.'), 'I do not prefer JavaScript');
  assert.equal(normalizeMemoryContent('User prefers pnpm for project Apollo.'), 'Prefers pnpm for project Apollo');
  assert.equal(normalizeMemoryContent('OS: macOS'), 'OS: macOS');
  assert.equal(normalizeMemoryContent('Prefers Node.js'), 'Prefers Node.js');
  assert.equal(normalizeMemoryContent('Prefers C++'), 'Prefers C++');
});

test('cleanup is idempotent and rejects empty facts', () => {
  for (const value of ['Favorite color: black', 'Prefers TypeScript over JavaScript', 'OS: macOS']) {
    assert.equal(normalizeMemoryContent(normalizeMemoryContent(value)), value);
  }
  for (const value of ['', '  ', 'remember that', 'from now on', null, {}, 'fact\0']) {
    assert.throws(() => normalizeMemoryContent(value), TypeError);
  }
});
