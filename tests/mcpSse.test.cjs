const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { McpManager } = require('../src/main/mcpManager');

test('SSE sends configured headers on GET and POST, discovers tools, executes and reloads', async () => {
  const sessions = new Map(), requests = [];
  const server = http.createServer((req, res) => {
    (async () => {
      if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); res.end(); return; }
      requests.push({ method: req.method, path: req.url, header: req.headers['x-fixture'] });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/mcp') {
        res.writeHead(req.method === 'GET' ? 302 : 405, { Location: '/sse' }); res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        const mcp = new Server({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Remote echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }));
        mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: 'text', text: params.arguments.text }] }));
        sessions.set(transport.sessionId, { transport, mcp });
        res.on('close', () => sessions.delete(transport.sessionId));
        await mcp.connect(transport);
      } else if (req.method === 'POST' && url.pathname === '/messages') {
        const session = sessions.get(url.searchParams.get('sessionId'));
        if (!session) { res.writeHead(404); res.end(); return; }
        await session.transport.handlePostMessage(req, res);
      } else { res.writeHead(404); res.end(); }
    })().catch(error => { res.destroy(error); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sse-'));
  const manager = new McpManager({ configPath: path.join(directory, 'mcp_config.json') });
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const config = { mcpServers: {
      remote: { url, headers: { Authorization: 'Bearer fixture-token', 'X-Fixture': 'custom' }, command: '/must-not-spawn' },
      unauthorized: { url },
    } };
    await manager.saveConfig(config);
    assert.deepEqual(await manager.getConfig(), config);
    assert.equal(manager.getStatus().servers.find(s => s.name === 'remote').status, 'connected');
    assert.equal(manager.getStatus().servers.find(s => s.name === 'unauthorized').status, 'error');
    assert.equal(manager.getTools().length, 1);
    assert.equal(JSON.parse(await manager.callTool('remote', 'echo', { text: 'remote result' })).content[0].text, 'remote result');
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].path, '/mcp');
    assert.ok(requests.some(request => request.method === 'GET' && request.path === '/sse'));
    assert.ok(!requests.some(request => request.method === 'POST' && request.path === '/mcp'));
    assert.ok(requests.some(request => request.method === 'POST'));
    assert.ok(requests.every(request => request.header === 'custom'));
    await manager.saveConfig({ mcpServers: {} });
    assert.deepEqual(manager.getTools(), []);
  } finally {
    await manager.close();
    await Promise.all([...sessions.values()].map(({ mcp }) => mcp.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true });
  }
});

test('remote validation rejects malformed URL/header configs without overwriting disk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sse-validation-'));
  const manager = new McpManager({ configPath: path.join(directory, 'config.json') });
  try {
    await manager.saveConfig({ mcpServers: {} });
    for (const definition of [
      { url: 'not a URL' }, { url: 'file:///tmp/config' }, { url: null },
      { url: 'https://example.com/sse', headers: [] },
      { url: 'https://example.com/sse', headers: { Authorization: 123 } },
      { url: 'https://example.com/sse', headers: { Authorization: 'bad\nheader' } },
      { url: 'https://example.com/sse', transport: 'stdio' },
    ]) {
      await assert.rejects(manager.saveConfig({ mcpServers: { remote: definition } }), TypeError);
      assert.deepEqual(await manager.getConfig(), { mcpServers: {} });
    }
  } finally { await manager.close(); await fs.rm(directory, { recursive: true }); }
});

test('untyped URLs fall back after SSE GET 405; explicit SSE does not POST to that URL', async () => {
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { connectRemoteMcp } = require('../src/main/remoteMcp');
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => require('node:crypto').randomUUID() });
  const mcp = new Server({ name: 'http-fixture', version: '1' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await mcp.connect(transport);
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    if (req.headers.authorization !== 'Bearer test') { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    transport.handleRequest(req, res).catch(error => res.destroy(error));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const definition = { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer test' } };
  let client;
  try {
    await assert.rejects(connectRemoteMcp({ ...definition, transport: 'sse' }), /SSE GET rejected.*405/);
    assert.deepEqual(methods, ['GET']);
    client = await connectRemoteMcp(definition);
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal(methods[1], 'GET');
    assert.ok(methods.slice(2).includes('POST'));
  } finally {
    await client?.close(); await mcp.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('redirect fetch retains headers and POST body, and stops unsafe redirects and loops', async () => {
  const { createRemoteFetch } = require('../src/main/remoteMcp');
  const requests = [];
  const request = createRemoteFetch(async (url, init) => {
    requests.push({ url: url.href, ...init });
    return requests.length === 1 ? new Response(null, { status: 307, headers: { Location: '/messages/' } }) : new Response(null, { status: 202 });
  });
  await request('https://example.com/messages', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'X-Custom': 'exact' }, body: '{"id":1}' });
  assert.equal(requests[1].url, 'https://example.com/messages/');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].headers.Authorization, 'Bearer fixture');
  assert.equal(requests[1].headers['X-Custom'], 'exact');
  assert.equal(requests[1].body, '{"id":1}');
  for (const location of ['https://different.example/sse', 'http://example.com/sse']) {
    let calls = 0;
    const redirect = createRemoteFetch(async () => { calls++; return new Response(null, { status: 302, headers: { Location: location } }); });
    await assert.rejects(redirect('https://example.com/mcp', { headers: { Authorization: 'secret' } }), /changed origin/);
    assert.equal(calls, 1);
  }
  const loop = createRemoteFetch(async () => new Response(null, { status: 302, headers: { Location: '/loop' } }));
  await assert.rejects(loop('https://example.com/loop'), /Too many/);
  await assert.rejects(loop('https://example.com/messages', { method: 'POST', body: '{}' }), /307 or 308/);
});

test('remote connection timeout aborts the stream request', async () => {
  const { connectRemoteMcp } = require('../src/main/remoteMcp');
  let signal;
  await assert.rejects(connectRemoteMcp({ url: 'https://example.com/sse' }, {
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), /timed out/);
  assert.equal(signal.aborted, true);
});
