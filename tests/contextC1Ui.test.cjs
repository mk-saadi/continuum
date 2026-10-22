'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createRuntimeBudget } = require('../src/main/contextBudget');
test('late A cannot overwrite B, old session/model results and unload generations are rejected', async () => {
  const { acceptsContextMeasurement } = await import('../src/lib/contextMeasurement.mjs');
  let generation = 0, displayed;
  const start = () => { const seq = ++generation; return result => {
    if (acceptsContextMeasurement(seq, generation, result, 's', 'm')) displayed = result;
  }; };
  const a = start(), b = start();
  b({ sessionId: 's', modelId: 'm', budget: 15232 });
  a({ sessionId: 's', modelId: 'm', budget: 33920 });
  assert.equal(displayed.budget, 15232);
  assert.equal(acceptsContextMeasurement(2, 2, { sessionId: 'old', modelId: 'm' }, 's', 'm'), false);
  assert.equal(acceptsContextMeasurement(2, 2, { sessionId: 's', modelId: 'old' }, 's', 'm'), false);
  generation++;
  b({ sessionId: 's', modelId: 'm', budget: 99999 });
  assert.equal(displayed.budget, 15232);
});
test('real Context panel render uses incident usable denominator and honest diagnostics', async () => {
  const output = await require('esbuild').build({ entryPoints: ['src/components/ContextPanel.jsx'], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react'] });
  const Module = require('node:module');
  const compiled = new Module(path.join(process.cwd(), 'tests/c1-render.cjs'), module);
  compiled.filename = path.join(process.cwd(), 'tests/c1-render.cjs');
  compiled.paths = module.paths;
  compiled._compile(output.outputFiles[0].text, compiled.filename);
  const previous = global.window;
  global.window = { memoryPalace: {} };
  try {
    const budgetContract = createRuntimeBudget({ configuredContextTokens: 70000, runtimeContextTokens: 35072,
      currentInputTokens: 29100, payload: { max_tokens: 1024 } });
    const text = renderToStaticMarkup(React.createElement(compiled.exports.default, { sessionId: 's', modelId: 'm',
      measurement: { sessionId: 's', modelId: 'm', tokens: 29100, budgetContract,
        method: 'approximate-full-request', confidence: 'estimated', imageCount: 1, imageAllowanceTokens: 4096 } }));
    assert.match(text, /29,100.*33,920/);
    assert.match(text, /30,528/);
    assert.match(text, /35,072/);
    assert.match(text, /4,096 estimated/);
    assert.match(text, /estimated/);
    const stale = renderToStaticMarkup(React.createElement(compiled.exports.default, { sessionId: 'other', modelId: 'm',
      measurement: { sessionId: 's', modelId: 'm', tokens: 29100, budgetContract } }));
    assert.match(stale, /budget pending/);
    assert.doesNotMatch(stale, /33,920/);
  } finally { global.window = previous; }
});
