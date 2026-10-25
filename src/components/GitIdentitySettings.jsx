import React, { useEffect, useState } from 'react';
import { LuGitBranch } from 'react-icons/lu';
import { TextField } from './FormControls';
import { SettingsButton, SettingsCard, SettingsHint, SettingsMessage } from './settings/SettingsSection';

export default function GitIdentitySettings() {
  const [identity, setIdentity] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    window.api.getConfig().then(config => { if (active) setIdentity(config.gitIdentity); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  return <SettingsCard icon={LuGitBranch} title="Git identity" description="Name and email used for commits made by Continuum.">
    <form className="space-y-3" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); setNotice('');
      try {
        const config = await window.api.setGitIdentity(identity);
        setIdentity(config.gitIdentity); setNotice('Git identity saved.');
      } catch (error) { setError(error.message); } finally { setBusy(false); }
    }}>
      <TextField label="Git name" value={identity?.name ?? ''} disabled={busy || !identity} maxLength={320}
        onChange={event => setIdentity(current => ({ ...current, name: event.target.value }))} />
      <TextField label="Git email" type="email" value={identity?.email ?? ''} disabled={busy || !identity} maxLength={320}
        onChange={event => setIdentity(current => ({ ...current, email: event.target.value }))} />
      <SettingsHint>Repository identity takes priority. Leave a field blank to use global Git identity captured when Continuum starts.</SettingsHint>
      <SettingsButton type="submit" disabled={busy || !identity}>{busy ? 'Saving…' : 'Save identity'}</SettingsButton>
      <SettingsMessage>{error}</SettingsMessage>
      <SettingsMessage tone="success">{notice}</SettingsMessage>
    </form>
  </SettingsCard>;
}
