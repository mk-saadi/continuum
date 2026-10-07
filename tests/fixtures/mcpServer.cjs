const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => ({
  tools: [{ name: params?.cursor ? 'fail' : 'echo', description: 'Test tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  ...(params?.cursor ? {} : { nextCursor: 'page2' }),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: 'text', text: params.arguments.text || 'failure' }], ...(params.name === 'fail' ? { isError: true } : {}),
}));
server.connect(new StdioServerTransport());
