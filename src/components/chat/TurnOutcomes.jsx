import React from 'react';
import { FiCheck, FiMessageCircle, FiX } from 'react-icons/fi';
import { getTurnOutcomes } from '../../lib/executionEvents.mjs';
import { readSkillDecision } from './PendingInteractions.jsx';

function OutcomeIcon({ kind, status }) {
  const className = 'shrink-0 text-[var(--text-muted)]';
  if (kind === 'skill') {
    return status === 'approved'
      ? <FiCheck aria-hidden="true" className={className} />
      : <FiX aria-hidden="true" className={className} />;
  }
  return status === 'cancelled'
    ? <FiX aria-hidden="true" className={className} />
    : <FiMessageCircle aria-hidden="true" className={className} />;
}

// Compact, non-interactive outcome entries for one assistant turn, rendered
// after the complete response — never inside the Markdown body and never at
// the original tool-call position. A small subdued status row, visually
// secondary to the assistant prose.
export default function TurnOutcomes({ steps, pendingQuestions }) {
  const outcomes = getTurnOutcomes(steps ?? [], {
    pendingQuestions,
    getSkillDecision: readSkillDecision,
  });
  if (!outcomes.length) return null;
  return (
    <ul aria-label="Turn outcomes" className="mt-2 space-y-1 border-t border-[var(--subtle-border)] pt-2">
      {outcomes.map((outcome) => (
        <li
          key={outcome.key}
          role="status"
          className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-muted)]"
        >
          <OutcomeIcon kind={outcome.kind} status={outcome.status} />
          <span className="min-w-0 truncate" title={outcome.label}>
            {outcome.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
