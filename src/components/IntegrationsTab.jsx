import React from 'react';
import { SettingsIcon } from './SettingsIcon';

export default function IntegrationsTab({ config, status, busy, error, onServerToggle, onToolToggle, onAllToolsToggle, onDelete, onConfigure }) {
  const servers = Object.entries(config.mcpServers);
  return <div className="space-y-4">
    <div>
      <h3 className="text-sm font-semibold">MCP Integrations</h3>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">Choose which servers and tools your assistant can use.</p>
    </div>
    {(error || status.error) && <p role="alert" className="palace-error">{error || status.error}</p>}
    {!servers.length && <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center">
      <p className="text-sm">No MCP servers configured.</p>
      <button type="button" className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs text-white" onClick={onConfigure}>Add a server</button>
    </div>}
    {servers.map(([name, definition]) => {
      const server = status.servers.find(server => server.name === name);
      const enabled = definition?.disabled !== true && definition?.enabled !== false;
      const tools = server?.tools || [];
      const disabledTools = new Set(definition?.disabledTools || []);
      const allEnabled = tools.length > 0 && tools.every(tool => !disabledTools.has(tool.label));
      const failed = enabled && (server?.status === 'error' || Boolean(server?.error));
      const connected = enabled && server?.status === 'connected' && !failed;
      const badge = !enabled ? '○ Disabled' : failed ? `⚠ Error: ${server.error || 'Connection failed'}` : connected ? '● Connected' : server?.status === 'connecting' ? '◌ Connecting…' : '○ Disconnected';
      return <article key={name} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-start gap-3 p-3">
          <button type="button" role="switch" aria-checked={enabled} aria-label={`Enable server ${name}`} disabled={busy}
            onClick={() => onServerToggle(name, !enabled)}
            className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-50 ${enabled ? 'bg-violet-600' : 'bg-slate-500'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'left-0.5 translate-x-4' : 'left-0.5'}`} />
          </button>
          <div className="min-w-0 flex-1">
            <h4 className="break-words text-sm font-semibold">{name.startsWith('mcp/') ? name : `mcp/${name}`}</h4>
            <span role="status" className={`mt-1 inline-block max-w-full rounded-md px-2 py-0.5 text-[11px] break-words ${failed ? 'bg-red-500/10 text-red-700 dark:text-red-300' : connected ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-slate-500/10 text-[var(--text-secondary)]'}`}>{badge}</span>
          </div>
          <button type="button" className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
            aria-label={`Delete MCP server: ${name}`} title={`Delete ${name}`} disabled={busy} onClick={() => onDelete(name)}><SettingsIcon name="delete" /></button>
        </div>
        <details className="border-t border-[var(--border)]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Tools <span className="ml-1 text-[var(--text-secondary)]">{tools.length}</span></summary>
          <div className="space-y-2 px-3 pb-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[var(--text-secondary)]">{tools.filter(tool => !disabledTools.has(tool.label)).length} of {tools.length} permitted</span>
              <button type="button" className="rounded px-2 py-1 text-violet-700 hover:bg-violet-500/10 disabled:opacity-50 dark:text-violet-300"
                disabled={busy || !tools.length} onClick={() => onAllToolsToggle(name, !allEnabled)}>{allEnabled ? 'Disable All' : 'Enable All'}</button>
            </div>
            {!tools.length && <p className="text-xs text-[var(--text-secondary)]">{enabled ? 'No tools discovered.' : 'Enable this server to discover its tools.'}</p>}
            {tools.map(tool => <label key={tool.name} className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
              <input type="checkbox" className="accent-violet-600" checked={!disabledTools.has(tool.label)} disabled={busy}
                onChange={event => onToolToggle(name, tool.label, event.target.checked)} />
              <span className="break-all font-mono">{tool.label}</span>
            </label>)}
          </div>
        </details>
      </article>;
    })}
  </div>;
}
