// Renderer projection only: ordered revisions from the trusted main process.
export function mergeActivity(previous, incoming, sessionId) {
  const map = new Map(previous.filter(e => e.session_id === sessionId).map(e => [e.id, e]));
  for (const event of incoming ?? []) {
    if (event?.session_id !== sessionId) continue;
    if (!map.has(event.id) || map.get(event.id).revision < event.revision) map.set(event.id, event);
  }
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
}
export function activitySegments(steps, events) {
  const groups = []; let start = 0;
  for (const event of events) {
    const index = event.anchor_step_id == null ? -1 : steps.findIndex(step => step.id === event.anchor_step_id);
    const end = Math.max(start, index + 1);
    if (end > start) groups.push({ steps: steps.slice(start, end) });
    groups.push({ activity: event }); start = end;
  }
  if (start < steps.length) groups.push({ steps: steps.slice(start) });
  return groups;
}
export function activityLabel(event) {
  return ({ started: 'Context compaction started', generating: 'Generating compact task state…', validating: 'Validating compact state…',
    'checking-fit': 'Checking resumed request…', committing: 'Saving compact context…', completed: 'Context compacted',
    deferred: 'Context compaction postponed', failed: 'Context compaction failed', cancelled: 'Context compaction interrupted' })[event.status] || 'Context compaction';
}
export function measurementLabel(method) {
  return /approx|estimat|bytes/i.test(method ?? '') ? 'Estimated' : /tokeniz|exact/i.test(method ?? '') ? 'Tokenizer measured' : 'Runtime measured';
}
export function activityReason(code) {
  const abortReasons = {
    'user-cancelled': 'Compaction stopped at your request.',
    'deleted-conversation': 'Compaction stopped because the conversation is being deleted.',
    'renderer-destroyed': 'Compaction stopped because its application window closed.',
    'ipc-disposed': 'Compaction stopped because the application request handlers shut down.',
    'generation-inactivity-timeout': 'The model produced no generation progress for 10 minutes. Retry when the local model is ready.',
    'unexpected-abort': 'Compaction received an unexpected cancellation. Retry the run; the cancellation origin was not identified.',
  };
  if (abortReasons[code]) return abortReasons[code];
  if (['pending-child-operation', 'pending-background-operation', 'pending-tool-operation'].includes(code)) return 'Compaction postponed while an operation is still completing.';
  if (['no-reducible-history', 'irreducible-context-overflow', 'prospective-context-overflow', 'no-meaningful-reduction'].includes(code)) return 'Required instructions and active tool state cannot be reduced safely.';
  if (['model-unavailable', 'provider-error'].includes(code)) return 'The selected model could not complete compaction.';
  if (['schema-invalid', 'invalid-json', 'invalid-reference', 'missing-required-data', 'output-truncated'].includes(code)) return 'Compact task state could not be validated. Original history was preserved.';
  if (code === 'interrupted-commit-unverified') return 'Compaction was interrupted after activation. Completion could not be verified.';
  if (code?.startsWith('interrupted-')) return 'Compaction was interrupted before a verified completion.';
  return 'Compaction did not complete. See the diagnostic code for this attempt.';
}
