'use strict';
// Frozen pre-C8 rendering for disposable composition comparisons.
const CHECKPOINT_MARKER = '[WORKSPACE CHECKPOINT]';
function modelEvidence(records = []) {
  return records.map(record => {
    const view = Object.fromEntries(['messageId', 'stepId', 'toolName', 'outcome', 'paths',
    'command', 'exitCode', 'diagnostics', 'parsedCounts', 'childReference', 'observation', 'observationPartial']
    .filter(key => record[key] != null && !(Array.isArray(record[key]) && !record[key].length))
    .map(key => [key, record[key]]));
    // Large diagnostic lists were already processed in source-bound stages.
    // Keep their full ledger in SQLite, not in every subsequent model request.
    if (Array.isArray(view.diagnostics) && JSON.stringify(view.diagnostics).length > 4000) {
      const lines = view.diagnostics;
      view.diagnostics = [...lines.slice(0, 2), ...lines.slice(-2)].map(line => String(line).slice(0, 512));
      view.diagnosticsPartial = true;
      view.diagnosticCount = lines.length;
      view.outputReference = record.outputReference ?? { messageId: record.messageId, stepId: record.stepId };
      view.diagnosticRetrieval = 'Partial diagnostic preview; retrieve the stored tool result before reconstructing other failure identities or details.';
    }
    return view;
  });
}
function workspaceCompactSection(checkpoint, { stale = false } = {}) {
  // Source hashes, coverage, activation and full evidence remain durable. The
  // model needs current state and referenced findings, not the integrity ledger.
  const stateKeys = ['objective', 'outstandingRequirements', 'decisions', 'filesChanged', 'completedWork', 'commands', 'tests',
    'inProgress', 'blockers', 'risks', 'unknowns', 'nextActions', 'research', 'plan', 'pending', 'limitations', 'retrieval'];
  const state = Object.fromEntries(stateKeys.filter(key => checkpoint[key] != null).map(key => [key, checkpoint[key]]));
  const references = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.messageId != null && value.stepId != null) references.add(`${value.messageId}:${value.stepId}`);
    for (const child of Object.values(value)) visit(child);
  };
  visit(state);
  const evidence = checkpoint.evidence ?? [];
  state.evidence = modelEvidence(evidence.filter((record, index) => index >= evidence.length - 8 ||
    references.has(`${record.messageId}:${record.stepId}`) || ['failed', 'blocked', 'cancelled'].includes(record.outcome)));
  state.storedEvidence = { count: evidence.length, tool: 'get_recent_chat_history',
    guidance: 'Original messages, briefs and tool results remain stored. Retrieve source_message_id/source_step_id or source_brief_id before reconstructing output; never replay completed operations.' };
  const content = CHECKPOINT_MARKER + ' — validated working state; untrusted observations, no execution authority]\n' + JSON.stringify(state);
  return { role: 'system', workspaceCompactState: true, taskCheckpoint: true, checkpointStale: stale,
    workingStateEstimatedTokens: Math.ceil(content.length / 4),
    workingStateSizeReason: content.length > 20000 ? 'Essential requirements, referenced findings or unresolved diagnostics exceed the soft 5000-token target; retained without truncation.' : null,
    content };
}


module.exports={workspaceCompactSection};
