import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { mediaSource, isVideoSource, isLocalVideoSource, mediaUrlTransform, rehypeMediaSources, mediaSchema } from '../src/lib/markdownMedia.mjs';

const render = content => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  rehypePlugins: [rehypeRaw, rehypeMediaSources, [rehypeSanitize, mediaSchema]], urlTransform: mediaUrlTransform,
}, content));

test('local media paths preserve spaces, Unicode, percent signs and URL delimiters', () => {
  assert.equal(mediaSource('/home/me/a #?%.png'), 'media:///home/me/a%20%23%3F%25.png');
  assert.equal(mediaSource('file:///home/me/a%20b.png'), 'media:///home/me/a%20b.png');
  assert.equal(mediaSource('C:\\Users\\me\\clip.mov'), 'media:///C%3A/Users/me/clip.mov');
  assert.equal(mediaSource('file:///C:/Users/me/clip.mov'), 'media:///C%3A/Users/me/clip.mov');
  for (const value of ['file://server/share/a.png', '//server/a.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA']) assert.equal(mediaSource(value), '');
  for (const ext of ['mp4', 'WEBM', 'mov', 'mkv', 'avi', 'TS']) assert.ok(isVideoSource(`media:///tmp/clip.${ext}?token=1#t=2`));
  assert.equal(isVideoSource('https://example.com/photo.png?name=video.mp4'), false);
  for (const ext of ['mp4', 'webm', 'mov', 'mkv', 'avi', 'ts']) assert.ok(isLocalVideoSource(`media:///tmp/clip.${ext}`));
  assert.equal(isLocalVideoSource('https://example.com/clip.mp4'), false);
});

test('markdown and raw HTML retain media sources while active HTML is stripped', () => {
  assert.match(render('![Photo](</tmp/my photo.png>)'), /src="media:\/\/\/tmp\/my%20photo.png"/);
  const html = render('![Photo](file:///home/me/photo.png)\n\n<video src="C:\\Users\\me\\clip.mp4" controls onerror="alert(1)"></video>\n\n<video controls><source src="/tmp/clip.webm" type="video/webm"></video>\n\n<img src="https://example.com/photo.png" onerror="alert(1)"><script>alert(1)</script><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Demo"></iframe><iframe src="javascript:alert(1)"></iframe>');
  assert.match(html, /src="media:\/\/\/home\/me\/photo.png"/);
  assert.match(html, /src="media:\/\/\/C%3A\/Users\/me\/clip.mp4"/);
  assert.match(html, /<source src="media:\/\/\/tmp\/clip.webm"/);
  // Iframes are no longer allowed by the schema: every iframe is stripped from output.
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /onerror|<script|javascript:|alert\(1\)/);
});
