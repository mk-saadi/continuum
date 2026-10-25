import { useEffect, useState } from 'react';
import { mergeActivity } from '../lib/compactionActivity.mjs';
export function useCompactionActivity(api, sessionId, enabled) {
  const [state, setState] = useState({ sessionId: null, events: [] });
  useEffect(() => {
    if (!enabled || !sessionId || !api?.listCompactionActivity) return;
    let alive = true;
    let liveVersion = 0;
    const accept = (events, snapshot = false) => {
      if (!alive) return;
      setState(old => {
        const previous = old.sessionId === sessionId ? old.events : [];
        const retained = snapshot ? previous.filter(event => events.some(item => item.id === event.id)) : previous;
        const next = mergeActivity(retained, events, sessionId);
        if (old.sessionId === sessionId && next.length === previous.length && next.every((event, index) => event === previous[index])) return old;
        return { sessionId, events: next };
      });
    };
    let unsubscribe;
    try { unsubscribe = api.onCompactionActivity?.(sessionId, event => { liveVersion++; accept([event]); }); } catch { /* Polling remains available. */ }
    let pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      const version = liveVersion;
      try { const events = await api.listCompactionActivity(sessionId); accept(events, version === liveVersion); } catch { /* Retry on reconnect. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => { alive = false; clearInterval(timer); unsubscribe?.(); };
  }, [api, sessionId, enabled]);
  return enabled && state.sessionId === sessionId ? state.events : [];
}
