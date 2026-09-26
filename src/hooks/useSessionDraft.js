import { useCallback, useLayoutEffect, useState } from 'react';

export default function useSessionDraft(sessionId) {
  const [input, setInput] = useState('');
  useLayoutEffect(() => {
    try { setInput(localStorage.getItem(`chat_draft_${sessionId}`) ?? ''); }
    catch { setInput(''); }
  }, [sessionId]);

  const updateDraft = useCallback(text => {
    setInput(text);
    try {
      const key = `chat_draft_${sessionId}`;
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch { /* Storage failures must not prevent composing or sending. */ }
  }, [sessionId]);

  return { input, updateDraft };
}
