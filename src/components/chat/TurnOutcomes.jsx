import React from 'react';
import { FiCheck, FiMessageCircle, FiX } from 'react-icons/fi';
import { getTurnInteractions } from '../../lib/executionEvents.mjs';
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

function questionTitle(entry) {
  if (entry.status === 'cancelled') return `Question cancelled · ${entry.question}`;
  return `Question asked · ${entry.question}`;
}

// Compact, non-interactive records for one assistant turn's resolved agent
// interactions: the questions the agent asked (with the answer the user gave)
// and the skill-registration decisions the user made. Rendered after the
// complete response — never inside the Markdown body and never at the original
// tool-call position. `interactions` may be supplied by the parent (which
// already holds the active steps and pending questions); otherwise they are
// derived here. Either way the source is the recorded steps only.
export default function TurnOutcomes({ steps, pendingQuestions, interactions }) {
  const entries = Array.isArray(interactions)
    ? interactions
    : getTurnInteractions(steps ?? [], {
        pendingQuestions,
        getSkillDecision: readSkillDecision,
      });
  if (!entries.length) return null;
  return (
    <ul aria-label="Turn outcomes" className="mt-2 space-y-1.5">
      {entries.map((entry) => (
        <li
          key={entry.key}
          role="status"
          className="flex min-w-0 items-start gap-1.5 text-[11px] text-[var(--text-muted)]"
        >
          <OutcomeIcon kind={entry.kind} status={entry.status} />
          <span className="min-w-0">
            {entry.kind === 'skill' ? (
              <>
                <span className="block text-[var(--text-secondary)]">
                  {entry.label}
                </span>
                {entry.description && (
                  <span className="block break-words text-[var(--text-muted)]">{entry.description}</span>
                )}
              </>
            ) : (
              <>
                <span className="block break-words text-[var(--text-secondary)]">{questionTitle(entry)}</span>
                {entry.status === 'answered' && entry.answer && (
                  <span className="block break-words text-[var(--text-muted)]">Answered: {entry.answer}</span>
                )}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}