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

test('JSON API responses are readable, pretty-printed and keep their content type', async () => {
  const payload = { latitude: 23.81, longitude: 90.41, current: { temperature_2m: 29.4, relative_humidity_2m: 74 } };
  const content = await getSingleWebPageContent({ url: 'https://api.example.test/v1/forecast',
    fetchImpl: async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }) });
  assert.match(content, /^\[Content-Type: application\/json\]/); // metadata keeps the original type
  assert.match(content, /"temperature_2m": 29\.4/); // value is accessible to the model
  assert.ok(content.includes('\n  "current": {'), 'valid JSON is pretty-printed with structure preserved');
  // Vendor-specific structured-syntax suffix types are accepted too.
  const problem = await getSingleWebPageContent({ url: 'https://api.example.test/v1/throttle',
    fetchImpl: async () => new Response('{"title":"Too Many Requests","status":429}',
      { headers: { 'content-type': 'application/problem+json; charset=utf-8' } }) });
  assert.match(problem, /\[Content-Type: application\/problem\+json; charset=utf-8\]/);
  assert.match(problem, /"status": 429/);
});

test('HTML and plain-text responses still read as before', async () => {
  const html = await getSingleWebPageContent({ url: 'https://example.com/article',
    fetchImpl: async () => new Response('<article><p>Useful article text</p></article>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  assert.equal(html, 'Useful article text');
  const plain = await getSingleWebPageContent({ url: 'https://example.com/notes.txt',
    fetchImpl: async () => new Response('Just plain text', { headers: { 'content-type': 'text/plain; charset=utf-8' } }) });
  assert.equal(plain, 'Just plain text');
});

test('invalid JSON and misleading content-type declarations degrade recoverably', async () => {
  // Declared JSON but the body is malformed: raw text plus a diagnostic note,
  // never a throw and never a crash.
  const broken = await getSingleWebPageContent({ url: 'https://api.example.test/broken',
    fetchImpl: async () => new Response('{"temperature": 21.4,', { headers: { 'content-type': 'application/json' } }) });
  assert.match(broken, /body was not valid JSON; raw response text follows/);
  assert.match(broken, /\[Content-Type: application\/json\]/);
  assert.ok(broken.includes('{"temperature": 21.4,'), 'the raw body stays readable');
  // Declared text/html but the body is real JSON: treated as JSON, so no HTML
  // extraction runs over it (entities and tags are preserved verbatim).
  const mislabeled = await getSingleWebPageContent({ url: 'https://api.example.test/mislabeled',
    fetchImpl: async () => new Response('{"note":"&amp; <keep>"}', { headers: { 'content-type': 'text/html' } }) });
  assert.match(mislabeled, /"note": "&amp; <keep>"/);
});

test('JSON responses honor the download and output size limits', async () => {
  await assert.rejects(getSingleWebPageContent({ url: 'https://api.example.test/huge',
    fetchImpl: async () => new Response(JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 1) }),
      { headers: { 'content-type': 'application/json' } }) }), /download limit/);
  const big = await getSingleWebPageContent({ url: 'https://api.example.test/many',
    fetchImpl: async () => new Response(JSON.stringify(Array.from({ length: 2000 }, (_, index) => ({ index, note: 'item' }))),
      { headers: { 'content-type': 'application/json' } }) });
  assert.ok(big.length <= 12000, `capped at MAX_PAGE_CHARS, got ${big.length}`);
});

test('JSON support does not change HTTP error, redirect or cancellation semantics', async () => {
  // A JSON error body under a non-2xx status stays an error.
  await assert.rejects(getSingleWebPageContent({ url: 'https://api.example.test/missing',
    fetchImpl: async () => new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }) }),
  /Web page request failed \(HTTP 404\)/);
  // Redirects are still followed and validated per hop, then JSON is read.
  const hops = [];
  const redirected = await getSingleWebPageContent({ url: 'https://api.example.test/start',
    fetchImpl: async url => {
      hops.push(url.href);
      return hops.length === 1
        ? new Response(null, { status: 302, headers: { location: '/api' } })
        : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(hops, ['https://api.example.test/start', 'https://api.example.test/api']);
  assert.match(redirected, /"ok": true/);
  // Unsupported content types are still rejected by cancelling the body.
  let cancelled = false;
  const pdf = new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
  const body = pdf.body;
  const cancel = body.cancel.bind(body);
  body.cancel = (...args) => { cancelled = true; return cancel(...args); };
  await assert.rejects(getSingleWebPageContent({ url: 'https://api.example.test/file.pdf', fetchImpl: async () => pdf }),
    /did not return HTML, plain text or JSON \(content-type: application\/pdf\)/);
  assert.equal(cancelled, true, 'unsupported responses still cancel their body');
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

test('web extractor answers a question from a JSON API response', async () => {
  let payload;
  const summary = await extractWebPageData({ url: 'https://api.example.test/v1/forecast',
    query: 'What is the current temperature?',
    engine: { port: 4321, modelId: 'local-model' },
    pageFetchImpl: async () => new Response(JSON.stringify({ latitude: 23.81, current: { temperature_2m: 29.4 } }),
      { headers: { 'content-type': 'application/json' } }),
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'The current temperature is 29.4 degrees.' } }] }); },
  });
  assert.equal(summary, 'The current temperature is 29.4 degrees.');
  // The JSON body, not a rejection, is what reaches the extractor prompt.
  assert.match(payload.messages[1].content, /temperature_2m/);
  assert.ok(!/did not return|fetch failed/.test(payload.messages[1].content));
});
