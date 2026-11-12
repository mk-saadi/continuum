import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { protectLocalPaths, remarkLocalPaths } from '/home/mk_saadi/projects/persona-projects/llm-electron/src/lib/remarkLocalPaths.mjs';
import { mediaSchema, mediaUrlTransform, rehypeMediaSources } from '/home/mk_saadi/projects/persona-projects/llm-electron/src/lib/markdownMedia.mjs';

function render(markdown) {
  const { text, paths } = protectLocalPaths(markdown);
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, [remarkLocalPaths, { paths }]],
      rehypePlugins: [rehypeRaw, rehypeMediaSources, [rehypeSanitize, mediaSchema]],
      urlTransform: mediaUrlTransform,
    }, text),
  );
}

const cases = [
  'Two stages, in [remarkLocalPaths.mjs](src/lib/remarkLocalPaths.mjs):',
  'Two stages, in [remarkLocalPaths.mjs](./src/lib/remarkLocalPaths.mjs):',
  'Two stages, in remarkLocalPaths.mjs:',
  'Two stages, in /home/mk_saadi/projects/persona-projects/llm-electron/src/lib/remarkLocalPaths.mjs:',
];
for (const c of cases) {
  console.log('IN :', c);
  console.log('OUT:', render(c));
  console.log('---');
}
