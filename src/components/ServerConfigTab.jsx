import React, { useState } from 'react';
import { LuFileJson, LuPlugZap } from 'react-icons/lu';
import { SelectField, TextAreaField, TextField } from './FormControls';
import {
  SettingsButton,
  SettingsCard,
  SettingsHint,
  SettingsMessage,
} from './settings/SettingsSection';

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

  return <div className="space-y-3">
    <SettingsMessage>{mcpError}</SettingsMessage>
    {rawEditing ? (
      <SettingsCard
        as="form"
        icon={LuFileJson}
        title="Raw JSON editor"
        description="Edit the complete MCP configuration. The saved file is replaced only after it parses."
        onSubmit={saveRawConfig}
        className="space-y-3"
      >
        <TextAreaField
          label="MCP Configuration JSON"
          rows={14}
          value={rawConfig}
          onChange={event => setRawConfig(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={mcpBusy}
          inputClassName="font-mono"
        />
        <div className="flex items-center gap-2">
          <SettingsButton type="submit" variant="primary" disabled={mcpBusy || busy}>{mcpBusy ? 'Saving…' : 'Save JSON'}</SettingsButton>
          <SettingsButton type="button" disabled={mcpBusy} onClick={() => { setRawEditing(false); setMcpError(''); }}>Cancel</SettingsButton>
        </div>
      </SettingsCard>
    ) : <>
      <SettingsCard
        icon={LuPlugZap}
        title="Add MCP server"
        description="Add a local process or remote SSE server, or edit the complete configuration as JSON."
        action={
          <SettingsButton type="button" onClick={openRawEditor} disabled={mcpLoading || mcpBusy || busy || !mcpConfig}>
            Raw JSON Editor
          </SettingsButton>
        }
      >
        <form className="space-y-3" onSubmit={addMcpServer}>
          <SelectField label="Connection Type" value={connectionType} onChange={event => setConnectionType(event.target.value)} disabled={mcpLoading || mcpBusy || !mcpConfig}>
            <option value="stdio">Local Process</option>
            <option value="sse">Remote URL</option>
          </SelectField>
          <TextField label="Server Name" required value={serverName} onChange={event => setServerName(event.target.value)} placeholder={connectionType === 'sse' ? 'klikbase' : 'filesystem'} disabled={mcpLoading || mcpBusy || !mcpConfig} />
          {connectionType === 'sse' ? <>
            <TextField label="URL" type="url" required value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://example.com/sse" disabled={mcpLoading || mcpBusy || !mcpConfig} />
            <TextAreaField label="Headers" rows={3} value={serverHeaders} onChange={event => setServerHeaders(event.target.value)} placeholder={'{"Authorization": "Bearer..."}'} spellCheck={false} autoComplete="off" disabled={mcpLoading || mcpBusy || !mcpConfig} />
          </> : <>
            <TextField label="Command" required value={serverCommand} onChange={event => setServerCommand(event.target.value)} placeholder="npx or /path/to/python" disabled={mcpLoading || mcpBusy || !mcpConfig} />
            <TextField label="Args" value={serverArgs} onChange={event => setServerArgs(event.target.value)} placeholder="-y, @modelcontextprotocol/server-filesystem, /path/to/folder" disabled={mcpLoading || mcpBusy || !mcpConfig} />
            <SettingsHint>Separate arguments with commas. Spaces within an argument are preserved.</SettingsHint>
          </>}
          <SettingsButton type="submit" variant="primary" disabled={mcpLoading || mcpBusy || busy || !mcpConfig || !serverName.trim() || !(connectionType === 'sse' ? serverUrl.trim() : serverCommand.trim())}>{mcpBusy ? 'Saving…' : 'Add MCP Server'}</SettingsButton>
        </form>
      </SettingsCard>
    </>}
  </div>;
}
