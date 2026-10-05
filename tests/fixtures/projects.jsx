import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProjectsView from '../../src/components/ProjectsView';
import ProjectWorkspace from '../../src/components/ProjectWorkspace';
import ProjectModal from '../../src/components/ProjectModal';
import Sidebar from '../../src/components/Sidebar';
const records = [{ id: 'p1', name: 'Website', description: '**Launch** the site', custom_instructions: 'Keep it simple', root_path: '/work/site', is_pinned: 1, created_at: '2026-09-29 10:00:00', files: [] }];
window.api = {
  getProject: async id => structuredClone(records.find(p => p.id === id)),
  updateProject: async (id, patch) => { Object.assign(records.find(p => p.id === id), patch); return structuredClone(records.find(p => p.id === id)); },
  pickDirectory: async () => '/work/new-folder',
  selectDirectory: async () => '/work/new-folder',
  setProjectPinned: async (id, value) => window.api.updateProject(id, { is_pinned: Number(value) }),
  importProjectFiles: async (id, files) => { for (const file of files) records.find(p => p.id === id).files.push({ id: file.name, file_name: file.name, file_path: file.name, content: await file.text() }); },
  removeProjectFile: async id => { records.forEach(p => { p.files = p.files.filter(file => file.id !== id); }); },
};
function Fixture() {
  const [projects, setProjects] = useState(structuredClone(records));
  const [view, setView] = useState('projects');
  const [id, setId] = useState('p1');
  const [modal, setModal] = useState(false);
  const groups = [{ folder_name: 'Uncategorized', sessions: [{ id: 'c1', title: 'Project chat', project_id: 'p1' }, { id: 'g1', title: 'Global chat' }] }];
  const update = value => setProjects(old => old.map(p => p.id === value.id ? value : p));
  const open = id => { setId(id); setView('project'); };
  return <div style={{ height: '100vh', display: 'flex' }}>
    <Sidebar projects={projects} groups={groups} view={view} activeProjectId={id} onProjects={() => setView('projects')} onProject={open} onCreateProject={() => setModal(true)} onLoad={id => { window.loadedChat = id; }} onChat={() => setView('chat')} onNew={() => setView('chat')} onAction={async () => {}} />
    {view === 'projects' && <ProjectsView projects={projects} onCreate={() => setModal(true)} onOpen={open} onPin={async p => update(await window.api.setProjectPinned(p.id, !p.is_pinned))} />}
    {view === 'project' && <ProjectWorkspace key={id} projectId={id} sessions={groups[0].sessions} onBack={() => setView('projects')} onUpdated={update} onLoadChat={id => { window.loadedChat = id; }} canStartChat onStartChat={async (id, prompt) => { window.startedChat = { id, prompt }; }} />}
    {modal && <ProjectModal onClose={() => setModal(false)} onCreate={async fields => { window.createdProject = fields; const record = { ...fields, id: 'new', files: [] }; records.push(record); setProjects([...records]); setModal(false); open('new'); }} />}
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
