import React, { useEffect, useState } from 'react';

export default function ProjectSkillsCard({ project, onUpdated }) {
  const [skills, setSkills] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { window.api.listSkills().then(setSkills).catch(err => setError(err.message)); }, [project.id, open]);
  const enabled = new Set(project.enabledSkills || []);
  const active = skills.filter(skill => skill.active);
  async function action(run) {
    setBusy(true); setError('');
    try { await run(); setSkills(await window.api.listSkills()); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function toggle(id) {
    const next = enabled.has(id) ? [...enabled].filter(value => value !== id) : [...enabled, id];
    await action(async () => onUpdated(await window.api.updateProject(project.id, { enabledSkills: next })));
  }
  async function importNew(pick) {
    await action(async () => {
      const skill = pick === 'folder' ? await window.api.importSkillFolder(project.id) : await window.api.importSkill(project.id);
      if (skill) onUpdated(await window.api.getProject(project.id));
    });
  }
  return <section className="project-panel"><h2>Project Skills <span className="projects-muted">({active.filter(skill => enabled.has(skill.id)).length})</span></h2>
    {active.filter(skill => enabled.has(skill.id)).map(skill => <p key={skill.id} className="text-sm">{skill.title}</p>)}
    {!active.some(skill => enabled.has(skill.id)) && <p className="projects-muted">No active skills selected.</p>}
    <button className="project-button mt-4" onClick={() => setOpen(true)}>Manage Project Skills</button>
    {error && <p role="alert" className="project-error">{error}</p>}
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label="Manage Project Skills" className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-5 shadow-xl">
        <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">Manage Project Skills</h3><button className="project-button" onClick={() => setOpen(false)}>Close</button></div>
        <p className="projects-muted my-3">Select globally active skills for this project.</p>
        <div className="max-h-72 space-y-2 overflow-auto">{active.map(skill => <label key={skill.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3"><input type="checkbox" checked={enabled.has(skill.id)} disabled={busy} onChange={() => toggle(skill.id)} /><span><strong>{skill.title}</strong><small className="block text-[var(--text-muted)]">{skill.description}</small></span></label>)}
          {!active.length && <p className="projects-muted">No globally active skills. Import one to begin.</p>}</div>
        <div className="mt-4 flex gap-2">
          <button className="project-button primary" disabled={busy} title="Import a .md or .zip skill file" onClick={() => importNew()}>Import Skill File</button>
          <button className="project-button" disabled={busy} title="Import a folder containing SKILL.md" onClick={() => importNew('folder')}>Import Skill Folder</button>
        </div>
      </div></div>}
  </section>;
}
