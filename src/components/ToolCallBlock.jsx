import React, { useId, useState } from 'react';
import { FiChevronRight, FiTool } from 'react-icons/fi';
import { PrismAsync as SyntaxHighlighter } from 'react-syntax-highlighter';

const codeTheme = {
  'pre[class*="language-"]': { background: 'transparent', color: '#cbd5e1' },
  'code[class*="language-"]': { color: '#cbd5e1' },
  property: { color: '#7dd3fc' },
  string: { color: '#a7f3d0' },
  number: { color: '#fcd34d' },
  boolean: { color: '#c4b5fd' },
  null: { color: '#c4b5fd' },
  punctuation: { color: '#94a3b8' },
};

function formatValue(value, fallback) {
  if (value === undefined) return { text: fallback, language: 'text' };
  if (typeof value === 'string') {
    try { return { text: JSON.stringify(JSON.parse(value), null, 2), language: 'json' }; }
    catch { return { text: value, language: 'text' }; }
  }
  return { text: JSON.stringify(value, null, 2), language: 'json' };
}

function CodeSection({ title, value }) {
  return (
    <section className="min-w-0 space-y-1.5" aria-label={title}>
      <h4 className="font-medium text-[var(--text-secondary)]">{title}</h4>
      <div className="overflow-hidden rounded-md border border-slate-700 bg-slate-950">
        <SyntaxHighlighter language={value.language} style={codeTheme}
          customStyle={{ margin: 0, padding: '12px', background: 'transparent', fontSize: '12px', maxHeight: '320px', overflow: 'auto' }}>
          {value.text}
        </SyntaxHighlighter>
      </div>
    </section>
  );
}

export default function ToolCallBlock({ step }) {
  const detailsId = useId();
  const [userExpanded, setUserExpanded] = useState(null);
  const running = step.status === 'running' || step.status === 'pending';
  // Follow execution status until the user explicitly chooses a view.
  const expanded = userExpanded ?? running;
  const args = formatValue(step.args, 'No arguments');
  const result = formatValue(Object.hasOwn(step, 'result') ? step.result : step.error, running ? 'Waiting for result…' : 'No result');
  const preview = value => value.text.replace(/\s+/g, ' ').slice(0, 180) + (value.text.replace(/\s+/g, ' ').length > 180 ? '…' : '');
  return (
    <div aria-label="Tool executions" className="min-w-0 overflow-hidden rounded-lg border border-[var(--subtle-border)] bg-[var(--surface)] text-xs">
      <button type="button" aria-expanded={expanded} aria-controls={detailsId}
        onClick={() => setUserExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
        <FiChevronRight aria-hidden="true" className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <FiTool aria-hidden="true" className="shrink-0 text-cyan-400" />
        <strong className="min-w-0 truncate text-cyan-500 dark:text-cyan-300" title={step.toolName}>{step.toolName || 'Tool'}</strong>
        <span className={`shrink-0 ${step.status === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}>
          {running ? 'Running…' : step.status}
        </span>
        {step.serverName && <span title={step.serverName} className="ml-auto max-w-[45%] truncate rounded border border-[var(--subtle-border)] bg-[var(--input)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">{step.serverName}</span>}
      </button>
      {!expanded && <div className="flex min-w-0 gap-3 px-3 pb-2 pl-9 text-[var(--text-muted)]">
        <span className="min-w-0 flex-1 truncate"><span className="font-medium">Arguments:</span> {preview(args)}</span>
        <span className="min-w-0 flex-1 truncate"><span className="font-medium">Result:</span> {preview(result)}</span>
      </div>}
      <div id={detailsId} hidden={!expanded} className="space-y-3 border-t border-[var(--subtle-border)] p-3">
        {expanded && <><CodeSection title="Arguments" value={args} /><CodeSection title="Result" value={result} /></>}
        {step.error && <p className="break-words text-[var(--error)]">{step.error}</p>}
      </div>
    </div>
  );
}
