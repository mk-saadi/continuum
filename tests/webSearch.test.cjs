const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeWebPageContent, sanitizeWebToolResult, getSingleWebPageContent } = require('../src/main/tools/webSearch');
const { truncateToolOutput, TOOL_OUTPUT_NOTICE } = require('../src/main/engineManager');
const { extractWebPageData } = require('../src/main/subAgentRunner');

test('scraped article text omits boilerplate, inline images and excess content', () => {
  const html = `<html><head><style>bad style</style><script>bad script</script></head><body>
    <header>bad header</header><nav>bad nav</nav><article><h1>Useful title</h1><p>Answer &amp; detail</p>
    <svg>bad svg</svg><img src="data:image/png;base64,${'A'.repeat(1000)}"><p>${'x'.repeat(15000)}</p></article>
    <footer>bad footer</footer><noscript>bad noscript</noscript></body></html>`;
  const text = sanitizeWebPageContent(html);
  assert.ok(text.startsWith('Useful title\nAnswer & detail'));
  for (const omitted of ['bad style', 'bad script', 'bad nav', 'bad footer', 'bad svg', 'data:image']) assert.ok(!text.includes(omitted));
  assert.ok(text.length <= 12000);
  assert.equal(sanitizeWebToolResult({ content: [{ type: 'text', text: html }] }, 'get-single-web-page-content'), text);
  assert.equal(sanitizeWebToolResult(html, 'unrelated_tool'), html);
});

test('web fetch caps downloads, rejects private URLs and returns bounded text', async () => {
  const content = await getSingleWebPageContent({ url: 'https://example.com/page',
    fetchImpl: async () => new Response(`<main>${'word '.repeat(4000)}</main>`, { headers: { 'content-type': 'text/html' } }) });
  assert.ok(content.length <= 12000);
  await assert.rejects(getSingleWebPageContent({ url: 'http://127.0.0.1/private', fetchImpl: () => assert.fail('Must not fetch') }), /public/);
  await assert.rejects(getSingleWebPageContent({ url: 'https://example.com/large',
    fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }) }), /download limit/);
});

test('web fetch sends browser headers and validates each redirect', async () => {
  const requests = [];
  const content = await getSingleWebPageContent({ url: 'https://example.com/start',
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: '/article' } })
        : new Response('<main>Article</main>', { headers: { 'content-type': 'text/html' } });
    } });
  assert.equal(content, 'Article');
  assert.deepEqual(requests.map(request => request.url), ['https://example.com/start', 'https://example.com/article']);
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.match(options.headers['User-Agent'], /Chrome\/128/);
    assert.match(options.headers.Accept, /text\/html/);
    assert.equal(options.headers['Accept-Language'], 'en-US,en;q=0.5');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
  }
  await assert.rejects(getSingleWebPageContent({ url: 'https://example.com/start',
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), /public/);
});

test('web fetch reports the exception and target URL', async () => {
  await assert.rejects(getSingleWebPageContent({ url: 'https://example.com/failure',
    fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); } }),
  /SUBAGENT_FETCH_ERROR: TypeError - fetch failed \(ECONNRESET\) \(Target: https:\/\/example.com\/failure\)/);
});

test('tool output guard preserves exact limit and a truncation notice', () => {
  const original = { result: 'x'.repeat(30000) };
  const guarded = truncateToolOutput(original);
  assert.equal(typeof guarded, 'string');
  assert.ok(guarded.endsWith(TOOL_OUTPUT_NOTICE));
  assert.ok(JSON.stringify(guarded).length <= 20000);
  assert.deepEqual(truncateToolOutput({ result: 'short' }), { result: 'short' });
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(30000)}` } };
  const parts = truncateToolOutput([{ type: 'text', text: 'x'.repeat(30000) }, image]);
  assert.equal(parts[1], image);
  assert.ok(parts[0].text.endsWith(TOOL_OUTPUT_NOTICE));
  assert.ok(parts[0].text.length < 20000);
});

test('oversized tool text is guarded before the next model request', async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const requests = [];
  await runMemoryChat({ baseUrl: 'http://local', modelId: 'model', messages: [{ role: 'system', content: 'Be concise.' }],
    chatTools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
    executeTool: async () => 'x'.repeat(40000), guardToolContent: truncateToolOutput,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      return Response.json({ choices: [{ message: requests.length === 1
        ? { role: 'assistant', tool_calls: [{ id: 'web1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }
        : { role: 'assistant', content: 'Done. [TASK COMPLETE]' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] });
    },
  });
  const tool = requests[1].messages.find(message => message.role === 'tool');
  assert.ok(tool.content.endsWith(TOOL_OUTPUT_NOTICE));
  assert.ok(JSON.stringify(tool.content).length <= 20000);
});

test('web extractor sends only matching page text to an isolated tool-free request', async () => {
  let payload;
  const summary = await extractWebPageData({ url: 'https://example.com/story', query: 'What is the launch date?',
    engine: { port: 4321, modelId: 'local-model' },
    pageFetchImpl: async () => new Response('<article><p>Navigation filler</p><p>The launch date is 1 October.</p></article>',
      { headers: { 'content-type': 'text/html' } }),
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'The launch date is 1 October.' } }] }); },
  });
  assert.equal(summary, 'The launch date is 1 October.');
  assert.equal(payload.messages.length, 2);
  assert.match(payload.messages[1].content, /The launch date is 1 October/);
  assert.ok(!payload.messages[1].content.includes('Navigation filler'));
  assert.deepEqual(payload.tools, []);
  assert.equal(payload.max_tokens, 450);
});
