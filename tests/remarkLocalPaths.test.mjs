import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { protectLocalPaths, remarkLocalPaths } from '../src/lib/remarkLocalPaths.mjs';
import { mediaSchema, mediaUrlTransform, rehypeMediaSources } from '../src/lib/markdownMedia.mjs';

// Mirrors the ChatMessage.jsx pipeline so the test fails if the wiring breaks.
function render(markdown) {
	const { text, paths } = protectLocalPaths(markdown);
	return renderToStaticMarkup(
		React.createElement(
			ReactMarkdown,
			{
				remarkPlugins: [remarkGfm, [remarkLocalPaths, { paths }]],
				rehypePlugins: [rehypeRaw, rehypeMediaSources, [rehypeSanitize, mediaSchema]],
				urlTransform: mediaUrlTransform,
			},
			text,
		),
	);
}

const BRACKET_PATH =
	'/home/mk_saadi/collection/dismembered/[Faltain]_Living_Skinsuit___Power_Hungry_Blonde_';

test('bare folder paths become real links', () => {
	const html = render(`Opened ${BRACKET_PATH} and done.`);
	assert.match(html, /<a href="/, 'path should be a link');
	assert.ok(html.includes(BRACKET_PATH), 'path text must survive verbatim');
});

test('brackets and underscores in a path are not consumed as markdown syntax', () => {
	const html = render(`Opened ${BRACKET_PATH} and done.`);
	// The regression: markdown used to eat [Faltain] as a link reference and
	// _Living_Skinsuit___ as emphasis, splitting the path and showing <em>.
	assert.doesNotMatch(html, /<em>/, 'underscores must not become emphasis');
	assert.equal(html.match(/<a /g)?.length, 1, 'exactly one link');
});

test('the link target round-trips to the literal filesystem path', () => {
	const html = render(`Opened ${BRACKET_PATH} and done.`);
	const href = html.match(/<a href="([^"]+)"/)[1];
	// React percent-encodes the attribute; the click handler decodes it again.
	assert.equal(decodeURI(href).replace(/&amp;/g, '&'), BRACKET_PATH);
});

test('image destinations are never rewritten into links', () => {
	const html = render(`![alt](${BRACKET_PATH}/1.jpg)`);
	assert.match(html, /<img src="media:\/\/files\//);
	assert.doesNotMatch(html, /<a /, 'image src must not become a link');
});

test('code spans, fenced code and existing links are left alone', () => {
	const html = render(
		['Inline `code /tmp/not/linked` here.', '', '```', '/tmp/fenced/no', '```', '', '[md](/tmp/already/linked)'].join('\n'),
	);
	assert.match(html, /<code>code \/tmp\/not\/linked<\/code>/);
	assert.match(html, /\/tmp\/fenced\/no/);
	assert.doesNotMatch(html, /<a href="\/tmp\/not\/linked"/);
	assert.match(html, /<a href="\/tmp\/already\/linked">md<\/a>/, 'authored link keeps its own text');
});

test('sentence punctuation and unbalanced closers stay outside the link', () => {
	const html = render('See /tmp/one/file.txt. And (/var/log/syslog) now.');
	assert.match(html, /<a href="\/tmp\/one\/file.txt">\/tmp\/one\/file.txt<\/a>\./);
	assert.match(html, /\(<a href="\/var\/log\/syslog">\/var\/log\/syslog<\/a>\)/);
});

test('non-path slashes are not linkified', () => {
	const html = render('and/or 50/50 //host/share /tmp');
	assert.doesNotMatch(html, /<a /);
});

test('the marker never leaks into rendered output', () => {
	const html = render(`a ${BRACKET_PATH} b`);
	assert.doesNotMatch(html, /[\uE000\uE001]/);
});
