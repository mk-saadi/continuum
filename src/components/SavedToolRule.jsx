import React, { useState } from 'react';

export default function SavedToolRule({ rule }) {
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState('');
  if (!rule) return null;
  return <div className="px-3 py-1 text-xs text-[var(--text-muted)]">
    <span>allowed by saved rule: {rule.label}</span>{' '}
    <button type="button" disabled={removed} onClick={async () => {
      try {
        await window.chatAPI.deleteToolRule(rule.projectId, rule.id, rule.sessionId);
        setRemoved(true);
      } catch (err) { setError(err.message); }
    }}>{removed ? 'Rule removed' : 'Remove rule'}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
