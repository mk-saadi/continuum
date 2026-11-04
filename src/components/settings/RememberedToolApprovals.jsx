import React, { useEffect, useState } from 'react';
import { LuShieldCheck } from 'react-icons/lu';
import { SettingsCard } from './SettingsSection';

export default function RememberedToolApprovals() {
  const [rules, setRules] = useState([]);
  const [error, setError] = useState('');
  const refresh = () => window.chatAPI.listToolRules(null).then(setRules);
  useEffect(() => { refresh().catch(cause => setError(cause.message)); }, []);
  async function revoke(id) {
    try { await window.chatAPI.deleteToolRule(null, id); await refresh(); }
    catch (cause) { setError(cause.message); }
  }
  return <SettingsCard icon={LuShieldCheck} title="Remembered Tool Approvals"
    description="Persistent terminal authorizations for Casual Chat. Read Only restrictions still apply. Enabled external integrations are managed in MCP settings.">
    {rules.length ? rules.map(rule => <div key={rule.id} className="flex items-center justify-between gap-3 py-2">
      <div><p>{rule.tool}</p><p className="text-xs text-[var(--text-secondary)]">Casual Chat · Persistent</p></div>
      <button type="button" className="ui-radius-control border px-3 py-1.5" onClick={() => revoke(rule.id)}>Revoke</button>
    </div>) : <p className="text-sm">No remembered tool approvals.</p>}
    {error && <p role="alert">{error}</p>}
  </SettingsCard>;
}
