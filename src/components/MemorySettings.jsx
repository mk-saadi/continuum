import RagSettings from './RagSettings';
import LocalApiSettings from './LocalApiSettings';
import AvatarSettings from './AvatarSettings';
import React, { useEffect, useRef, useState } from 'react';
import MemoryTab from './MemoryTab';
import IntegrationsTab from './IntegrationsTab';
import ServerConfigTab from './ServerConfigTab';
import { SettingsIcon } from './SettingsIcon';

const tabs = [
  { id: 'avatars', label: 'Avatars & Branding' },
  { id: 'memory', label: '🧠 Memory Palace' },
  { id: 'integrations', label: '🔌 MCP Integrations' },
  { id: 'config', label: '⚙️ Server Config' },
];

export default function MemorySettings({ palace, onClose, avatars, models }) {
  const dialog = useRef(null);
  const tabButtons = useRef([]);
  const changing = useRef(false);
  const version = useRef(0);
  const [tab, setTab] = useState('memory');
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const request = ++version.current;
      try {
        if (!window.api?.getMcpConfig) throw new Error('Open the desktop app to manage MCP servers.');
        const value = await window.api.getMcpConfig();
        if (active && request === version.current) setConfig(value);
      } catch (err) { if (active && request === version.current) setError(err.message); }
      finally { if (active && request === version.current) setLoading(false); }
    }
    const unsubscribe = window.mcpAPI?.onChanged(refresh);
    refresh();
    return () => { active = false; unsubscribe?.(); };
  }, []);

  async function change(action) {
    if (changing.current) return false;
    changing.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      ++version.current;
      setConfig(result.config || result);
      setLoading(false);
      return true;
    } catch (err) { setError(err.message); return false; }
    finally { changing.current = false; setBusy(false); }
  }

  function onTabKey(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next].id);
    tabButtons.current[next]?.focus();
  }

  return <dialog ref={dialog} className="palace-dialog" aria-labelledby="memory-settings-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
      <h2 id="memory-settings-title" className="font-semibold">Settings</h2>
      <button type="button" className="palace-icon" aria-label="Close memory settings" onClick={onClose} autoFocus><SettingsIcon name="close" /></button>
    </div>
    <div role="tablist" aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] px-3">
      {tabs.map(({ id, label }, index) => <button key={id} ref={element => { tabButtons.current[index] = element; }}
        type="button" role="tab" id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} aria-selected={tab === id}
        tabIndex={tab === id ? 0 : -1} onKeyDown={event => onTabKey(event, index)} onClick={() => setTab(id)}
        className={`shrink-0 border-b-2 px-2 py-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-violet-500 ${tab === id ? 'border-violet-500 text-violet-700 dark:text-violet-300' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{label}</button>)}
    </div>
    <section id="settings-panel-avatars" role="tabpanel" aria-labelledby="settings-tab-avatars" hidden={tab !== 'avatars'} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
      <AvatarSettings avatars={avatars} models={models} />
    </section>
    <section id="settings-panel-memory" role="tabpanel" aria-labelledby="settings-tab-memory" hidden={tab !== 'memory'} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
      <MemoryTab palace={palace} />
    </section>
    <section id="settings-panel-integrations" role="tabpanel" aria-labelledby="settings-tab-integrations" hidden={tab !== 'integrations'} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-4 text-xs" aria-busy={busy}>
      {loading ? <p role="status">Loading MCP servers…</p> : config ? <IntegrationsTab config={config} status={palace.mcpStatus} busy={busy} error={error}
        onConfigure={() => setTab('config')}
        onServerToggle={(name, enabled) => change(() => window.mcpAPI.setServerEnabled(name, enabled))}
        onToolToggle={(name, tool, enabled) => change(() => window.mcpAPI.setToolEnabled(tool, enabled, name))}
        onAllToolsToggle={(name, enabled) => change(() => window.mcpAPI.setAllToolsEnabled(name, enabled))}
        onDelete={name => change(() => {
          const servers = { ...config.mcpServers };
          delete servers[name];
          return window.api.saveMcpConfig({ ...config, mcpServers: servers });
        })} /> : <p role="alert" className="palace-error">{error}</p>}
    </section>
    <section id="settings-panel-config" role="tabpanel" aria-labelledby="settings-tab-config" hidden={tab !== 'config'} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-4 text-xs" aria-busy={busy}>
      <LocalApiSettings />
      <RagSettings />
      {loading ? <p role="status">Loading configuration…</p> : <ServerConfigTab config={config} busy={busy} error={error} onError={setError} onSave={value => change(() => window.api.saveMcpConfig(value))} />}
    </section>
  </dialog>;
}
