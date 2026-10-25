'use strict';
const { connectRemoteMcp } = require('./remoteMcp');
const { limitFilesystemResult } = require('./filesystemToolLimits');
const { requiresConfirmation, approvedMutations } = require('./safetyGuards');
const { decideToolApproval } = require('./toolApprovalPolicy');
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
  for (const flag of ['enabled', 'disabled', 'uiEnabled', 'trusted']) if (server[flag] !== undefined && typeof server[flag] !== 'boolean') throw new TypeError(`Invalid ${flag} flag for ${name}.`);
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
    this.sessionTools = new Map();
    this.activeRuns = new Map();
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
      for (const selections of this.sessionTools.values()) selections.delete(name);
      for (const names of this.sessionServers.values()) names.delete(name);
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
        this.revokeSelections(name, previous.disabledTools);
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
      server.status = 'error';
      server.error = error.code === 'ENOENT' && !definition.url
        ? `MCP_RUNTIME_NOT_FOUND: Cannot launch server '${name}': executable '${definition.command}' or configured working directory was not found. Install the required runtime and ensure it is on the app's PATH, or set an absolute command path and valid cwd in MCP Settings. Do not retry until setup changes.${definition.command === 'uvx' ? ' The fetch server requires uv/uvx. For web pages, use native get_single_web_page_content or web_search instead.' : ''}`
        : error.message;
      server.tools = [];
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
  isTrustedActivation(action, names) {
    return this.getMcpMode() !== 'manual' && ['enable', 'restart', 'disable'].includes(action) &&
      Array.isArray(names) && names.length > 0 && names.length <= 20 &&
      names.every(name => require('./nativePlaywright').isTrustedNativePlaywright(name, this.servers.get(name)?.definition));
  }
  // The existing manager owns the registry. No credentials, launch arguments,
  // headers or schemas are serialized by discovery.
  searchCapabilities({ query = '', limit = 5, cursor, server_names } = {}, sessionId) {
    const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
    if (typeof query !== 'string' || query.length > 500 || query.includes('\0') ||
        !Number.isInteger(limit) || limit < 1 || limit > 10 ||
        (server_names !== undefined && (!Array.isArray(server_names) || server_names.length !== 1 || typeof server_names[0] !== 'string')))
      fail('MCP_INVALID_SEARCH', 'Search requires a query of at most 500 characters, limit 1–10 and optionally one exact server identifier.');
    if (this.configError) fail('MCP_CATALOG_UNAVAILABLE', 'MCP catalog configuration is invalid.');
    let servers = [...this.servers.values()];
    if (!servers.length) {
      try {
        const config = JSON.parse(require('node:fs').readFileSync(this.configPath, 'utf8'));
        servers = Object.entries(config.mcpServers || {}).map(([name, definition]) => ({ name, definition, tools: [],
          disabledTools: new Set(definition.disabledTools || []), status: 'inactive' }));
      } catch (error) { if (error.code !== 'ENOENT') fail('MCP_CATALOG_UNAVAILABLE', 'MCP catalog cannot be read.'); }
    }
    const stop = new Set(['find', 'and', 'or', 'the', 'a', 'an', 'to', 'for', 'read', 'get', 'search']);
    const terms = query.toLowerCase().trim().split(/[\s_\-/]+/u).filter(term => term && !stop.has(term));
    const revision = createHash('sha256');
    const rows = [];
    const clip = value => String(value || '').replace(/\s+/g, ' ').slice(0, 240);
    for (const server of servers) {
      revision.update(JSON.stringify([server.name, server.definition?.description, server.definition?.disabled,
        server.status, server.definition?.displayName, [...server.disabledTools], server.tools.map(t => [t.name, t.description, t.inputSchema])]));
      if (server_names && server.name !== server_names[0]) continue;
      const purpose = require('./nativePlaywright').isTrustedNativePlaywright(server.name, server.definition)
        ? 'Browser automation navigation page DOM inspection screenshots' : server.definition?.description || '';
      // Include a server row even when its lazy process has never been started.
      // Inspect connects only the chosen server and loads searchable tool metadata.
      for (const tool of [null, ...server.tools]) {
        const name = tool?.name || '';
        const haystack = `${server.name} ${server.definition?.displayName || ''} ${purpose} ${name} ${tool?.description || ''}`.toLowerCase();
        const score = terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0) +
          (query && [server.name.toLowerCase(), name.toLowerCase()].includes(query.toLowerCase()) ? 100 : 0) +
          (name && query.toLowerCase().split(/\s+/).includes(name.toLowerCase()) ? 200 : 0);
        if (terms.length && !terms.every(term => haystack.includes(term))) continue;
        rows.push({ score, serverId: server.name, ...(server.definition?.displayName ? { serverName: clip(server.definition.displayName) } : {}), ...(tool ? { toolName: name } : {}),
          description: clip(tool?.description || purpose), status: server.status,
          disabled: server.definition?.disabled === true || !!(tool && server.disabledTools.has(name)),
          metadataTrust: 'untrusted' });
      }
    }
    const version = revision.digest('hex');
    const searchKey = createHash('sha256').update(JSON.stringify({ query, server_names })).digest('hex');
    rows.sort((a, b) => b.score - a.score || (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0) ||
      ((a.toolName || '') < (b.toolName || '') ? -1 : (a.toolName || '') > (b.toolName || '') ? 1 : 0));
    let offset = 0;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error();
        const state = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (state.version !== version) fail('MCP_STALE_CURSOR', 'MCP catalog changed; repeat the search.');
        if (state.searchKey !== searchKey ||
            !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > rows.length) throw new Error();
        offset = state.offset;
      } catch (error) { if (error.code === 'MCP_STALE_CURSOR') throw error; fail('MCP_INVALID_CURSOR', 'Invalid MCP search continuation.'); }
    }
    const results = [];
    let size = 0;
    for (const row of rows.slice(offset, offset + limit)) {
      const { score, ...result } = row;
      const rowSize = Buffer.byteLength(JSON.stringify(result));
      if (rowSize > 12000) fail('MCP_IDENTITY_TOO_LARGE', 'MCP identifier exceeds discovery payload capacity; rename it in Settings.');
      if (size + rowSize > 12000) break;
      results.push(result); size += rowSize;
    }
    const next = offset + results.length;
    return { results, hasMore: next < rows.length,
      ...(next < rows.length ? { cursor: Buffer.from(JSON.stringify({ version, searchKey, offset: next })).toString('base64url') } : {}),
      ...(!results.length ? { message: 'No matching MCP capabilities. Try a server purpose or another keyword.' } : {}) };
  }
  async findAndPrepare(args, sessionId, options = {}) {
    if (this.getMcpMode() === 'manual') throw new Error('MCP preparation is disabled in Manual Mode.');
    if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('MCP query is required.');
    await this.init();
    const query = args.query.split(/\s+/).map(word => {
      const lower = word.toLowerCase();
      if (/^(my|please|one|two|three|four|five|six|seven|eight|nine|ten|\d+)$/.test(lower)) return '';
      return ({ latest: 'recent', newest: 'recent', messages: 'email', emails: 'email' })[lower] || word;
    }).filter(Boolean).join(' ');
    let search = this.searchCapabilities({ ...args, query }, sessionId);
    if (!search.results.length && !args.cursor) {
      // A lazy server may have no cached tool names yet. Resolve only an
      // explicit identifier mentioned by the query, never launch the catalog.
      const named = [...this.servers.keys()].filter(name => args.server_names?.includes(name) ||
        args.query.toLowerCase().split(/\s+/).includes(name.toLowerCase()));
      if (named.length === 1) search = this.searchCapabilities({ query: '', server_names: named, limit: 10 }, sessionId);
    }
    const exact = search.results.filter(row => row.toolName && args.query.toLowerCase().split(/\s+/).includes(row.toolName.toLowerCase()));
    const queryWords = args.query.toLowerCase().replace(/[_-]/g, ' ');
    const mutationIntent = /\b(send|publish|post|delete|remove|transfer|purchase|pay|trade)\b/.test(queryWords) &&
      !/\b(read|fetch|search|list|get|inspect)\b/.test(queryWords);
    const eligibleRow = row => !row.disabled && (!row.toolName || mutationIntent ||
      !['outbound', 'destructive', 'external-mutation'].includes(require('./mcpPermissionPolicy').classifyEffect(row.toolName)));
    const eligible = (exact.length ? exact : search.results).filter(eligibleRow);
    const servers = [...new Set(eligible.map(row => row.serverId))];
    const explicitServer = args.server_names?.length === 1 || (servers.length === 1 && args.query.toLowerCase().split(/\s+/).includes(servers[0].toLowerCase()));
    // Never choose an arbitrary integration or truncate an ambiguous page.
    if (args.cursor || servers.length !== 1 || (search.hasMore && !(exact.length && explicitServer))) return { ...search, ready: false, message: 'Refine the query or choose an exact server identifier. Disabled tools require MCP Settings.' };
    const serverId = servers[0];
    if (this.servers.get(serverId)?.definition.disabled === true) throw new Error('MCP_SERVER_DISABLED: Enable this server in MCP Settings.');
    let tools = eligible.filter(row => row.toolName).map(row => row.toolName);
    if (!tools.length) {
      // Existing activation connects with an empty selection; no schema or
      // operation is exposed while authoritative tools/list is loading.
      await this.activateTools(serverId, [], sessionId, { ...options, protectDisabled: true });
      const loaded = this.searchCapabilities({ ...args, query, cursor: undefined, server_names: [serverId] }, sessionId);
      const matches = loaded.results.filter(row => row.toolName && eligibleRow(row));
      const exactLoaded = matches.filter(row => args.query.toLowerCase().split(/\s+/).includes(row.toolName.toLowerCase()));
      tools = (exactLoaded.length ? exactLoaded : matches).map(row => row.toolName);
      if ((loaded.hasMore && !exactLoaded.length) || tools.length !== 1) return { ...loaded, ready: false, message: 'Choose a more specific operation.' };
    }
    if (tools.length !== 1) return { ...search, ready: false, message: 'Multiple operations match; refine the query.' };
    const result = await this.activateTools(serverId, tools, sessionId, { ...options, protectDisabled: true });
    return { ...result, ready: true, tools: tools.map(name => this.toolName(serverId, name)) };
  }
  async reconnectPrepared(sessionId, { signal, authorize } = {}) {
    if (!this.activeRuns.has(sessionId) || typeof authorize !== 'function') return;
    const runId = this.activeRuns.get(sessionId);
    const manual = this.getMcpMode() === 'manual';
    for (const [name, server] of this.servers) {
      const selected = this.sessionTools.get(sessionId)?.get(name);
      if (server.status !== 'disconnected' || !server.enabled || server.definition.disabled === true ||
          (manual ? server.uiEnabled !== true : !(selected instanceof Set) || !selected.size)) continue;
      signal?.throwIfAborted();
      // The caller uses the ordinary permission/approval guard, never a grant
      // reconstructed from a model summary or an external tool result.
      const validateAuthorization = await authorize(name);
      if (typeof validateAuthorization !== 'function') continue;
      const verify = () => {
        signal?.throwIfAborted(); validateAuthorization();
        if (this.activeRuns.get(sessionId) !== runId || (this.getMcpMode() === 'manual') !== manual)
          throw new Error('MCP_SESSION_INACTIVE: Reconnection owner or mode changed.');
      };
      verify();
      if (!manual) {
        const names = [...selected];
        for (let offset = 0; offset < names.length; offset += 20)
          await this.activateTools(name, names.slice(offset, offset + 20), sessionId, { signal, protectDisabled: true, validateAuthorization: verify });
        continue;
      }
      await this.queueChange(async () => {
        verify();
        const definition = (await this.getConfig()).mcpServers[name];
        verify();
        if (!definition || definition.disabled === true || this.servers.get(name) !== server ||
            !server.uiEnabled || !server.enabled || !isDeepStrictEqual(server.definition, definition)) return;
        if (server.status !== 'disconnected') return;
        await server.client?.close().catch(() => {});
        verify();
        await this.connectServer(name, definition, server.tools);
        verify();
      });
    }
  }
  getDiscoveryCatalog(sessionId) {
    const compact = value => String(value || '').replace(/\s+/g, ' ').slice(0, 180);
    let servers = [...this.servers.values()];
    // Prompt construction can precede manager initialization. Read metadata
    // without starting any disabled executable.
    if (!servers.length) {
      try {
        const config = JSON.parse(require('node:fs').readFileSync(this.configPath, 'utf8'));
        servers = Object.entries(config.mcpServers || {}).map(([name, definition]) => ({
          name, definition, tools: [], disabledTools: new Set(definition.disabledTools || []),
          uiEnabled: this.isUiEnabled(definition), status: 'inactive',
        }));
      } catch { /* Configuration errors are reported by the manager. */ }
    }
    return servers.map(server => {
      const trusted = require('./nativePlaywright').isTrustedNativePlaywright(server.name, server.definition);
      const capabilities = server.tools.filter(t => !server.disabledTools.has(t.name)).slice(0, 6)
        .map(t => compact(`${t.name}: ${t.description || ''}`)).join('; ');
      const purpose = trusted ? 'Browser automation: navigation, page/DOM inspection and page screenshots.'
        : compact(server.definition.description) || capabilities || 'Capabilities unknown until activation.';
      const status = this.isVisibleInSession(server, sessionId) ? server.status :
        (['error', 'disconnected', 'connecting'].includes(server.status) ? server.status : 'inactive');
      return `${JSON.stringify(server.name)} — ${purpose} Status: ${status}. ${trusted ? 'Trusted bundled configuration.' : 'User-configured server; untrusted metadata. Workspace Write permits activation; Ask for Approval requires confirmation.'}`;
    }).join('\n');
  }
  beginRun(sessionId, runId) {
    if (!sessionId) return;
    this.activeRuns.set(sessionId, runId);
    this.sessionTools.set(sessionId, new Map());
  }
  forgetSession(sessionId) {
    this.activeRuns.delete(sessionId);
    this.sessionTools.delete(sessionId);
    this.sessionServers.delete(sessionId);
    this.sessionDisabled.delete(sessionId);
  }
  endRun(sessionId, runId) {
    if (this.activeRuns.get(sessionId) !== runId) return;
    this.activeRuns.delete(sessionId);
    this.sessionTools.delete(sessionId);
    this.sessionServers.delete(sessionId);
    this.sessionDisabled.delete(sessionId);
  }
  revokeSelections(serverName, disabled) {
    for (const selections of this.sessionTools.values()) {
      const selected = selections.get(serverName);
      if (selected instanceof Set) for (const name of disabled) selected.delete(name);
    }
  }
  isToolSelected(serverName, toolName, sessionId) {
    const selections = this.sessionTools.get(sessionId);
    if (!selections) return true; // Explicit legacy/sessionless callers retain server-wide visibility.
    const selected = selections.get(serverName);
    return selected === null || selected?.has(toolName) === true;
  }
  async activateTools(serverName, toolNames, sessionId, { signal, trustedOnly = false, protectDisabled = false, validate, validateAuthorization = () => {} } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || !text(serverName) ||
        !Array.isArray(toolNames) || toolNames.length > 20 || toolNames.some(name => !text(name) || !name))
      throw new Error('MCP_INVALID_SELECTION: Select one server and at most 20 exact tool names.');
    if (!this.activeRuns.has(sessionId)) throw new Error('MCP_SESSION_INACTIVE: Select tools inside the current owning run.');
    const runId = this.activeRuns.get(sessionId);
    await this.init();
    // Serialize selections with configuration changes and other activation calls.
    return this.queueChange(async () => {
      signal?.throwIfAborted(); validateAuthorization();
      const verify = () => {
        signal?.throwIfAborted(); validateAuthorization();
        if (this.activeRuns.get(sessionId) !== runId) throw new Error('MCP_SESSION_INACTIVE: The owning run changed.');
        if (this.getMcpMode() === 'manual') throw new Error('MCP management is disabled in Manual Mode.');
      };
      verify();
      const config = await this.getConfig();
      const definition = config.mcpServers[serverName];
      if (!definition) throw new Error('MCP_SERVER_REMOVED: Repeat capability search.');
      if (definition.disabled === true && (protectDisabled || !this.isSessionEnabled(serverName, sessionId))) throw new Error('MCP_SERVER_DISABLED: This server is disabled. Use the authorized enable action for this chat, or enable it in MCP Settings, before inspecting or activating tools.');
      if (trustedOnly && !require('./nativePlaywright').isTrustedNativePlaywright(serverName, definition))
        throw new Error('MCP_ACTIVATION_UNAUTHORIZED: Configuration changed; approval required.');
      let server = this.servers.get(serverName);
      if (!server || !isDeepStrictEqual(server.definition, definition)) throw new Error('MCP_STALE_SELECTION: Reload and repeat capability search.');
      // Reserve an empty selection before connecting: no transient whole-server
      // exposure, including broadcasts while tools/list is in flight.
      let selections = this.sessionTools.get(sessionId);
      if (!selections) { selections = new Map(); this.sessionTools.set(sessionId, selections); }
      const previous = selections.get(serverName);
      if (!selections.has(serverName)) selections.set(serverName, new Set());
      const active = this.sessionServers.get(sessionId) || new Set();
      this.sessionServers.set(sessionId, active); active.add(serverName);
      this.sessionDisabled.get(sessionId)?.delete(serverName);
      if (server.status !== 'connected') {
        server.enabled = false;
        await server.client?.close().catch(() => {});
        verify();
        await this.connectServer(serverName, definition, server.tools);
        server = this.servers.get(serverName);
      }
      verify();
      if (server?.status !== 'connected') throw new Error(`MCP_SERVER_DISCONNECTED: Selected server could not connect. ${server?.error || 'Check MCP Settings.'}`);
      const names = [...new Set(toolNames)];
      for (const name of names) {
        const tool = server.tools.find(t => t.name === name);
        if (!tool) throw new Error('MCP_TOOL_REMOVED: Repeat capability search for the selected server.');
        if (server.disabledTools.has(name)) throw new Error('MCP_TOOL_DISABLED: Tool is disabled in Settings.');
        if (!object(tool.inputSchema) || (tool.inputSchema.type !== undefined && tool.inputSchema.type !== 'object'))
          throw new Error('MCP_SCHEMA_INVALID: Tool requires a JSON object schema.');
        require('./toolSchemaValidation').compile(tool.inputSchema);
      }
      const selected = new Set(previous === null ? server.tools.map(t => t.name) : previous || []);
      for (const name of names) selected.add(name);
      const schemas = server.tools.filter(t => selected.has(t.name) && !server.disabledTools.has(t.name)).map(t => this.schema(server, t));
      const prospective = [...this.getTools(sessionId).filter(t => !server.tools.some(st => this.toolName(serverName, st.name) === t.function.name)), ...schemas];
      const { approximateTokens, createRuntimeBudget, ContextBudgetError } = require('./contextBudget');
      const schemaBytes = Buffer.byteLength(JSON.stringify(schemas));
      const addedSchemaBytes = Math.max(0, Buffer.byteLength(JSON.stringify(prospective)) - Buffer.byteLength(JSON.stringify(this.getTools(sessionId))));
      const schemaSnapshot = JSON.stringify(server.tools);
      let measured;
      if (validate) measured = await validate(prospective);
      else {
        const payload = { messages: [], tools: prospective };
        const tokens = approximateTokens(payload);
        const budgetContract = createRuntimeBudget({ payload, currentInputTokens: tokens });
        measured = { tokens, budget: budgetContract.usableInputTokens, budgetContract, method: 'approximate-full-request' };
      }
      if (measured.tokens > measured.budget) {
        const error = new ContextBudgetError(`MCP activation: ${measured.tokens} estimated input tokens; capacity ${measured.budget}; select fewer tools`);
        error.code = 'MCP_ACTIVATION_BUDGET_EXCEEDED'; throw error;
      }
      verify();
      if (this.servers.get(serverName) !== server || JSON.stringify(server.tools) !== schemaSnapshot || server.status !== 'connected' || !server.enabled ||
          names.some(name => server.disabledTools.has(name) || !server.tools.some(t => t.name === name)))
        throw new Error('MCP_SCHEMA_REFRESH_FAILED: Catalog changed during activation; search again.');
      selections.set(serverName, selected);
      this.emit('changed');
      return { success: true, serverId: serverName, selectedTools: names, selectedToolCount: selected.size, schemaBytes, addedSchemaBytes, estimatedAddedSchemaTokens: Math.ceil(addedSchemaBytes / 3),
        estimatedSchemaTokens: Math.ceil(schemaBytes / 3), measurementMethod: measured.method,
        message: 'Selected schemas appear on the next request in this run. Execution permissions remain required. Use search with server_names to page this server catalog.' };
    });
  }
  schema(server, tool) {
    return { type: 'function', function: { name: this.toolName(server.name, tool.name),
      description: tool.description || `${server.name}: ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} } } };
  }
  getTools(sessionId) {
    const manual = this.getMcpMode() === 'manual';
    return [...this.servers.values()].filter(s => s.enabled && s.status === 'connected' &&
      (manual ? s.uiEnabled === true : !this.lazyByDefault || arguments.length === 0 || this.isVisibleInSession(s, sessionId))).flatMap(s =>
      s.tools.filter(t => !s.disabledTools.has(t.name) && (manual || this.isToolSelected(s.name, t.name, sessionId))).map(t => this.schema(s, t)));
  }
  resolveTool(name, sessionId) {
    const manual = this.getMcpMode() === 'manual';
    for (const server of this.servers.values()) {
      if (!server.enabled || server.status !== 'connected') continue;
      if (manual ? server.uiEnabled !== true : this.lazyByDefault && arguments.length > 1 && !this.isVisibleInSession(server, sessionId)) continue;
      const tool = server.tools.find(t => !server.disabledTools.has(t.name) && (manual || this.isToolSelected(server.name, t.name, sessionId)) && this.toolName(server.name, t.name) === name);
      if (tool) return { serverName: server.name, toolName: tool.name };
    }
    throw new Error('MCP tool is unavailable or disabled.');
  }
  getApprovalFacts(serverName, toolName) {
    const server = this.servers.get(serverName);
    const tool = server?.tools.find(tool => tool.name === toolName);
    return { annotations: tool?.annotations, serverTrusted: server?.definition?.trusted === true };
  }
  async callTool(serverName, toolName, args, { signal, sessionId, permissionMode, permissionGranted = false, approval } = {}) {
    const server = this.servers.get(serverName);
    if (!server?.enabled || server.status !== 'connected' || server.disabledTools.has(toolName) || !server.tools.some(t => t.name === toolName)) throw new Error('MCP tool is unavailable or disabled.');
    if (this.getMcpMode() === 'manual' ? server.uiEnabled !== true : this.lazyByDefault && sessionId !== undefined && !this.isVisibleInSession(server, sessionId)) throw new Error('MCP server is not enabled for this chat.');
    if (this.getMcpMode() !== 'manual' && !this.isToolSelected(serverName, toolName, sessionId)) throw new Error('MCP_TOOL_NOT_SELECTED: Activate this tool for the current chat.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
    const authoritative = server.tools.find(tool => tool.name === toolName).inputSchema || { type: 'object' };
    require('./toolSchemaValidation').validate(authoritative, args);
    const contexts = require('./lspExecutionContext');
    const revision = contexts.revision(sessionId);
    if (sessionId) {
      permissionMode = contexts.currentMode(sessionId, permissionMode);
      if (approval && (approval.mode !== permissionMode || (Object.hasOwn(approval, 'policyRevision') && approval.policyRevision !== revision))) throw new Error('Execution blocked: Permission revoked since authorization.');
      if (!permissionGranted || permissionMode === 'read_only') approval = await require('./toolPermissions').guardTool({ name: toolName, args, sessionId, permissionMode, serverName, project: require('./toolPermissions').sessionProject(sessionId), native: false, signal, ...this.getApprovalFacts(serverName, toolName) });
    }
    const workspaceMcp = permissionMode === 'workspace_write' && sessionId && require('./toolPermissions').sessionProject(sessionId)?.root_path;
    const policyInput = { workspaceMcp, tool: toolName, args, mode: permissionMode, native: false, serverName,
      approved: Boolean(approval?.approved), permissionGranted, ...this.getApprovalFacts(serverName, toolName), stage: 'mcp_dispatch' };
    // Preserve independent deletion/outbound enforcement before SQL gating.
    const deletion = decideToolApproval({ ...policyInput, dispatchPhase: 'deletion' });
    if (deletion.decision === 'ask') throw new Error(`Execution blocked: ${deletion.reason}`);
    const payload = JSON.stringify(args);
    const immediate = decideToolApproval(policyInput);
    if (immediate.decision === 'ask') throw new Error(`Execution blocked: ${immediate.reason}`);
    const dispatchPolicy = decideToolApproval({ ...policyInput, workspaceMcp,
      mutationRequiresConfirmation: permissionMode !== 'full_access' && !workspaceMcp &&
        !(permissionGranted && permissionMode === 'ask_approval') && requiresConfirmation(payload) });
    if (dispatchPolicy.decision === 'ask' && dispatchPolicy.route !== 'mutation_challenge')
      throw new Error(`Execution blocked: ${dispatchPolicy.reason}`);
    if (dispatchPolicy.route === 'mutation_challenge') {
      const hash = require('./safetyGuards').mutationHash(sessionId, serverName, toolName, payload);
      // Delete synchronously before dispatch so concurrent calls cannot reuse approval.
      if (!approvedMutations.delete(require('./safetyGuards').mutationApprovalKey(sessionId, hash))) {
        throw new Error(`SAFETY GUARD INTERCEPT: Mutation payload flagged. Ask the user for permission. If approved, first use the native tool 'approve_mcp_mutation' with hash ${hash}, then re-run this MCP tool.`);
      }
    }
    // Phase 2 recovery: an MCP tool runs in an external process with full
    // filesystem access, so workspace-affecting calls get the same
    // before/after boundary as shell commands. Placement is deliberate:
    // after the mutation-approval gate above (denied calls never scan) and
    // covering only the actual dispatch. Read-only and non-workspace calls
    // run exactly as before. The string result shape is unchanged (the
    // checkpoint is discoverable via listCheckpoints, not the payload).
    const dispatch = () => {
      signal?.throwIfAborted();
      if (sessionId && contexts.revision(sessionId) !== revision) throw new Error('Execution blocked: Permission revoked before MCP dispatch.');
      if (this.servers.get(serverName) !== server || !server.enabled || server.status !== 'connected' || server.disabledTools.has(toolName) || (this.getMcpMode() !== 'manual' && !this.isToolSelected(serverName, toolName, sessionId)) ||
          (this.getMcpMode() === 'manual' ? server.uiEnabled !== true : this.lazyByDefault && sessionId !== undefined && !this.isVisibleInSession(server, sessionId))) throw new Error('MCP tool is unavailable or disabled.');
      return server.client.callTool({ name: toolName, arguments: args }, undefined, { signal, timeout: 60000 });
    };
    const { shouldScanMcpCall, withMcpRecovery } = require('./recoveryBoundary');
    const project = sessionId ? require('./toolPermissions').sessionProject(sessionId) : null;
    const root = project?.root_path ?? null;
    let result;
    if (root && await shouldScanMcpCall({ toolName, args, root })) {
      result = await withMcpRecovery({
        root, chatSessionId: sessionId ?? null, toolName: `mcp:${serverName}/${toolName}`,
        opMeta: { server: serverName },
      }, dispatch);
    } else {
      result = await dispatch();
    }
    if (result?.isError && result.content?.some(part => part.type === 'text' &&
        /no connection to browser extension/i.test(part.text))) {
      result = { ...result, success: false, code: 'MCP_BROWSER_NOT_CONNECTED', retryable: false,
        recovery: 'Browser MCP requires a browser tab connected through its extension: click the Browser MCP toolbar icon and Connect. Repeated navigation calls cannot fix this. For browser automation without the extension, search for and activate the bundled playwright-native server, if available and permitted. For page text or search, use native get_single_web_page_content or web_search. Report the setup blocker if no suitable alternative is available.' };
    }
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
      if (!enabled) {
        for (const names of this.sessionServers.values()) names.delete(serverName);
        for (const selections of this.sessionTools.values()) selections.delete(serverName);
      }
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
  async manageServers(action, serverNames, sessionId, { signal, trustedOnly = false } = {}) {
    signal?.throwIfAborted();
    if (this.getMcpMode() === 'manual') throw new Error('MCP server management is disabled in Manual Mode.');
    if (!['enable', 'disable', 'restart'].includes(action)) throw new TypeError('Invalid MCP server action.');
    if (!Array.isArray(serverNames) || !serverNames.length || serverNames.length > 20 ||
        !serverNames.every(name => text(name) && name.trim())) throw new TypeError('server_names must contain 1–20 server names.');
    if (!text(sessionId) || !sessionId.trim()) throw new TypeError('A chat session is required.');
    await this.init();
    return this.queueChange(async () => {
      if (this.getMcpMode() === 'manual') throw new Error('MCP server management is disabled in Manual Mode.');
      const config = await this.getConfig();
      signal?.throwIfAborted();
      const names = [...new Set(serverNames)];
      if (trustedOnly && !names.every(name => require('./nativePlaywright').isTrustedNativePlaywright(name, config.mcpServers[name]))) {
        throw new Error('MCP configuration changed or is not trusted; activation requires approval.');
      }
      for (const name of names) if (!Object.hasOwn(config.mcpServers, name)) throw new Error(`Unknown MCP server: ${name}`);
      const active = this.sessionServers.get(sessionId) || new Set();
      const disabled = this.sessionDisabled.get(sessionId) || new Set();
      this.sessionServers.set(sessionId, active);
      this.sessionDisabled.set(sessionId, disabled);
      const results = [];
      for (const name of names) {
        signal?.throwIfAborted();
        const definition = config.mcpServers[name];
        const previous = this.servers.get(name);
        if (action === 'disable') { active.delete(name); disabled.add(name); this.sessionTools.get(sessionId)?.delete(name); }
        else if (this.sessionTools.has(sessionId)) this.sessionTools.get(sessionId).set(name, null);
        if (action !== 'disable') { active.add(name); disabled.delete(name); }
        const shouldConnect = this.shouldConnect(name, definition);
        if (action === 'restart' || (action === 'enable' && previous?.status !== 'connected') ||
            (action === 'disable' && !shouldConnect && previous?.enabled)) {
          if (previous) {
            previous.enabled = false;
            await previous.client?.close().catch(() => {});
          }
          await this.connectServer(name, definition, previous?.tools || []);
        }
        signal?.throwIfAborted();
        const server = this.servers.get(name);
        const success = action === 'disable' || server?.status === 'connected';
        results.push({ name, action, success, message: success
          ? `Server '${name}' ${action === 'enable' ? 'enabled' : action === 'restart' ? 'restarted' : 'disabled'} successfully.${action === 'disable' ? ' Its tools are no longer available in this chat.' : ' Its tools are now available for the next inference request in this same run; continue without restarting.'}`
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
      this.revokeSelections(server.name, disabled);
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
    this.sessionTools.clear();
    this.activeRuns.clear();
    this.sessionServers.clear();
    this.sessionDisabled.clear();
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
