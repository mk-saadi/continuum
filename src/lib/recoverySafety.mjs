// Pure presentation logic for recovery safety verdicts (recoveryStore
// analyzeRestoreSafety). No DOM, no IPC — unit-testable under plain node.
// The modal renders these strings; the backend remains the authority on
// what actually happened (verdicts, strategies, undo ids).

export function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return 'unknown size';
  if (size === 0) return 'empty';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function emptyOverLines(anomaly) {
  return (anomaly?.paths ?? []).map((entry) => {
    if (typeof entry === 'string') return entry;
    return `${entry.path} (${formatBytes(entry.currentSize)} now → empty)`;
  });
}

function shrinkLines(anomaly) {
  return (anomaly?.paths ?? []).map((entry) => {
    if (typeof entry === 'string') return entry;
    return `${entry.path} (${formatBytes(entry.currentSize)} now → ${formatBytes(entry.restoreSize)})`;
  });
}

// Describe a backend `safety` report for display. Returns null when there is
// nothing risky to explain (safe or missing report).
export function safetyVerdictInfo(safety) {
  const verdict = safety?.verdict ?? 'safe';
  if (verdict !== 'authorization-required' && verdict !== 'refused') return null;
  const anomalies = Array.isArray(safety?.anomalies) ? safety.anomalies : [];
  const emptyOver = anomalies.find((entry) => entry?.type === 'empty-over-nonempty');
  const degenerate = anomalies.find((entry) => entry?.type === 'degenerate-checkpoint');
  const shrink = anomalies.find((entry) => entry?.type === 'mass-shrink');
  const filesWouldEmpty = safety?.filesWouldEmpty ?? 0;
  if (verdict === 'refused') {
    return {
      verdict,
      needsForce: true,
      tone: 'refused',
      title: 'Restore refused: this checkpoint looks damaged',
      explanation: degenerate
        ? 'Nearly every file this checkpoint recorded is empty, while the current files hold content. ' +
          'Restoring it would wipe real content, so it is blocked until you explicitly authorize the risky content ' +
          'AND allow overwriting conflicting files.'
        : 'Restoring this checkpoint would destroy too much current content to proceed on a single confirmation. ' +
          'It stays blocked until you explicitly authorize the risky content AND allow overwriting conflicting files.',
      lines: [...emptyOverLines(emptyOver), ...shrinkLines(shrink)],
      filesWouldEmpty,
      bytesWouldDestroy: safety?.bytesWouldDestroy ?? 0,
      footer: 'No files were changed. The checkpoint and all recovery data are untouched.',
    };
  }
  return {
    verdict,
    needsForce: false,
    tone: 'confirm',
    title: 'Risky restore needs your confirmation',
    explanation:
      'This restore would newly empty ' +
      `${filesWouldEmpty} file${filesWouldEmpty === 1 ? '' : 's'} that currently hold${filesWouldEmpty === 1 ? 's' : ''} content. ` +
      'Check the box below to authorize exactly this content change. ' +
      'Overwriting files changed since the checkpoint is a separate decision controlled by the overwrite checkbox.',
    lines: [...emptyOverLines(emptyOver), ...shrinkLines(shrink)],
    filesWouldEmpty,
    bytesWouldDestroy: safety?.bytesWouldDestroy ?? 0,
    footer: 'Nothing has been restored yet — this is still only a preview.',
  };
}

// Human-readable outcome for a finished restore result (or refusal).
export function restoreOutcomeMessage(result) {
  if (!result || typeof result !== 'object') return { kind: 'error', text: 'Restore failed: no result was returned.' };
  if (result.strategy === 'refused' || result.strategy === 'authorization-required') {
    const info = safetyVerdictInfo(result.safety);
    return {
      kind: result.strategy,
      text: info
        ? `${info.title}. ${info.explanation} ${info.footer}`
        : 'Restore was not applied: the safety check did not pass. No files were changed.',
    };
  }
  const changed = (result.restored ?? []).filter((entry) => entry?.action !== 'unchanged');
  const unchanged = (result.restored ?? []).length - changed.length;
  const removed = result.removed?.length ?? 0;
  const skipped = result.skipped?.length ?? 0;
  const unchangedNote = unchanged ? `, ${unchanged} already matching` : '';
  const undoNote = result.preRestoreCheckpointId != null
    ? ` Undo point #${result.preRestoreCheckpointId}${result.undoPinned ? ' (pinned against cleanup)' : ''}.`
    : '';
  if (result.complete) {
    return {
      kind: 'success',
      text: `Restored ${changed.length} path${changed.length === 1 ? '' : 's'}${removed ? `, removed ${removed}` : ''}${unchangedNote}. A pre-restore point was saved first.${undoNote}`,
    };
  }
  return {
    kind: 'partial',
    text: `Partial restore: ${changed.length} restored, ${removed} removed, ${skipped} skipped${unchangedNote} — see details.${undoNote}`,
  };
}
