import React, { useState } from 'react';

// Composer-adjacent pending interactions. Rendered immediately above the
// composer (independent of conversation scroll), never as interactive cards
// embedded in assistant Markdown. After an answer/approval/rejection the
// outcome is recorded in the completed execution history via the normal
// step result + localStorage decision, the turn footer (TurnOutcomes) renders
// a compact entry after the assistant's complete response, and the transcript
// keeps a static record at the step's original position.

function skillKey(stepId) {
  return `skill-proposal:${stepId}`;
}

export function readSkillDecision(stepId) {
  try {
    return localStorage.getItem(skillKey(stepId)) || '';
  } catch {
    return '';
  }
}

export default function PendingInteractions({
  pendingQuestions = {},
  skillProposals = [],
  onAnswerQuestion,
  onDecision,
  projectId = null,
}) {
  const questionEntries = Object.values(pendingQuestions ?? {});
  const actionableSkills = skillProposals.filter((item) => !readSkillDecision(item.step.id));
  if (!questionEntries.length && !actionableSkills.length) return null;
  return (
    <section
      aria-label="Pending interactions"
      className="mx-auto w-[calc(100%-2rem)] max-w-[980px] min-h-0 max-h-[40vh] shrink-0 space-y-2 overflow-y-auto pb-2 max-[450px]:w-[calc(100%-1.5rem)]"
    >
      {questionEntries.map((request) => (
        <QuestionPanel key={request.stepId ?? request.questionId} request={request} onAnswer={onAnswerQuestion} />
      ))}
      {actionableSkills.map(({ step }) => (
        <SkillApprovalPanel key={step.id} step={step} projectId={projectId} onDecision={onDecision} />
      ))}
    </section>
  );
}

function QuestionPanel({ request, onAnswer }) {
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const options = Array.isArray(request.options) ? request.options : [];
  async function submit(value) {
    if (!value.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await onAnswer(request, value.trim());
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setSending(false);
    }
  }
  return (
    <div aria-label="Agent question" className="rounded-xl border border-[var(--accent)] bg-[var(--surface)] p-3 text-sm">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">Agent needs your input</p>
      <p className="font-medium">{request.question}</p>
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((option) => (
            <button key={option} type="button" className="project-button" disabled={sending} onClick={() => submit(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(answer);
        }}
      >
        <input
          className="project-input min-w-0 flex-1"
          aria-label="Your answer"
          value={answer}
          maxLength={10000}
          disabled={sending}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Type your answer…"
        />
        <button className="project-button primary" disabled={sending || !answer.trim()}>
          Send answer
        </button>
      </form>
      {error && <p role="alert" className="project-error mt-2">{error}</p>}
    </div>
  );
}

function SkillApprovalPanel({ step, projectId, onDecision }) {
  const proposal = step.args;
  const [, setDecision] = useState(() => readSkillDecision(step.id));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!proposal || typeof proposal !== 'object') return null;
  async function register() {
    setBusy(true);
    setError('');
    try {
      await window.api.saveSkill({ ...proposal, projectId });
      try { localStorage.setItem(skillKey(step.id), 'registered'); } catch { /* optional */ }
      setDecision('registered');
      // Notify the chat root so the panel unmounts and the turn outcome
      // renders in the same commit; the transcript does not re-read
      // localStorage on the panel's own (child-only) state update.
      onDecision?.(step.id, 'registered');
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }
  function decline() {
    try { localStorage.setItem(skillKey(step.id), 'declined'); } catch { /* optional */ }
    setDecision('declined');
    onDecision?.(step.id, 'declined');
  }
  return (
    <div role="group" aria-label="Skill proposal approval" className="rounded-xl border border-[var(--accent)] bg-[var(--surface)] p-3 text-sm">
      <p>
        The AI agent suggests saving this workflow as a new Skill: <strong>{proposal.name}</strong>
      </p>
      <p className="mt-1 text-[var(--text-muted)]">{proposal.description}</p>
      <details className="mt-2">
        <summary className="cursor-pointer">Preview instructions</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--input)] p-3 text-xs">
          {proposal.instructions}
        </pre>
      </details>
      <div className="mt-2 flex gap-2">
        <button className="project-button primary" disabled={busy || step.status !== 'complete'} onClick={register}>
          Register Skill
        </button>
        <button className="project-button" disabled={busy} onClick={decline}>
          Decline
        </button>
      </div>
      {error && <p className="project-error mt-2" role="alert">{error}</p>}
    </div>
  );
}
