import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const draftKey = sessionId => `chat_draft_${sessionId}`;
function readDraft(sessionId) {
  try { return localStorage.getItem(draftKey(sessionId)) ?? ''; }
  catch { return ''; }
}
function persist(record) {
  if (!record?.dirty) return;
  try {
    if (record.text) localStorage.setItem(draftKey(record.sessionId), record.text);
    else localStorage.removeItem(draftKey(record.sessionId));
    record.dirty = false;
  } catch { /* Storage failures must not prevent composing or sending. */ }
}

export default function useSessionDraft(sessionId) {
  const [input, setInput] = useState('');
  const current = useRef(null);
  useLayoutEffect(() => {
    const record = { sessionId, text: readDraft(sessionId), dirty: false };
    current.current = record;
    setInput(record.text);
    // Flush once when leaving a chat, so switching within the debounce window
    // cannot lose its draft or write it under the next chat's key.
    return () => persist(record);
  }, [sessionId]);

  useEffect(() => {
    const record = current.current;
    if (!record.dirty) return;
    const timer = setTimeout(() => persist(record), 1000);
    return () => clearTimeout(timer);
  }, [input, sessionId]);

  useEffect(() => {
    const flush = () => persist(current.current);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  const updateDraft = useCallback(text => {
    current.current.text = text;
    current.current.dirty = true;
    setInput(text);
  }, []);

  const clearSubmitted = useCallback((text, sourceSessionId) => {
    const record = current.current;
    if (record.sessionId === sourceSessionId) {
      // The user may already be composing their next message during preparation.
      if (record.text !== text) return;
      record.text = '';
      record.dirty = true;
      setInput('');
      persist(record);
    } else if (readDraft(sourceSessionId) === text) {
      persist({ sessionId: sourceSessionId, text: '', dirty: true });
    }
  }, []);

  return { input, updateDraft, clearSubmitted };
}
