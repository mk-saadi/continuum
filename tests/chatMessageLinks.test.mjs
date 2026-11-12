// Renders the real ChatMessage component and asserts a relative markdown
// destination comes out as a clickable local link instead of a dead
// target="_blank" anchor (the bug: Electron denies that navigation silently).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'chat-message-links-'));
const outfile = join(directory, 'ChatMessage.mjs');

await esbuild.build({
	entryPoints: [new URL('../src/components/ChatMessage.jsx', import.meta.url).pathname],
	bundle: true,
	outfile,
	format: 'esm',
	platform: 'node',
	jsx: 'automatic',
	external: ['react', 'react/jsx-runtime', 'react-dom'],
	define: { 'process.env.NODE_ENV': '"test"' },
});

const { default: ChatMessage } = await import(pathToFileURL(outfile).href);
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const message = content => ({ id: 'm1', role: 'assistant', content, created_at: '2026-11-11T00:00:00Z' });

const render = content =>
	renderToStaticMarkup(React.createElement(ChatMessage, { message: message(content), interactive: false }));

test.after(() => rmSync(directory, { recursive: true, force: true }));

test('a relative destination renders as a clickable local link', () => {
	const html = render('Two stages, in [thing.mjs](src/lib/thing.mjs):');
	assert.match(html, /<a href="src\/lib\/thing\.mjs"/, 'relative href must survive rendering');
	assert.doesNotMatch(html, /target="_blank"/, 'a relative file link must not be a dead external link');
	assert.match(html, /cursor-pointer/, 'the link must advertise that it is clickable');
});

test('absolute paths still open directly and web URLs still use the popover', () => {
	const absolute = render('See [thing.mjs](/home/user/src/thing.mjs).');
	assert.match(absolute, /<a href="\/home\/user\/src\/thing\.mjs"/);
	assert.doesNotMatch(absolute, /target="_blank"/);

	const web = render('See [docs](https://example.com/docs).');
	assert.match(web, /example\.com/);
});

test('anchors and scheme links are not treated as local files', () => {
	const anchors = render('Jump to [part](#section) and [mail](mailto:a@b.c).');
	assert.match(anchors, /href="#section"/);
	assert.match(anchors, /href="mailto:a@b\.c"/);
});
