import React, { useEffect, useRef, useState } from 'react';
import { LuDatabase, LuFolder } from 'react-icons/lu';
import { SettingsButton, SettingsCard, SettingsMessage } from './settings/SettingsSection';

const destinations = [
  { key: 'modelDirectory', title: 'Model Directory', icon: LuFolder },
  { key: 'appDataDirectory', title: 'App Data Directory', icon: LuDatabase },
];

export default function DirectorySettings() {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [error, setError] = useState('');
  const overlay = useRef(null);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => window.api.getConfig()).then(value => { if (active) setConfig(value); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (migrating) overlay.current.showModal();
    else overlay.current.close();
  }, [migrating]);
  async function change(key) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const directory = await window.api.pickDirectory();
      if (!directory) return;
      if (key === 'modelDirectory') {
        const modelDirectory = await window.api.setModelDirectory(directory);
        setConfig(previous => ({ ...previous, modelDirectory }));
        window.dispatchEvent(new Event('model-directory-changed'));
      } else {
        setMigrating(true);
        const result = await window.api.migrateAppData(directory);
        if (!result.success) throw new Error(result.error || 'Migration failed.');
        setConfig(result.config);
        if (result.warning) window.alert(result.warning);
        // Reload cached session/attachment paths after the backend switches roots.
        window.location.reload();
      }
    } catch (err) { setError(err.message); }
    finally { setBusy(false); setMigrating(false); }
  }
  return (
    <div className="space-y-3">
      {destinations.map(({ key, title, icon: Icon }) => (
        <SettingsCard key={key} icon={Icon} title={title}>
          <p className="break-all rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--text-secondary)]">
            {config?.[key] || 'Loading…'}
          </p>
          {key === 'appDataDirectory' && (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              SQLite, RAG vectors, attachments, embedding models, and avatars. Choose an empty folder. Settings will reload after migration.
            </p>
          )}
          <div className="mt-3">
            <SettingsButton type="button" disabled={busy || !config} onClick={() => change(key)}>
              Change Directory
            </SettingsButton>
          </div>
        </SettingsCard>
      ))}
      <SettingsCard icon={LuFolder} title="Extra read-only runtime paths">
        <p className="text-xs">Expose additional SDK or compiler installation directories to contained commands. Never select a home or credentials directory.</p>
        {(config?.extraReadOnlyRuntimePaths ?? []).map(runtime => <div key={runtime} className="my-2 break-all text-xs">
          {runtime} <SettingsButton disabled={busy} onClick={async () => {
            try { setConfig(await window.api.setRuntimePaths(config.extraReadOnlyRuntimePaths.filter(p => p !== runtime))); }
            catch (err) { setError(err.message); }
          }}>Remove</SettingsButton>
        </div>)}
        <SettingsButton disabled={busy || !config} onClick={async () => {
          setBusy(true);
          try { const directory = await window.api.pickDirectory();
            if (directory) setConfig(await window.api.setRuntimePaths([...(config.extraReadOnlyRuntimePaths ?? []), directory]));
          } catch (err) { setError(err.message); } finally { setBusy(false); }
        }}>Add runtime directory</SettingsButton>
      </SettingsCard>
      <SettingsMessage>{error}</SettingsMessage>
      <dialog ref={overlay} onCancel={event => event.preventDefault()}
        className="fixed inset-0 m-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
        <div role="status" aria-live="polite" className="flex items-center gap-3 text-xs">
          <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          Migrating app data. Do not close the application...
        </div>
      </dialog>
    </div>
  );
}
