'use strict';
const { limitFilesystemResult } = require('./filesystemToolLimits');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && !value.includes('\0');
function validateServerConfig(name, server) {
  if (!text(name) || !name.trim() || !object(server)) throw new TypeError('Invalid MCP server definition.');
  const hasUrl = server.url !== undefined;
  const hasCommand = server.command !== undefined;
  if (!hasUrl && !hasCommand) {
    throw new TypeError(`Invalid configuration for ${name}: missing command or url`);
  }

  // Match transport selection: a URL selects SSE and requires no command/args.
  if (hasUrl) {
    let url;
    try {
      if (!text(server.url) || !server.url.trim()) throw new Error();
      url = new URL(server.url);
    } catch { throw new TypeError(`Invalid URL for ${name}.`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError(`URL for ${name} must use HTTP or HTTPS.`);
    if (server.headers !== undefined) {
      if (!object(server.headers) || !Object.entries(server.headers).every(([key, value]) => text(key) && text(value))) throw new TypeError(`Headers for ${name} must be a JSON object of strings.`);
      try { new Headers(server.headers); } catch { throw new TypeError(`Invalid HTTP headers for ${name}.`); }
    }
  } else {
    if (!text(server.command) || !server.command.trim()) throw new TypeError(`Invalid command for ${name}.`);
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(text))) throw new TypeError(`Invalid arguments for ${name}.`);
    if (server.cwd !== undefined && !text(server.cwd)) throw new TypeError(`Invalid working directory for ${name}.`);
    if (server.env !== undefined && (!object(server.env) || !Object.entries(server.env).every(([key, value]) => text(key) && text(value)))) throw new TypeError(`Invalid environment for ${name}.`);
  }
  for (const flag of ['enabled', 'disabled']) if (server[flag] !== undefined && typeof server[flag] !== 'boolean') throw new TypeError(`Invalid ${flag} flag for ${name}.`);
  if (server.disabledTools !== undefined && (!Array.isArray(server.disabledTools) || !server.disabledTools.every(text))) throw new TypeError(`Invalid disabled tools for ${name}.`);
  if (server.transport !== undefined && server.transport !== (server.url !== undefined ? 'sse' : 'stdio')) throw new TypeError(`Transport for ${name} must match its URL (sse) or command (stdio).`);
}

// MCP clients use local stdio or remote HTTP/SSE transports.
class McpManager extends EventEmitter {
  constructor({ configPath = path.join(os.homedir(), '.config', 'LLM Desktop Assistant', 'mcp_config.json'), createConnection } = {}) {
    super();
    this.configPath = configPath;
    this.servers = new Map();
    this.createConnection = createConnection;
  }
  init() {
    return this.initializing ??= this.load();
  }
  async getConfig() {
    try {
      const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
          !config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
        throw new Error('mcp_config.json must contain an mcpServers object.');
      }
      return config;
    } catch (error) {
      if (error.code === 'ENOENT') return { mcpServers: {} };
      throw error;
    }
  }
  queueChange(action) {
    if (this.closing) return Promise.reject(new Error('MCP manager is shutting down.'));
    const operation = (this.saving || Promise.resolve()).then(action);
    this.saving = operation.catch(() => {});
    return operation;
  }
  async writeConfig(config) {
    if (!object(config) || !object(config.mcpServers)) throw new TypeError('Config must contain an mcpServers object.');
    for (const [name, server] of Object.entries(config.mcpServers)) validateServerConfig(name, server);
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.configPath);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async saveConfig(config) {
    // Snapshot before queuing; every config mutation uses the same write queue.
    const saved = JSON.parse(JSON.stringify(config));
    return this.queueChange(async () => {
      await this.writeConfig(saved);
      await this.initializing;
      await this.disconnect();
      this.initializing = undefined;
      await this.init();
      return saved;
    });
  }
  async load() {
    this.configError = undefined;
    let config;
    try { config = await this.getConfig(); }
    catch (error) {
      this.configError = error.message;
      this.emit('changed');
      return;
    }
    await Promise.all(Object.entries(config.mcpServers).map(([name, definition]) => this.connectServer(name, definition)));
    this.emit('changed');
  }
  async connectServer(name, definition, cachedTools = []) {
    const server = { name, enabled: definition?.disabled !== true && definition?.enabled !== false, status: 'connecting', tools: cachedTools, disabledTools: new Set(Array.isArray(definition?.disabledTools) ? definition.disabledTools : []) };
    this.servers.set(name, server);
    try {
      validateServerConfig(name, definition);
      if (!server.enabled) { server.status = 'disabled'; return; }
      if (this.createConnection) server.client = await this.createConnection(definition);
      else {
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
        const client = new Client({ name: 'llm-desktop-assistant', version: '1.0.0' });
        server.client = client;
        const transport = definition.url !== undefined
          ? new SSEClientTransport(new URL(definition.url), {
            // SDK applies these to both the SSE GET and JSON-RPC POST requests.
            requestInit: { headers: definition.headers || {} },
          })
          : new StdioClientTransport({ command: definition.command, args: definition.args || [], cwd: definition.cwd, env: { ...process.env, ...definition.env }, stderr: 'inherit' });
        let timer;
        try {
          // Include transport startup (waiting for the SSE endpoint event) in the timeout.
          await Promise.race([
            client.connect(transport, { timeout: 15000 }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP connection timed out.')), 15000); }),
          ]);
        } finally { clearTimeout(timer); }
      }
      const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
      server.client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.refreshTools(server).catch(error => {
        server.tools = []; server.error = error.message; this.emit('changed');
      }));
      server.client.onclose = () => {
        if (server.enabled) { server.status = 'disconnected'; server.tools = []; }
        this.emit('changed');
      };
      await this.refreshTools(server);
      server.status = 'connected';
    } catch (error) {
      await server.client?.close().catch(() => {});
      server.status = 'error'; server.error = error.message; server.tools = [];
    }
    this.emit('changed');
  }
  async refreshTools(server) {
    const tools = [], cursors = new Set();
    let cursor;
    do {
      const page = await server.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated tools pagination cursor.');
      cursors.add(cursor);
    } while (cursor);
    server.tools = tools;
    server.error = undefined;
    this.emit('changed');
  }
  toolName(serverName, toolName) {
    return `mcp_${toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}_${createHash('sha256').update(JSON.stringify([serverName, toolName])).digest('hex').slice(0, 32)}`;
  }
  getTools() {
    return [...this.servers.values()].filter(s => s.enabled && s.status === 'connected').flatMap(s =>
      s.tools.filter(t => !s.disabledTools.has(t.name)).map(t => ({ type: 'function', function: {
        name: this.toolName(s.name, t.name), description: t.description || `${s.name}: ${t.name}`, parameters: t.inputSchema || { type: 'object', properties: {} },
      } })));
  }
  resolveTool(name) {
    for (const server of this.servers.values()) {
      if (!server.enabled || server.status !== 'connected') continue;
      const tool = server.tools.find(t => !server.disabledTools.has(t.name) && this.toolName(server.name, t.name) === name);
      if (tool) return { serverName: server.name, toolName: tool.name };
    }
    throw new Error('MCP tool is unavailable or disabled.');
  }
  async callTool(serverName, toolName, args, { signal } = {}) {
    const server = this.servers.get(serverName);
    if (!server?.enabled || server.status !== 'connected' || server.disabledTools.has(toolName) || !server.tools.some(t => t.name === toolName)) throw new Error('MCP tool is unavailable or disabled.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
    const result = await server.client.callTool({ name: toolName, arguments: args }, undefined, { signal, timeout: 60000 });
    return JSON.stringify(limitFilesystemResult(toolName, result));
  }
  setServerEnabled(serverName, enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('enabled must be a boolean.'));
    return this.queueChange(async () => {
      await this.init();
      const config = await this.getConfig();
      if (!Object.hasOwn(config.mcpServers, serverName)) throw new Error('Unknown MCP server.');
      const definition = config.mcpServers[serverName];
      definition.disabled = !enabled;
      delete definition.enabled; // Normalize the legacy alias so it cannot override the switch.
      await this.writeConfig(config);
      const server = this.servers.get(serverName);
      if (server) {
        server.enabled = false;
        server.status = 'disabled';
        server.error = undefined;
        this.emit('changed'); // Remove declarations before waiting for process shutdown.
        await server.client?.close();
      }
      if (enabled || !server) await this.connectServer(serverName, definition, server?.tools || []);
      this.emit('changed');
      return config;
    });
  }
  setToolEnabled(name, enabled, serverName) {
    if (!text(name) || !name) return Promise.reject(new TypeError('Tool name is required.'));
    return this.changeToolPermissions(serverName, enabled, name);
  }
  setAllToolsEnabled(serverName, enabled) {
    return this.changeToolPermissions(serverName, enabled);
  }
  changeToolPermissions(serverName, enabled, name) {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('enabled must be a boolean.'));
    return this.queueChange(async () => {
      await this.init();
      const config = await this.getConfig();
      const server = serverName !== undefined ? this.servers.get(serverName) :
        [...this.servers.values()].find(s => s.tools.some(t => this.toolName(s.name, t.name) === name));
      if (!server || !Object.hasOwn(config.mcpServers, server.name)) throw new Error('Unknown MCP server or tool.');
      const tool = name === undefined ? null : server.tools.find(t =>
        (serverName !== undefined && t.name === name) || this.toolName(server.name, t.name) === name);
      if (name !== undefined && !tool) throw new Error('Unknown MCP tool.');
      const definition = config.mcpServers[server.name];
      const disabled = new Set(definition.disabledTools || []);
      if (name === undefined && enabled) disabled.clear();
      else for (const t of tool ? [tool] : server.tools) {
        if (enabled) disabled.delete(t.name); else disabled.add(t.name);
      }
      definition.disabledTools = [...disabled];
      await this.writeConfig(config);
      // Permissions alter declarations and dispatch immediately; connections stay open.
      server.disabledTools = disabled;
      this.emit('changed');
      return config;
    });
  }
  getStatus() {
    return { configPath: this.configPath, error: this.configError, servers: [...this.servers.values()].map(s => ({
      name: s.name, enabled: s.enabled, status: s.status, error: s.error, tools: s.tools.map(t => ({ name: this.toolName(s.name, t.name), label: t.name, enabled: s.enabled && !s.disabledTools.has(t.name) })),
    })) };
  }
  async disconnect() {
    await Promise.allSettled([...this.servers.values()].map(s => s.client?.close()));
    this.servers.clear();
    this.emit('changed');
  }
  async close() {
    this.closing = true;
    await this.saving;
    await this.initializing;
    await this.disconnect();
  }
}
module.exports = new McpManager();
module.exports.McpManager = McpManager;
