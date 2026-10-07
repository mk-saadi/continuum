const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('legacy mermaid fences use the standard copyable code block with line numbers', () => {
  const outfile = path.resolve(__dirname, `../.chat-message-test-${process.pid}.cjs`);
  try {
    esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, '../src/components/ChatMessage.jsx')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      external: ['react', 'react-dom'],
      logLevel: 'silent',
    });
    const ChatMessage = require(outfile).default;
    const html = renderToStaticMarkup(React.createElement(ChatMessage, {
      message: { role: 'assistant', content: '```mermaid\nflowchart LR\nA-->B\n```' },
    }));
    assert.match(html, /<pre[\s>]/);
    assert.match(html, /class="language-mermaid"/);
    assert.match(html, /flowchart LR/);
    assert.match(html, /aria-label="Copy code"/);
    assert.equal((html.match(/react-syntax-highlighter-line-number/g) || []).length, 2);
    assert.doesNotMatch(html, /aria-label="Mermaid diagram"/);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
});
