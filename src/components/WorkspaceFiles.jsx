import React, { useEffect, useRef, useState, useMemo } from 'react';
import { PrismAsync as SyntaxHighlighter } from 'react-syntax-highlighter';
import DiffReviewModal from './chat/DiffReviewModal.jsx';
import { syntaxTheme } from '../lib/syntaxTheme.mjs';
import { FiChevronDown, FiChevronRight, FiFile, FiFolder, FiRefreshCw, FiX } from 'react-icons/fi';

function fileLanguage(path) {
  const name = path.split('/').pop().toLowerCase();
  const extension = name.split('.').pop();
  if (/^(dockerfile|containerfile)(\.|$)/.test(name)) return 'docker';
  if (['.bashrc', '.zshrc', '.profile'].includes(name)) return 'bash';
  return ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
    md: 'markdown', mdx: 'markdown', py: 'python', pyw: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    sql: 'sql', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', diff: 'diff', patch: 'diff', ini: 'ini', conf: 'ini', ps1: 'powershell', r: 'r', lua: 'lua' })[extension] || 'text';
}

function Directory({ projectId, path = '.', depth = 0, selectedPath, onSelect, refresh, modified }) {
  const [state, setState] = useState({ loading: true });
  const [expanded, setExpanded] = useState({});
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    Promise.resolve().then(() => {
      if (!window.api?.listWorkspaceDirectory) throw new Error('File browsing requires the desktop app.');
      return window.api.listWorkspaceDirectory(projectId, path);
    }).then(result => { if (!cancelled) setState(result); }, error => { if (!cancelled) setState({ error: error.message }); });
    return () => { cancelled = true; };
  }, [projectId, path, refresh]);
  if (state.loading || state.error) return <p role={state.error ? 'alert' : 'status'} className="px-3 py-2 text-xs text-[var(--text-muted)]">{state.error || 'Loading files…'}</p>;
  return <ul aria-label={path === '.' ? 'Workspace files' : path}>
    {state.items.map(item => <li key={item.path}>
      <button type="button" title={item.path} aria-expanded={item.directory ? !!expanded[item.path] : undefined}
        aria-current={!item.directory && selectedPath === item.path ? 'true' : undefined}
        onClick={() => item.directory ? setExpanded(old => ({ ...old, [item.path]: !old[item.path] })) : onSelect(item.path)}
        style={{ paddingLeft: 12 + depth * 14 }}
        className={`flex w-full cursor-pointer items-center gap-2 py-1.5 pr-3 text-left text-xs hover:bg-[var(--surface-hover)] ${selectedPath === item.path ? 'bg-[var(--surface-hover)] text-[var(--accent)]' : ''}`}>
        {item.directory ? <>{expanded[item.path] ? <FiChevronDown className="shrink-0" /> : <FiChevronRight className="shrink-0" />}<FiFolder className="shrink-0 text-[var(--accent)]" /></> : <FiFile className="ml-5 shrink-0 text-[var(--text-muted)]" />}
        {!item.directory && modified.has(item.path) && <span aria-label="Modified" className="shrink-0 font-semibold text-[var(--warning)]">M</span>}
        <span className={`truncate ${!item.directory && modified.has(item.path) ? 'text-[var(--warning)]' : ''}`}>{item.name}</span>
      </button>
      {item.directory && expanded[item.path] && <Directory {...{ projectId, selectedPath, onSelect, refresh, modified }} path={item.path} depth={depth + 1} />}
    </li>)}
    {!state.items.length && <li className="px-3 py-2 text-xs text-[var(--text-muted)]">Empty folder</li>}
    {state.truncated && <li className="px-3 py-2 text-xs text-[var(--text-muted)]">Showing the first 2,000 entries.</li>}
  </ul>;
}

export const WorkspaceFiles = React.memo(function WorkspaceFiles({ projectId, projectName, selectedPath, onSelect, active = true }) {
  const [refresh, setRefresh] = useState(0);
  const [modified, setModified] = useState(new Set());
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    if (!active) return;
    async function loadStatus() {
      if (cancelled || document.hidden || pending || !window.api?.getWorkspaceGitStatus) return;
      pending = true;
      try {
        const result = await window.api.getWorkspaceGitStatus(projectId);
        if (!cancelled) {
          const next = new Set(result.connected ? result.modified : []);
          setModified(previous => previous.size === next.size && [...next].every(path => previous.has(path)) ? previous : next);
        }
      } catch { if (!cancelled) setModified(new Set()); }
      finally { pending = false; }
    }
    loadStatus();
    const timer = setInterval(loadStatus, 10000);
    window.addEventListener('focus', loadStatus);
    document.addEventListener('visibilitychange', loadStatus);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', loadStatus); document.removeEventListener('visibilitychange', loadStatus); };
  }, [projectId, refresh, active]);
  return <section className="flex h-full min-h-0 flex-col" aria-label="File explorer">
    <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3 text-xs font-medium">
      <FiFolder className="shrink-0" /><span className="min-w-0 flex-1 truncate">{projectName || 'Workspace'}</span>
      <button type="button" title="Refresh files" aria-label="Refresh files" onClick={() => setRefresh(value => value + 1)} className="cursor-pointer p-1"><FiRefreshCw /></button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto py-1"><Directory key={projectId} {...{ projectId, selectedPath, onSelect, refresh, modified }} /></div>
  </section>;
});

const HighlightedFile = React.memo(function HighlightedFile({ content, language }) {
  const large = content.length > 64 * 1024 || content.split('\n').length > 2000;
  if (large) return <><p role="status" className="px-4 py-2 text-xs text-[var(--code-muted)]">Large file: showing plain text to keep the preview responsive.</p><pre className="m-0 w-max min-w-full p-4 text-xs leading-6" style={{ userSelect: 'text' }}><code>{content}</code></pre></>;
  return <>{content ? <SyntaxHighlighter language={language} style={syntaxTheme} showLineNumbers
          customStyle={{ margin: 0, padding: '16px', background: 'transparent', minHeight: '100%', minWidth: '100%', width: 'max-content', fontSize: '12px', lineHeight: 2, fontFamily: 'var(--font-mono)', userSelect: 'text', WebkitUserSelect: 'text' }}
          codeTagProps={{ style: { fontFamily: 'inherit', userSelect: 'text', WebkitUserSelect: 'text' } }} lineNumberStyle={{ color: 'var(--code-muted)', paddingRight: '16px', userSelect: 'none' }}>
          {content}
        </SyntaxHighlighter> : <p className="p-4 text-xs text-[var(--code-muted)]">Empty file</p>}</>;
});

export const WorkspaceFilePreview = React.memo(function WorkspaceFilePreview({ projectId, sessionId, running = false, path, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [refresh, setRefresh] = useState(0);
  const [showDiff, setShowDiff] = useState(false);
  const [repository, setRepository] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setRepository(null);
    Promise.resolve().then(() => window.api.getWorkspaceRepository(projectId)).then(result => {
      if (!cancelled) { setRepository({ projectId, available: result.available }); if (!result.available) setShowDiff(false); }
    }, () => { if (!cancelled) { setRepository(null); setShowDiff(false); } });
    return () => { cancelled = true; };
  }, [projectId, refresh]);
  const gitAvailable = repository?.projectId === projectId && repository.available;
  useEffect(() => setShowDiff(false), [projectId, path]);
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    Promise.resolve().then(() => window.api.readWorkspaceFile(projectId, path)).then(
      result => { if (!cancelled) setState(result); },
      error => { if (!cancelled) setState({ error: error.message }); },
    );
    return () => { cancelled = true; };
  }, [projectId, path, refresh]);
  const diffPreview = useMemo(() => <DiffReviewModal key={`${sessionId}:${path}:${refresh}`} embedded sessionId={sessionId} filePath={path} running={running} onClose={() => setShowDiff(false)} />, [sessionId, path, refresh, running]);
  return <section aria-label="File preview" className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--surface)]">
    <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-3 text-xs">
      <FiFile className="shrink-0" /><span title={path} className="min-w-0 flex-1 truncate">{path}</span>
      {gitAvailable && <div role="group" aria-label="Preview mode" className="flex shrink-0 items-center gap-0.5 ui-radius-control border border-[var(--border)] p-0.5">
        {[['File', false], ['Git diff', true]].map(([label, active]) => <button key={label} type="button" aria-pressed={showDiff === active} onClick={() => setShowDiff(active)} className={`cursor-pointer ui-radius-control px-2 py-1 text-[11px] ${showDiff === active ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{label}</button>)}
      </div>}
      <span className="text-[var(--text-muted)]">Read only</span>
      <button type="button" aria-label="Refresh preview" onClick={() => setRefresh(value => value + 1)} className="cursor-pointer p-1"><FiRefreshCw /></button>
      <button type="button" aria-label="Close file preview" onClick={onClose} className="cursor-pointer p-1"><FiX /></button>
    </header>
    {showDiff && gitAvailable ? <div className="min-h-0 flex-1">{diffPreview}</div> : state.loading || state.error || state.binary ? <p role={state.error ? 'alert' : 'status'} className="p-4 text-sm text-[var(--text-muted)]">{state.error || (state.loading ? 'Loading preview…' : 'Preview is unavailable for this binary file.')}</p> : <>
      {state.truncated && <p role="status" className="px-3 py-2 text-xs text-[var(--text-muted)]">Showing the first 512 KB.</p>}
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--code-bg)] text-[var(--code-text)]" style={{ userSelect: 'text', WebkitUserSelect: 'text', WebkitAppRegion: 'no-drag' }}>
        <HighlightedFile content={state.content || ''} language={fileLanguage(path)} />
      </div>
    </>}
  </section>;
});

export function WorkspaceSplit({ children, preview, visible = true }) {
  const root = useRef(null);
  const [width, setWidth] = useState(40);
  function resize(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  return <div ref={root} style={visible ? undefined : { display: 'none' }} className="workspace-split flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
    <div className="order-3 flex min-h-0 min-w-0 flex-1">{children}</div>
    {preview && <>
      <div role="separator" aria-label="Resize chat and file preview" aria-orientation="vertical" tabIndex={0} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(width)}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setWidth(value => Math.max(25, Math.min(75, value + (event.key === 'ArrowLeft' ? -5 : 5)))); } }}
        onPointerDown={resize} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = root.current.getBoundingClientRect(); setWidth(Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100))); } }}
        onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
        className="relative order-2 w-px shrink-0 touch-none cursor-col-resize bg-[var(--border)] hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)]">
        <span aria-hidden="true" className="absolute inset-y-0 -left-1 w-2" />
      </div>
      <div className="order-1 min-h-0 min-w-0 overflow-hidden" style={{ flex: `0 0 ${width}%` }}>{preview}</div>
    </>}
  </div>;
}
