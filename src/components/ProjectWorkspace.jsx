import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FiArrowLeft, FiFileText, FiFolder, FiMessageSquare, FiStar, FiTrash2, FiUpload } from 'react-icons/fi';
import { projectDate } from './ProjectsView';
import ProjectSkillsCard from './project/ProjectSkillsCard';
import './projects.css';

export default function ProjectWorkspace({ projectId, sessions = [], onBack, onUpdated, onLoadChat, onStartChat, chatDisabled, canStartChat }) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [instructions, setInstructions] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState(0);
  const input = useRef(null);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    window.api.getProject(projectId).then(value => {
      if (!active) return;
      setProject(value); setName(value.name); setGoal(value.description || ''); setInstructions(value.custom_instructions || '');
    }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, version]);
  async function perform(task) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await task(); } catch (err) { setError(err.message); } finally { lock.current = false; setBusy(false); }
  }
  async function save(patch) {
    const updated = await window.api.updateProject(projectId, patch);
    setProject(updated); onUpdated(updated);
  }
  async function changeFolder() {
    await perform(async () => {
      try {
        const selectedPath = await window.api.selectDirectory();
        if (!selectedPath) return;
        const previousPath = project.root_path;
        setProject(previous => ({ ...previous, root_path: selectedPath }));
        try {
          await save({ root_path: selectedPath });
        } catch (error) {
          setProject(previous => ({ ...previous, root_path: previousPath }));
          throw error;
        }
      } catch (error) {
        console.error('Failed to change project root directory:', error);
        throw error;
      }
    });
  }
  async function upload(files) {
    if (!files.length) return;
    await perform(async () => {
      await window.api.importProjectFiles(projectId, files);
      const updated = await window.api.getProject(projectId);
      setProject(updated); onUpdated(updated);
    });
  }
  const chats = sessions.filter(session => session.project_id === projectId).sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return <main className="projects-page" aria-label="Project workspace"><div className="projects-content">
    <button className="project-button mb-6" onClick={onBack}><FiArrowLeft /> All Projects</button>
    {error && <p className="project-error" role="alert">{error} {!project && <button className="project-button" onClick={() => setVersion(value => value + 1)}>Retry</button>}</p>}
    {loading ? <p role="status">Loading project…</p> : project && <>
      <header className="projects-heading"><div className="min-w-0"><p className="projects-muted mb-2">PROJECT WORKSPACE</p><h1 className="break-words">{project.name}</h1></div>
        <button className="project-button" aria-pressed={!!project.is_pinned} disabled={busy} onClick={() => perform(async () => { const updated = await window.api.setProjectPinned(projectId, !project.is_pinned); setProject(updated); onUpdated(updated); })}><FiStar fill={project.is_pinned ? 'currentColor' : 'none'} />{project.is_pinned ? 'Pinned' : 'Pin Project'}</button></header>
      <div className="project-hub"><div className="project-stack">
        <section className="project-panel"><div className="flex justify-between items-center gap-4"><h2>Project Goal</h2>{!editing && <button className="project-button" disabled={busy} onClick={() => setEditing(true)}>Edit Goal</button>}</div>
          {editing ? <form onSubmit={event => { event.preventDefault(); perform(async () => { await save({ name, description: goal }); setEditing(false); }); }}>
            <label className="project-field mb-3">Project Title<input required className="project-input" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
            <label className="project-field">Goal (Markdown)<textarea className="project-input" rows={6} value={goal} disabled={busy} onChange={event => setGoal(event.target.value)} /></label>
            <div className="project-actions"><button type="button" className="project-button" disabled={busy} onClick={() => { setName(project.name); setGoal(project.description || ''); setEditing(false); }}>Cancel</button><button className="project-button primary" disabled={busy || !name.trim()}>Save Goal</button></div>
          </form> : <div className="project-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{project.description || 'Add a goal to help guide every conversation in this project.'}</ReactMarkdown></div>}
        </section>
        <section className="project-panel"><h2>Start New Chat in Project</h2><form onSubmit={event => { event.preventDefault(); perform(() => onStartChat(projectId, prompt)); }}>
          <label className="project-field"><span className="sr-only">New project chat prompt</span><textarea className="project-input" placeholder="What would you like to work on?" value={prompt} disabled={busy || chatDisabled} onChange={event => setPrompt(event.target.value)} /></label>
          {!canStartChat && <p className="projects-muted mt-3">Select and start a model to begin chatting.</p>}
          <div className="project-actions"><button className="project-button primary" disabled={busy || chatDisabled || !canStartChat || !prompt.trim()}><FiMessageSquare /> Start New Chat</button></div>
        </form></section>
        <section className="project-panel"><h2>Recent Chats <span className="projects-muted">({chats.length})</span></h2>
          {chats.length ? chats.map(chat => <button className="project-chat disabled:opacity-40" disabled={chatDisabled || busy} key={chat.id} onClick={() => onLoadChat(chat.id)}><FiMessageSquare /><span>{chat.title || 'Untitled chat'}</span><time className="projects-muted">{projectDate(chat.last_active_at)}</time></button>) : <p className="projects-muted">No conversations yet. Start with a question above.</p>}
        </section>
      </div><aside className="project-stack" aria-label="Project controls">
        <details className="project-panel" open><summary>Custom Instructions</summary><form onSubmit={event => { event.preventDefault(); perform(() => save({ custom_instructions: instructions })); }}>
          <label className="project-field"><span className="projects-muted">Applied to every chat in this project.</span><textarea aria-label="Custom Instructions" className="project-input" rows={5} value={instructions} disabled={busy} onChange={event => setInstructions(event.target.value)} placeholder="How should the assistant approach this work?" /></label>
          <div className="project-actions"><button className="project-button" disabled={busy || instructions === (project.custom_instructions || '')}>Save Instructions</button></div>
        </form></details>
        <section className="project-panel"><h2>Context Files <span className="projects-muted">({project.files.length})</span></h2>
          <div className="project-drop" data-dragging={dragging} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) upload(Array.from(event.dataTransfer.files)); }}>
            <FiUpload className="mx-auto mb-2" /><p className="projects-muted">Drop reference files here</p><button className="project-button mt-3" disabled={busy} onClick={() => input.current.click()}>Choose Files</button><p className="projects-muted mt-2">Text, Markdown, code, or PDF · up to 20 MB each</p>
            <input ref={input} type="file" multiple className="hidden" aria-label="Upload project context files" accept=".txt,.md,.pdf,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.toml,.ini,.sql,.log,.mjs,.cjs,.sh,.tsv,.c,.h,.cpp,.java,.go,.rs,.rb,.php" onChange={event => { const files = Array.from(event.target.files); event.target.value = ''; upload(files); }} />
          </div>
          {project.files.map(file => <div className="project-file" key={file.id}><FiFileText /><span title={file.file_path}>{file.file_name}</span><button className="project-button" aria-label={`Remove ${file.file_name}`} disabled={busy} onClick={() => perform(async () => { await window.api.removeProjectFile(file.id); setProject(previous => ({ ...previous, files: previous.files.filter(item => item.id !== file.id) })); })}><FiTrash2 /></button></div>)}
        </section>
        <ProjectSkillsCard project={project} onUpdated={updated => { setProject(updated); onUpdated(updated); }} />
        <section className="project-panel"><h2 className="flex items-center gap-2"><FiFolder /> Root Directory</h2><span className="project-path" title={project.root_path || ''}>{project.root_path || 'No folder connected'}</span><p className="projects-muted mt-3">Connect your working folder to include repository guidelines and workspace context.</p><button className="project-button mt-4" disabled={busy} onClick={changeFolder}>{project.root_path ? 'Change Folder' : 'Connect Folder'}</button></section>
      </aside></div>
    </>}
  </div></main>;
}
