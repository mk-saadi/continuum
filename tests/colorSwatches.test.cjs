// Inline color swatches: CSS literals in prose split into swatch segments,
// out-of-range values and non-color text stay plain.
// Run with: node --test tests/colorSwatches.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');

async function main() {
  const { isValidColor, splitTextWithColors } = await import('../src/lib/colorSwatches.mjs');

  await test('hex lengths validate', () => {
    for (const good of ['#fff', '#FFFF', '#A8D8EA', '#a8d8eaff', '#000', '#1234']) {
      assert.equal(isValidColor(good), true, good);
    }
    for (const bad of ['#ff', '#12345', '#1234567', '#xyz', 'fff', '', null, 42]) {
      assert.equal(isValidColor(bad), false, String(bad));
    }
  });

  await test('rgb/rgba ranges validate', () => {
    assert.equal(isValidColor('rgb(255, 0, 0)'), true);
    assert.equal(isValidColor('rgba(0, 128, 0, 0.5)'), true);
    assert.equal(isValidColor('rgb(100%, 0%, 0%)'), true);
    assert.equal(isValidColor('rgb(255 0 0 / 50%)'), true);
    assert.equal(isValidColor('rgba(255 0 0)'), true);
    assert.equal(isValidColor('RGB(10, 20, 30)'), true);
    assert.equal(isValidColor('rgb(999, 0, 0)'), false);
    assert.equal(isValidColor('rgb(0, 0, 0, 2)'), false);
    assert.equal(isValidColor('rgb(0, 0)'), false);
    assert.equal(isValidColor('rgb(0, 0, 0'), false);
  });

  await test('hsl/hsla ranges validate', () => {
    assert.equal(isValidColor('hsl(210, 50%, 40%)'), true);
    assert.equal(isValidColor('hsla(0, 100%, 50%, 0.3)'), true);
    assert.equal(isValidColor('hsl(210 50% 40% / 80%)'), true);
    assert.equal(isValidColor('hsl(0, 0%, 0%)'), true);
    assert.equal(isValidColor('hsl(210, 50, 40)'), false);
    assert.equal(isValidColor('hsl(210, 150%, 40%)'), false);
  });

  await test('prose splits into text and color segments', () => {
    assert.deepEqual(splitTextWithColors('Use #A8D8EA for calm and rgb(255, 0, 0) now'), [
      { text: 'Use ' },
      { color: '#A8D8EA' },
      { text: ' for calm and ' },
      { color: 'rgb(255, 0, 0)' },
      { text: ' now' },
    ]);
    assert.deepEqual(splitTextWithColors('no colors here'), [{ text: 'no colors here' }]);
    assert.deepEqual(splitTextWithColors(''), []);
    assert.deepEqual(splitTextWithColors(null), []);
  });

  await test('non-colors stay plain text', () => {    assert.deepEqual(splitTextWithColors('C# is a language'), [{ text: 'C# is a language' }]);
    assert.deepEqual(splitTextWithColors('issue #1234567 filed'), [{ text: 'issue #1234567 filed' }]);
    assert.deepEqual(splitTextWithColors('rgb(999, 0, 0) is invalid'), [{ text: 'rgb(999, 0, 0) is invalid' }]);
    const mixed = splitTextWithColors('#fff ok but rgb(999, 0, 0) skipped');
    assert.deepEqual(mixed, [{ color: '#fff' }, { text: ' ok but rgb(999, 0, 0) skipped' }]);
  });

  await test('swatch style is font-sized (1em) in the app stylesheet', () => {
    const fs = require('node:fs');
    const cssPath = require('node:path').join(__dirname, '..', 'src', 'index.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    const rule = /\.inline-color-swatch\s*\{[^}]*\}/.exec(css);
    assert.ok(rule, 'missing .inline-color-swatch rule');
    assert.match(rule[0], /display:\s*inline-block/);
    assert.match(rule[0], /width:\s*1em/);
    assert.match(rule[0], /height:\s*1em/);
  });

  console.log('Color swatches: validation and text splitting passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
