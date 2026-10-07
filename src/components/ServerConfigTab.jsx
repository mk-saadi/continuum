import React, { useState } from 'react';
import DirectorySettings from './DirectorySettings';

export default function ServerConfigTab({ config: mcpConfig, busy: mcpBusy, onSave: saveMcpConfig, error: mcpError, onError: setMcpError }) {
  const mcpLoading = !mcpConfig;
  const busy = mcpBusy;
  const [serverName, setServerName] = useState('');
  const [serverCommand, setServerCommand] = useState('');
  const [serverArgs, setServerArgs] = useState('');
  const [connectionType, setConnectionType] = useState('stdio');
  const [serverUrl, setServerUrl] = useState('');
  const [serverHeaders, setServerHeaders] = useState('{}');
  const [rawEditing, setRawEditing] = useState(false);
  const [rawConfig, setRawConfig] = useState('');
  async function addMcpServer(event) {
    event.preventDefault();
    if (!mcpConfig || mcpBusy) return;
    const name = serverName.trim();
    if (!name) { setMcpError('Enter a server name.'); return; }
    if (Object.hasOwn(mcpConfig.mcpServers, name)) { setMcpError('A server with that name already exists.'); return; }
    let definition;
    if (connectionType === 'sse') {
      let headers;
      try { headers = JSON.parse(serverHeaders.trim() || '{}'); }
      catch { setMcpError('Headers must be valid JSON.'); return; }
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string')) {
        setMcpError('Headers must be a JSON object with string values.'); return;
      }
      if (!serverUrl.trim()) { setMcpError('Enter a server URL.'); return; }
      definition = { url: serverUrl.trim(), headers };
    } else {
      const command = serverCommand.trim();
      if (!command) { setMcpError('Enter a command.'); return; }
      definition = { command, args: serverArgs.split(',').map(arg => arg.trim()).filter(Boolean) };
    }
    const saved = await saveMcpConfig({ ...mcpConfig, mcpServers: { ...mcpConfig.mcpServers, [name]: definition } });
    if (saved) { setServerName(''); setServerCommand(''); setServerArgs(''); setServerUrl(''); setServerHeaders('{}'); }
  }

  function openRawEditor() {
    setRawConfig(JSON.stringify(mcpConfig, null, 2));
    setMcpError('');
    setRawEditing(true);
  }

  async function saveRawConfig(event) {
    event.preventDefault();
    let config;
    try { config = JSON.parse(rawConfig); }
    catch { setMcpError('Config must be valid JSON.'); return; }
    // Keep the draft intact on validation/write errors, and render only saved config.
    if (await saveMcpConfig(config)) setRawEditing(false);
  }

  return <div className="space-y-4">
    <DirectorySettings />
    <p className="text-xs text-[var(--text-secondary)]">Add a local process or remote SSE server, or edit the complete configuration.</p>
    {mcpError && <p role="alert" className="palace-error">{mcpError}</p>}
        {rawEditing ? <form className="palace-form" onSubmit={saveRawConfig}>
          <h3>Raw JSON Editor</h3>
          <label>MCP Configuration JSON<textarea rows={14} value={rawConfig} onChange={event => setRawConfig(event.target.value)}
            spellCheck={false} autoComplete="off" disabled={mcpBusy} /></label>
          <button className="palace-add" disabled={mcpBusy || busy}>{mcpBusy ? 'Saving…' : 'Save JSON'}</button>
          <button type="button" className="palace-add" disabled={mcpBusy} onClick={() => { setRawEditing(false); setMcpError(''); }}>Cancel</button>
        </form> : <>
          <button type="button" className="palace-add" onClick={openRawEditor} disabled={mcpLoading || mcpBusy || busy || !mcpConfig}>Raw JSON Editor</button>
          <form className="palace-form" onSubmit={addMcpServer}>
            <h3>Add MCP Server</h3>
            <fieldset disabled={mcpLoading || mcpBusy || !mcpConfig}>
              <legend>Connection Type</legend>
              <label className="palace-check"><input type="radio" name="mcp-connection-type" value="stdio" checked={connectionType === 'stdio'} onChange={() => setConnectionType('stdio')} />Local Process</label>
              <label className="palace-check"><input type="radio" name="mcp-connection-type" value="sse" checked={connectionType === 'sse'} onChange={() => setConnectionType('sse')} />Remote URL</label>
            </fieldset>
            <label>Server Name<input required value={serverName} onChange={event => setServerName(event.target.value)} placeholder={connectionType === 'sse' ? 'klikbase' : 'filesystem'} disabled={mcpLoading || mcpBusy || !mcpConfig} /></label>
            {connectionType === 'sse' ? <>
              <label>URL<input type="url" required value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://example.com/sse" disabled={mcpLoading || mcpBusy || !mcpConfig} /></label>
              <label>Headers<textarea rows={3} value={serverHeaders} onChange={event => setServerHeaders(event.target.value)} placeholder={'{"Authorization": "Bearer..."}'} spellCheck={false} autoComplete="off" disabled={mcpLoading || mcpBusy || !mcpConfig} /></label>
            </> : <>
              <label>Command<input required value={serverCommand} onChange={event => setServerCommand(event.target.value)} placeholder="npx or /path/to/python" disabled={mcpLoading || mcpBusy || !mcpConfig} /></label>
              <label>Args<input value={serverArgs} onChange={event => setServerArgs(event.target.value)} placeholder="-y, @modelcontextprotocol/server-filesystem, /path/to/folder" aria-describedby="mcp-args-hint" disabled={mcpLoading || mcpBusy || !mcpConfig} /></label>
              <p id="mcp-args-hint" className="palace-hint">Separate arguments with commas. Spaces within an argument are preserved.</p>
            </>}
            <button className="palace-add" disabled={mcpLoading || mcpBusy || busy || !mcpConfig || !serverName.trim() || !(connectionType === 'sse' ? serverUrl.trim() : serverCommand.trim())}>{mcpBusy ? 'Saving…' : 'Add MCP Server'}</button>
          </form>
        </>}
  </div>;
}
