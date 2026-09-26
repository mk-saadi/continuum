import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FiChevronRight } from 'react-icons/fi';
import { GiBrain } from 'react-icons/gi';

export default function ThoughtBlock({ content = '', durationMs }) {
  const seconds = Number.isFinite(durationMs) ? Math.max(0, durationMs) / 1000 : null;
  return (
    <details className="group/thought min-w-0 rounded-lg border border-[var(--subtle-border)] bg-[var(--surface)] text-xs text-[var(--text-muted)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)] [&::-webkit-details-marker]:hidden">
        <FiChevronRight aria-hidden="true" className="shrink-0 transition-transform group-open/thought:rotate-90" />
        <GiBrain aria-hidden="true" className="shrink-0" />
        <span>Thought{seconds === null ? '' : ` for ${seconds.toFixed(2)}s`}</span>
      </summary>
      <div className="assistant-markdown min-w-0 break-words border-t border-[var(--subtle-border)] px-4 py-3 leading-relaxed [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3 [&_a]:text-[var(--link)] [&_a]:underline">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </details>
  );
}
