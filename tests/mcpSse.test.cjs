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
      requests.push({ method: req.method, header: req.headers['x-fixture'] });
      const url = new URL(req.url, 'http://localhost');
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
    const url = `http://127.0.0.1:${server.address().port}/sse`;
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
    assert.ok(requests.some(request => request.method === 'GET'));
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
