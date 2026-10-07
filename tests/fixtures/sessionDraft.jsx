import React from 'react';
import { createRoot } from 'react-dom/client';
import useSessionDraft from '../../src/hooks/useSessionDraft';
const root = createRoot(document.getElementById('root'));
function Fixture({ sessionId }) {
  const { input, updateDraft } = useSessionDraft(sessionId);
  window.updateDraft = updateDraft;
  return <textarea aria-label="Draft" value={input} onChange={event => updateDraft(event.target.value)} />;
}
window.renderDraft = sessionId => root.render(<Fixture sessionId={sessionId} />);
