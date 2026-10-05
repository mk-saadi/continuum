import React, { useEffect, useState } from 'react';

export default function SkillsSettingsTab() {
  const [skills, setSkills] = useState([]);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const [items, config] = await Promise.all([window.api.listSkills(), window.api.getAppSettings()]);
    setSkills(items); setSettings(config);
  }
  useEffect(() => { refresh().catch(err => setError(err.message)); }, []);
  async function action(run) {
    setBusy(true); setError('');
    try { await run(); await refresh(); } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h4 className="font-semibold">Global Skills</h4><p className="text-xs text-[var(--text-muted)]">Available across projects when active.</p></div>
      <button className="project-button primary" disabled={busy} onClick={() => action(() => window.api.importSkill())}>Import Skill</button></div>
    {error && <p role="alert" className="project-error">{error}</p>}
    {!settings ? <p role="status">Loading skills…</p> : !skills.length ? <p className="text-sm text-[var(--text-muted)]">No skills imported yet.</p> : skills.map(skill =>
      <div key={skill.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h5 className="font-medium">{skill.title}</h5><p className="text-xs text-[var(--text-muted)]">{skill.description}</p><code className="text-xs">@{skill.id}</code></div>
          <div className="flex shrink-0 items-center gap-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" role="switch" checked={skill.active} disabled={busy} onChange={event => action(() => window.api.saveAppSettings({ disabledSkills: event.target.checked ? settings.disabledSkills.filter(id => id !== skill.id) : [...settings.disabledSkills, skill.id] }))} />{skill.active ? 'Active' : 'Inactive'}</label>
            <button className="project-button" disabled={busy} aria-label={`Delete ${skill.title}`} onClick={() => action(() => window.api.deleteSkill(skill.id))}>Delete</button></div></div>
      </div>)}
  </div>;
}
