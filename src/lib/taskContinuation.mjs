// A plan is evidence of intent, never a mandate to keep executing forever.
export function prematureStopReason({ content, finishReason, loopDetected, plan, userText = '' }) {
  if (loopDetected || ['content_filter', 'refusal'].includes(finishReason)) return null;
  if (/\b(?:stop|cancel|pause|don't continue|do not continue)\b/i.test(userText)) return null;
  if (!plan?.steps?.some(step => ['pending', 'in_progress'].includes(step.status))) return null;
  if (['length', 'max_tokens', 'model_length'].includes(finishReason)) return 'output-truncated';
  if (!content?.trim()) return 'empty-final-response';
  // Questions and explicit blockers legitimately yield control to the user.
  if (/\?|\b(?:cannot|can't|unable|blocked|permission|approval|need your|waiting for)\b/i.test(content)) return null;
  return /\b(?:let me|next I(?:'ll| will)|I(?:'ll| will) (?:now |next )?(?:inspect|implement|fix|run|check|continue|finish|verify))\b/i.test(content)
    ? 'progress-with-unfinished-work' : null;
}
