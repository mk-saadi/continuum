# MCP tools

Open **Memory settings** for three tabs:

- **Memory Palace**: context window, saved memories, and the add-memory form.
- **MCP Integrations**: server switches, connection/error badges, deletion, and
  expandable tool permissions with Enable All / Disable All.
- **Server Config**: add a Local Process (command and comma-separated arguments)
  or Remote URL (SSE endpoint and JSON headers), or use the Raw JSON Editor.

Configuration saves reconnect servers automatically. Permission changes persist
without a restart. Tool changes update active declarations and token counts
without reconnecting. A master switch closes or connects only its server;
turning it off preserves its per-tool permissions. Existing environment variables,
working directories, and other options are preserved. Failed writes leave active
permissions unchanged. Invalid JSON leaves the editor draft intact.

For advanced options, the config remains available at
`~/.config/LLM Desktop Assistant/mcp_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/allowed/folder"]
    },
    "remote-example": {
      "url": "https://example.com/sse",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    },
    "custom-server": {
      "command": "/absolute/path/to/server",
      "args": [],
      "env": { "EXAMPLE_SETTING": "value" },
      "disabled": true,
      "disabledTools": ["tool_name"]
    }
  }
}
```

Install or supply your preferred MCP servers. The manager supports standard MCP
stdio (JSON-RPC IPC over stdin/stdout) and remote HTTP/SSE. A `url` selects
SSE; otherwise `command` selects stdio. URLs must use HTTP or HTTPS; headers
must be string-valued JSON objects. The installed SDK receives headers through
`requestInit.headers`, which applies them to both SSE GET and JSON-RPC POST.
Transport startup and initialization are bounded to 15 seconds.
See the [SDK transport guide](https://ts.sdk.modelcontextprotocol.io/client).
Definitions may include `cwd`, `env`, `disabled` (or `enabled: false`), and
`disabledTools` containing original server tool names. Missing configuration is
valid and enables no MCP tools. Connection failures appear in Memory settings;
other servers continue connecting.

MCP Integrations shows each server's status and lets you enable or disable
individual tools persistently. Master switches write `disabled`; tool switches
write original tool names to `disabledTools`. Disabled servers retain discovered
tool names until app restart; enable a server to discover its tools again.
Tools are given stable, namespaced model-facing names to avoid collisions.
The SDK handles the initialize handshake, paginated discovery, tool-list change
notifications, bounded tool requests, and process shutdown.

Chat now runs through `engine:chat` in the main process. It combines memory and
MCP tools, assembles streamed tool calls, displays execution cards, appends
`role: "tool"` results, and requests the next assistant response. It also accepts
non-streamed JSON completions. Stop cancels requests and pending MCP calls;
it cannot undo actions a server has already performed. A maximum of six tool
rounds prevents an unbounded execution loop. Tool cards/results, model-provided thinking text and duration, and generation
stats are persisted with assistant messages. SQLite reloads reconstruct the same
message metadata. Display metadata is kept out of model prompts; tool results
are sent to the model only through the active tool loop.

`mcp:get-config` returns the saved config (or `{ mcpServers: {} }`).
`mcp:save-config` validates and atomically writes it, reloads connections, and
returns the saved config. The preload exposes these as
`window.api.getMcpConfig()` and `window.api.saveMcpConfig(config)`.

`mcp:get-tools` returns `{ tools, pluginTokens, toolTokens, tokenCountMethod }`.
`tools` includes memory and active MCP declarations. `mcp:get-status` adds server
status and the full discovered catalog; `mcp:set-tool-enabled` changes one tool.
`mcp:set-server-enabled` accepts `{ serverName, enabled }`.
`mcp:set-tool-enabled` accepts `{ serverName, name, enabled }` using an original
tool name, or the legacy `{ name, enabled }` using a namespaced tool name.
`mcp:set-all-tools-enabled` accepts `{ serverName, enabled }` for a single atomic
bulk update. Permission handlers return status, token counts, and the saved config.
`mcp:changed` refreshes the renderer after discovery, disconnection, or toggles.
`pluginTokens` counts active MCP schemas and `toolTokens` counts all declarations.
Both use `ceil(JSON.stringify(schemas).length / 4)`, with zero for no schemas.
These are schema-based estimates, not exact model-tokenizer or template costs.
The header includes memory declarations in total usage and shows MCP cost as
`Plugins +X`.

Checks:

```sh
node --test tests/mcpManager.test.cjs tests/mcpConfig.test.cjs tests/mcpPermissions.test.cjs tests/mcpSse.test.cjs tests/mcpIpc.test.cjs tests/memoryChat.test.mjs
npm run build
```

The manager test launches local SDK fixture servers and requires functioning
child-process stdin/stdout. The SSE test starts an authenticated local HTTP
fixture. No external MCP service or LLM is needed.

The Electron interaction test covers tabs and keyboard focus, server/tool/bulk
controls, status reasons, raw JSON validation, and deletion (run after building):

```sh
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/memorySettings.ui.cjs
```

Generation stats are collected independently for every model stream. The parser
merges numeric `usage` and llama-server `timings` fields through the final SSE
trailer/EOF. Complete tool-loop metrics are summed; server generation times are
summed to compute a weighted token rate. When a phase omits counts, the final
answer's metrics remain available and the footer labels them **Final phase**.
The completed `engine:chat` result includes `stats`, so saving does not depend
on receiving a separate final stats event.

`saveMessage(sessionId, role, content, attachments, stats, toolCalls, thinking,
messageId)` inserts by default. Supplying an existing assistant `messageId`
updates that row within the same session. Stats merge per field: new non-null
values (including zero) replace prior values; null/omitted metrics preserve them.
Tool/thinking metadata is retained when omitted. Rows from other sessions and
user messages cannot be updated through this path.
