const assert = require('node:assert/strict');
const esbuild = require('esbuild');
(async () => {
  const result = await esbuild.build({
    stdin: { contents: `import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { MessageContextStatus } from './src/components/ChatMessage.jsx';
      export const render = message => renderToStaticMarkup(<MessageContextStatus message={message} />);`,
      resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
  });
  const compiled = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(compiled, compiled.exports, require);
  const { render } = compiled.exports;
  for (const flags of [{ is_summarized: 1 }, { is_summarized: true }, { archived: 1 }]) {
    const html = render({ ...flags, created_at: '2026-09-28 12:00:00' });
    assert.match(html, /<time/);
    assert.doesNotMatch(html, /Summarized|AI can no longer see/);
  }
  assert.doesNotMatch(render({ is_summarized: 0, archived: 0 }), /Summarized/);
  console.log('Legacy archive flags leave original timestamps and ordinary history visible.');
})().catch(error => { console.error(error); process.exitCode = 1; });
