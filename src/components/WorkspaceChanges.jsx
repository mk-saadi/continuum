import React, { useEffect, useMemo, useRef, useState } from 'react';

import { PrismAsync as SyntaxHighlighter } from 'react-syntax-highlighter';
import { syntaxTheme } from '../lib/syntaxTheme.mjs';
import { observeChangeSection } from '../lib/observeChangeSections.mjs';
import { loadWorkspaceDiffs } from '../lib/loadWorkspaceDiffs.mjs';

const languages = { js:'javascript', jsx:'jsx', mjs:'javascript', cjs:'javascript', ts:'typescript', tsx:'tsx', py:'python', json:'json', css:'css', scss:'scss', html:'markup', svg:'markup', xml:'markup', md:'markdown', sh:'bash', yml:'yaml', yaml:'yaml', rs:'rust', go:'go', c:'c', cpp:'cpp', java:'java', rb:'ruby', sql:'sql' };

const HighlightedDiff = React.memo(function HighlightedDiff({ diff, path, wrap }) {
  const lines = useMemo(() => diff.text.split('\n'), [diff.text]);
  const content = useMemo(() => lines.map(line => diff.untracked || /^(diff |index |---|\+\+\+|@@|\\)/.test(line) ? line : line.slice(1)).join('\n'), [lines, diff.untracked]);
  return <SyntaxHighlighter language={languages[path.split('.').pop().toLowerCase()] || 'text'} style={syntaxTheme}
    showLineNumbers lineNumberStyle={{ display:'none' }}
    codeTagProps={{ style:{ display:'block', minWidth:'100%' } }}
    wrapLines wrapLongLines={wrap}
    customStyle={{ margin:0, padding:'8px 0', background:'transparent', fontSize:12, lineHeight:1.5, userSelect:'text', width:wrap ? '100%' : 'max-content', minWidth:'100%', overflow:'visible' }}
    lineProps={index => {
      const line = lines[index - 1] || '';
      const added = diff.untracked || (line.startsWith('+') && !line.startsWith('+++'));
      const removed = !diff.untracked && line.startsWith('-') && !line.startsWith('---');
      return { 'data-change-line': added ? 'added' : removed ? 'removed' : 'context', className: added ? 'bg-[var(--success)]/10' : removed ? 'bg-[var(--error)]/10' : '', style: { display:'block', padding:'0 12px', whiteSpace:wrap ? 'pre-wrap' : 'pre', overflowWrap:wrap ? 'anywhere' : 'normal',
        background:added ? 'color-mix(in srgb, var(--success) 12%, transparent)' : removed ? 'color-mix(in srgb, var(--error) 12%, transparent)' : line.startsWith('@@') ? 'var(--surface-hover)' : undefined,
        borderLeft:added ? '2px solid var(--success)' : removed ? '2px solid var(--error)' : '2px solid transparent' } };
    }}>{content}</SyntaxHighlighter>;
});

export const WORKSPACE_CHANGES = '\0workspace-changes';

const FileChanges = React.memo(function FileChanges({ file, diff, onOpenFile, wrap }) {
  const container = useRef(null);
  const body = useRef(null);
  const height = useRef(96);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => observeChangeSection(container.current, inView => {
    if (!inView && body.current) height.current = body.current.getBoundingClientRect().height || height.current;
    setVisible(inView);
  }), []);
  return <section ref={container} className="border-b border-[var(--border)]" aria-label={file.path}>
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="min-w-0 flex-1 cursor-pointer truncate text-left" title={file.path}>
        {open ? '▾' : '▸'} {file.path}
      </button>
      <span className="text-[var(--text-muted)]">{file.status}</span>
      <span className="text-[var(--success)]">+{file.added ?? '—'}</span>
      <span className="text-[var(--error)]">−{file.deleted ?? '—'}</span>
      {!['deleted'].includes(file.status) && <button type="button" onClick={() => onOpenFile(file.path)}
        className="aero-control sk-button aero-fill sk-fill ui-radius-control cursor-pointer px-2 py-1">Open file</button>}
    </div>
    {open && !visible && <div aria-hidden="true" style={{ height:height.current }} />}
    {open && visible && <div ref={body} className="min-h-24 overflow-x-auto bg-[var(--code-bg)] text-[var(--code-text)]">
      {!diff ? <p role="status" className="p-4 text-xs text-[var(--text-muted)]">Loading diff…</p>
        : diff.error || diff.binary || diff.unavailable || !diff.text
          ? <p role={diff.error ? 'alert' : 'status'} className="p-4 text-xs text-[var(--text-muted)]">
            {diff.error || (diff.binary ? 'Binary file changed — text diff unavailable.' : diff.unavailable ? 'File content unavailable.' : 'No text changes.')}
          </p>
          : <HighlightedDiff diff={diff} path={file.path} wrap={wrap} />}

      {diff?.truncated && <p role="status" className="p-3 text-xs text-[var(--text-muted)]">Diff truncated for this large file.</p>}
    </div>}
  </section>;
});

const WorkspaceChanges = React.memo(function WorkspaceChanges({ sessionId, refresh, onOpenFile, wrap }) {
  const [state, setState] = useState({ loading: true });
  const [diffs, setDiffs] = useState({});
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    setDiffs({});
    let timer;
    let resume;
    const yieldTask = () => new Promise(resolve => {
      resume = resolve;
      timer = setTimeout(() => { resume = null; resolve(); }, 40);
    });
    (async () => {
      try {
        const result = await window.api.getRecoveryChangedFiles(sessionId, { includeCounts: true });
        if (cancelled) return;
        setState(result);
        await loadWorkspaceDiffs(result.files || [], {
          read: path => window.api.getRecoveryFileDiff(sessionId, path),
          publish: (path, diff) => setDiffs(previous => ({ ...previous, [path]:diff })),
          cancelled: () => cancelled,
          yieldTask,
        });
      } catch (error) { if (!cancelled) setState({ error:error.message }); }
    })();
    return () => { cancelled = true; clearTimeout(timer); resume?.(); };
  }, [sessionId, refresh]);
  const totals = useMemo(() => (state.files || []).reduce((sum, file) => ({
    added:sum.added + (file.added || 0), deleted:sum.deleted + (file.deleted || 0),
  }), {added:0, deleted:0}), [state.files]);
  const loadedCount = Object.keys(diffs).length;
  if (state.loading || state.error) return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-[var(--text-muted)]" role={state.error ? 'alert' : 'status'}>{state.error || 'Loading changed files…'}</div>;
  const files = state.files || [];
  return <div className="flex min-h-0 flex-1 flex-col" aria-label="Workspace changes">
    <div className="flex shrink-0 gap-3 border-b border-[var(--border)] px-3 py-3 text-xs">
      <span role="status">{loadedCount < files.length ? `Loading diffs ${loadedCount}/${files.length} · ` : ""}{state.branch || 'Working tree'} · {files.length} changed files</span>
      <span className="text-[var(--success)]">+{totals.added}</span>
      <span className="text-[var(--error)]">−{totals.deleted}</span>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      {!files.length && <p className="p-6 text-center text-sm text-[var(--text-muted)]">No uncommitted changes.</p>}
      {files.map(file => <FileChanges key={file.path} diff={diffs[file.path]} {...{ file, onOpenFile, wrap }} />)}
      {state.truncated && <p role="status" className="p-3 text-xs text-[var(--text-muted)]">Showing the first {files.length} changed files.</p>}
    </div>
  </div>;
});

export default WorkspaceChanges;
