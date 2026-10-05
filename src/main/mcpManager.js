'use strict';
const { connectRemoteMcp } = require('./remoteMcp');
const { limitFilesystemResult } = require('./filesystemToolLimits');
const { requiresConfirmation, approvedMutations } = require('./safetyGuards');
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && !value.includes('\0');
function withFilesystemDirectories(name, definition, getGlobalConfig) {
  // Remote servers cannot use this machine's local directory arguments.
  if (definition.url !== undefined) return definition;
  const filesystemPackage = /^@modelcontextprotocol\/server-filesystem(?:@[^\s]+)?$/;
  if (name !== 'filesystem' && ![definition.command, ...(definition.args || [])].some(arg => filesystemPackage.test(arg))) {
    return definition;
  }
  const { appDataDirectory, modelDirectory } = getGlobalConfig();
  // Work on a launch-only copy: injected directories must not become stale
  // entries in the user's persisted MCP configuration.
  const args = [...(definition.args || [])];
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const existing = new Set(args.filter(arg => path.isAbsolute(arg)).map(pathKey));
  for (const directory of [appDataDirectory, modelDirectory]) {
    if (directory == null || directory === '') continue;
    if (!text(directory) || !path.isAbsolute(directory)) throw new Error('Filesystem MCP directories must be absolute paths.');
    const absolute = path.resolve(directory);
    const key = pathKey(absolute);
    if (!existing.has(key)) {
      args.push(absolute);
      existing.add(key);
    }
  }
  return { ...definition, args };
}
function validateServerConfig(name, server) {
  if (!text(name) || !name.trim() || !object(server)) throw new TypeError('Invalid MCP server definition.');
  const hasUrl = server.url !== undefined;
  const hasCommand = server.command !== undefined;
  if (!hasUrl && !hasCommand) {
    throw new TypeError(`Invalid configuration for ${name}: missing command or url`);
  }

  // URL configs use SSE first (or an explicit HTTP transport); no command is needed.
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
  for (const flag of ['enabled', 'disabled', 'uiEnabled']) if (server[flag] !== undefined && typeof server[flag] !== 'boolean') throw new TypeError(`Invalid ${flag} flag for ${name}.`);
  if (server.disabledTools !== undefined && (!Array.isArray(server.disabledTools) || !server.disabledTools.every(text))) throw new TypeError(`Invalid disabled tools for ${name}.`);
  if (server.transport !== undefined && !(hasUrl ? ['sse', 'streamable-http'] : ['stdio']).includes(server.transport)) throw new TypeError(`Transport for ${name} must match its URL (sse or streamable-http) or command (stdio).`);
}

// MCP clients use local stdio or remote HTTP/SSE transports.
class McpManager extends EventEmitter {
  constructor({ configPath = path.join(os.homedir(), '.config', 'Continuum', 'mcp_config.json'), createConnection,
    getNativeServers = () => ({}), prepareServer, lazyByDefault = false,
    getGlobalConfig = () => require('./configStore').getConfig(),
    getMcpMode = () => 'auto' } = {}) {
    super();
    this.configPath = configPath;
    this.servers = new Map();
    this.createConnection = createConnection;
    this.getGlobalConfig = getGlobalConfig;
    this.getMcpMode = getMcpMode;
    this.getNativeServers = getNativeServers;
    this.prepareServer = prepareServer;
    this.lazyByDefault = lazyByDefault;
    this.sessionServers = new Map();
    this.sessionDisabled = new Map();
  }
  isUiEnabled(definition) {
    return this.lazyByDefault
      ? definition?.disabled !== true && (definition?.uiEnabled === true || (definition?.uiEnabled !== false && definition?.disabled === false))
      : definition?.disabled !== true && definition?.enabled !== false;
  }
  isSessionEnabled(serverName, sessionId) {
    return typeof sessionId === 'string' && this.sessionServers.get(sessionId)?.has(serverName) === true;
  }
  isVisibleInSession(server, sessionId) {
    if (typeof sessionId === 'string' && this.sessionDisabled.get(sessionId)?.has(server.name)) return false;
    return server.uiEnabled !== false || this.isSessionEnabled(server.name, sessionId);
  }
  shouldConnect(serverName, definition) {
    return this.isUiEnabled(definition) || [...this.sessionServers.values()].some(names => names.has(serverName));
  }
  init() {
    return this.initializing ??= (async () => {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      try {
        await fs.writeFile(this.configPath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!this.closing) this.startWatcher();
      await this.load({ seedNative: true });
    })();
  }
  startWatcher() {
    if (this.watcher) return;
    // Watch the parent directory so atomic rename-based saves remain observable.
    this.watcher = watch(path.dirname(this.configPath), { persistent: false }, (_event, filename) => {
      if (this.closing || (filename && filename.toString() !== path.basename(this.configPath))) return;
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reload().catch(error => {
          if (this.closing) return;
          this.configError = error.message;
          this.emit('changed');
        });
      }, 150);
      this.reloadTimer.unref?.();
    });
    this.watcher.on('error', error => {
      this.configError = error.message;
      this.emit('changed');
    });
  }
  async reload() {
    await this.init();
    return this.queueChange(() => this.load());
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
      await this.init();
      await this.load();
      return saved;
    });
  }
  async load({ seedNative = false } = {}) {
    const hadError = !!this.configError;
    this.configError = undefined;
    let config;
    try {
      config = await this.getConfig();
      if (seedNative) {
        let added = false;
        for (const [name, definition] of Object.entries(this.getNativeServers(this.configPath))) {
          if (Object.hasOwn(config.mcpServers, name)) continue;
          config.mcpServers[name] = definition;
          added = true;
        }
        if (added) await this.writeConfig(config);
      }
      // At startup, connectServer exposes individual definition errors in the UI.
      // During reload, reject incomplete edits before touching active clients.
      if (this.servers.size) {
        for (const [name, definition] of Object.entries(config.mcpServers)) validateServerConfig(name, definition);
      }
    }
    catch (error) {
      this.configError = error.message;
      this.emit('changed');
      return;
    }
    let changed = false;
    for (const [name, server] of this.servers) {
      if (Object.hasOwn(config.mcpServers, name)) continue;
      server.enabled = false;
      this.servers.delete(name);
      await server.client?.close().catch(() => {});
      changed = true;
    }
    await Promise.all(Object.entries(config.mcpServers).map(async ([name, definition]) => {
      const previous = this.servers.get(name);
      if (previous && isDeepStrictEqual(previous.definition, definition)) return;
      changed = true;
      // Permission-only edits do not require restarting the process.
      const launchDefinition = ({ disabledTools, ...launch }) => launch;
      if (previous?.definition && isDeepStrictEqual(launchDefinition(previous.definition), launchDefinition(definition))) {
        previous.disabledTools = new Set(definition.disabledTools || []);
        previous.definition = structuredClone(definition);
        return;
      }
      if (previous) {
        previous.enabled = false;
        await previous.client?.close().catch(() => {});
      }
      await this.connectServer(name, definition, previous?.tools || []);
    }));
    if (changed || hadError) this.emit('changed');
  }
  async connectServer(name, definition, cachedTools = []) {
    const server = { name, enabled: this.shouldConnect(name, definition), uiEnabled: this.isUiEnabled(definition), status: 'connecting', tools: cachedTools, disabledTools: new Set(Array.isArray(definition?.disabledTools) ? definition.disabledTools : []) };
    server.definition = structuredClone(definition);
    this.servers.set(name, server);
    try {
      validateServerConfig(name, definition);
      if (!server.enabled) { server.status = 'disabled'; return; }
      definition = resolveNativePlaywright(name, definition);
      await this.prepareServer?.(name, definition);
      definition = withFilesystemDirectories(name, definition, this.getGlobalConfig);
      if (this.createConnection) server.client = await this.createConnection(definition);
      else if (definition.url !== undefined) server.client = await connectRemoteMcp(definition);
      else {
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        const client = new Client({ name: 'llm-desktop-assistant', version: '1.0.0' });
        server.client = client;
        const transport = new StdioClientTransport({ command: definition.command, args: definition.args || [], cwd: definition.cwd, env: { ...process.env, ...definition.env }, stderr: 'inherit' });
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
  getTools(sessionId) {
    const manual = this.getMcpMode() === 'manual';
    return [...this.servers.values()].filter(s => s.enabled && s.status === 'connected' &&
      (manual ? s.uiEnabled === true : !this.lazyByDefault || arguments.length === 0 || this.isVisibleInSession(s, sessionId))).flatMap(s =>
      s.tools.filter(t => !s.disabledTools.has(t.name)).map(t => ({ type: 'function', function: {
        name: this.toolName(s.name, t.name), description: t.description || `${s.name}: ${t.name}`, parameters: t.inputSchema || { type: 'object', properties: {} },
      } })));
  }
  resolveTool(name, sessionId) {
    const manual = this.getMcpMode() === 'manual';
    for (const server of this.servers.values()) {
      if (!server.enabled || server.status !== 'connected') continue;
      if (manual ? server.uiEnabled !== true : this.lazyByDefault && arguments.length > 1 && !this.isVisibleInSession(server, sessionId)) continue;
      const tool = server.tools.find(t => !server.disabledTools.has(t.name) && this.toolName(server.name, t.name) === name);
      if (tool) return { serverName: server.name, toolName: tool.name };
    }
    throw new Error('MCP tool is unavailable or disabled.');
  }
  async callTool(serverName, toolName, args, { signal, sessionId, permissionMode, permissionGranted = false } = {}) {
    const server = this.servers.get(serverName);
    if (!server?.enabled || server.status !== 'connected' || server.disabledTools.has(toolName) || !server.tools.some(t => t.name === toolName)) throw new Error('MCP tool is unavailable or disabled.');
    if (this.getMcpMode() === 'manual' ? server.uiEnabled !== true : this.lazyByDefault && sessionId !== undefined && !this.isVisibleInSession(server, sessionId)) throw new Error('MCP server is not enabled for this chat.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
    const payload = JSON.stringify(args);
    if (!(permissionGranted && ['ask_approval', 'full_access'].includes(permissionMode)) && requiresConfirmation(payload)) {
      const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
      // Delete synchronously before dispatch so concurrent calls cannot reuse approval.
      if (!approvedMutations.delete(hash)) {
        throw new Error(`SAFETY GUARD INTERCEPT: Mutation payload flagged. Ask the user for permission. If approved, first use the native tool 'approve_mcp_mutation' with hash ${hash}, then re-run this MCP tool.`);
      }
    }
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
      definition.uiEnabled = enabled;
      delete definition.enabled; // Normalize the legacy alias so it cannot override the switch.
      if (!enabled) for (const names of this.sessionServers.values()) names.delete(serverName);
      await this.writeConfig(config);
      const server = this.servers.get(serverName);
      if (server) {
        server.definition = structuredClone(definition);
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
  async manageServers(action, serverNames, sessionId) {
    if (this.getMcpMode() === 'manual') throw new Error('MCP server management is disabled in Manual Mode.');
    if (!['enable', 'disable', 'restart'].includes(action)) throw new TypeError('Invalid MCP server action.');
    if (!Array.isArray(serverNames) || !serverNames.length || serverNames.length > 20 ||
        !serverNames.every(name => text(name) && name.trim())) throw new TypeError('server_names must contain 1–20 server names.');
    if (!text(sessionId) || !sessionId.trim()) throw new TypeError('A chat session is required.');
    await this.init();
    return this.queueChange(async () => {
      const config = await this.getConfig();
      const names = [...new Set(serverNames)];
      for (const name of names) if (!Object.hasOwn(config.mcpServers, name)) throw new Error(`Unknown MCP server: ${name}`);
      const active = this.sessionServers.get(sessionId) || new Set();
      const disabled = this.sessionDisabled.get(sessionId) || new Set();
      this.sessionServers.set(sessionId, active);
      this.sessionDisabled.set(sessionId, disabled);
      const results = [];
      for (const name of names) {
        const definition = config.mcpServers[name];
        const previous = this.servers.get(name);
        if (action === 'disable') { active.delete(name); disabled.add(name); }
        else { active.add(name); disabled.delete(name); }
        const shouldConnect = this.shouldConnect(name, definition);
        if (action === 'restart' || (action === 'enable' && previous?.status !== 'connected') ||
            (action === 'disable' && !shouldConnect && previous?.enabled)) {
          if (previous) {
            previous.enabled = false;
            await previous.client?.close().catch(() => {});
          }
          await this.connectServer(name, definition, previous?.tools || []);
        }
        const server = this.servers.get(name);
        const success = action === 'disable' || server?.status === 'connected';
        results.push({ name, action, success, message: success
          ? `Server '${name}' ${action === 'enable' ? 'enabled' : action === 'restart' ? 'restarted' : 'disabled'} successfully.${action === 'disable' ? ' Its tools are no longer available in this chat.' : ' Its tools are now available in your schema.'}`
          : `Server '${name}' could not be ${action === 'restart' ? 'restarted' : 'enabled'}: ${server?.error || 'connection failed'}` });
      }
      if (!active.size) this.sessionServers.delete(sessionId);
      if (!disabled.size) this.sessionDisabled.delete(sessionId);
      this.emit('changed');
      return { success: results.every(result => result.success), message: results.map(result => result.message).join(' '), servers: results };
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
      server.definition = structuredClone(definition);
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
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
    await this.saving;
    await this.initializing;
    await this.disconnect();
  }
}
const { nativePlaywrightConfig, resolveNativePlaywright, prepareNativePlaywright } = require('./nativePlaywright');
module.exports = new McpManager({
  getNativeServers: configPath => ({ 'playwright-native': nativePlaywrightConfig(path.dirname(configPath)) }),
  prepareServer: prepareNativePlaywright,
  lazyByDefault: true,
  getMcpMode: () => require('./configManager').getAppSettings().mcpMode,
});
module.exports.McpManager = McpManager;
