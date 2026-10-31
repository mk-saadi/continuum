import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckboxField } from '../FormControls';

export default function ProjectSkillsCard({ project, onUpdated }) {
  const dialogRef = useRef(null);
  const [skills, setSkills] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [open]);
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
  return <section className="aero-panel project-panel"><h2>Project Skills <span className="projects-muted">({active.filter(skill => enabled.has(skill.id)).length})</span></h2>
    {active.filter(skill => enabled.has(skill.id)).map(skill => <p key={skill.id} className="text-sm">{skill.title}</p>)}
    {!active.some(skill => enabled.has(skill.id)) && <p className="projects-muted">No active skills selected.</p>}
    <button className="aero-control aero-fill inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium cursor-pointer mt-4" onClick={() => setOpen(true)}>Manage Project Skills</button>
    {error && <p role="alert" className="project-error">{error}</p>}
    {open && createPortal(<dialog ref={dialogRef} aria-label="Manage Project Skills" className="aero-dialog m-auto w-[calc(100%-32px)] max-w-lg p-5" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
    }}>
        <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">Manage Project Skills</h3><button className="aero-control aero-fill inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium cursor-pointer" onClick={() => setOpen(false)}>Close</button></div>
        <p className="projects-muted my-3">Select globally active skills for this project.</p>
        <div className="max-h-72 space-y-2 overflow-auto">{active.map(skill => <CheckboxField key={skill.id} label={skill.title} hint={skill.description} checked={enabled.has(skill.id)} disabled={busy} onChange={() => toggle(skill.id)} />)}
          {!active.length && <p className="projects-muted">No globally active skills. Import one to begin.</p>}</div>
        <div className="mt-4 flex gap-2">
          <button className="aero-primary inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold cursor-pointer" disabled={busy} title="Import a .md or .zip skill file" onClick={() => importNew()}>Import Skill File</button>
          <button className="aero-control aero-fill inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium cursor-pointer" disabled={busy} title="Import a folder containing SKILL.md" onClick={() => importNew('folder')}>Import Skill Folder</button>
        </div>
      </dialog>, document.body)}
  </section>;
}
