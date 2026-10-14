// LaTeX arrow normalization: raw "$\rightarrow$" must never reach markdown.
// Run with: node --test tests/latexArrows.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');

async function main() {
  const { normalizeLatexArrows } = await import('../src/lib/latexArrows.mjs');

  await test('common arrow commands become unicode', () => {
    assert.equal(normalizeLatexArrows('Command $\\rightarrow$ Execution'), 'Command → Execution');
    assert.equal(normalizeLatexArrows('No Command $\\to$ No Relief'), 'No Command → No Relief');
    assert.equal(normalizeLatexArrows('A \\Rightarrow B'), 'A ⇒ B');
    assert.equal(normalizeLatexArrows('$\\leftarrow$'), '←');
    assert.equal(normalizeLatexArrows('$$\\rightarrow$$ done'), '→ done');
  });

  await test('code blocks and inline code are untouched', () => {
    assert.equal(
      normalizeLatexArrows('```\n$\\rightarrow$\n```'),
      '```\n$\\rightarrow$\n```',
    );
    assert.equal(
      normalizeLatexArrows('inline `$\\rightarrow$` keep'),
      'inline `$\\rightarrow$` keep',
    );
  });

  await test('normal dollar text is untouched', () => {
    assert.equal(normalizeLatexArrows('price $5 and $10 stays'), 'price $5 and $10 stays');
    assert.equal(normalizeLatexArrows(null), null);
    assert.equal(normalizeLatexArrows('plain text'), 'plain text');
  });

  console.log('LaTeX arrows: normalization, code protection, and dollar safety passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
