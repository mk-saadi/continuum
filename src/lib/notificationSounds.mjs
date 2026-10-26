// Renderer-only, best-effort audio. No task content enters this service.
export const defaultSoundPrefs = Object.freeze({ enabled: true, volume: 25, completed: true, interrupted: true, inputRequired: true });
const notes = { completed: [523.25, 659.25, 783.99], interrupted: [392, 293.66], inputRequired: [440, 587.33] };
export function createNotificationSounds({ getContext = () => new (window.AudioContext || window.webkitAudioContext)() } = {}) {
  let context, disposed = false, generation = 0;
  let prefs = { ...defaultSoundPrefs };
  const nodes = new Set();
  return {
    activate() { disposed = false; },
    setPrefs(value) { prefs = { ...defaultSoundPrefs, ...value }; },
    async play(kind) {
      if (disposed || !prefs.enabled || !prefs[kind] || prefs.volume <= 0 || !notes[kind]) return false;
      const ticket = generation;
      try {
        context ??= getContext();
        if (context.state === 'suspended') await context.resume();
        if (disposed || ticket !== generation || context.state !== 'running' || !prefs.enabled || !prefs[kind] || prefs.volume <= 0) return false;
        // Do not overlap alerts or queue a backlog while an alert is playing.
        if (nodes.size) return false;
        const start = context.currentTime + 0.01;
        notes[kind].forEach((frequency, i) => {
          const oscillator = context.createOscillator(), gain = context.createGain();
          nodes.add(oscillator);
          oscillator.type = kind === 'interrupted' ? 'triangle' : 'sine';
          oscillator.frequency.value = frequency;
          const at = start + i * 0.14;
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(prefs.volume / 100 * 0.12, at + 0.025);
          gain.gain.linearRampToValueAtTime(0, at + 0.22);
          oscillator.connect(gain); gain.connect(context.destination);
          oscillator.onended = () => { nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(at); oscillator.stop(at + 0.23);
        });
        return true;
      } catch { return false; }
    },
    dispose() {
      disposed = true; generation++;
      for (const node of nodes) { try { node.stop(); node.disconnect(); } catch { /* Already ended. */ } }
      nodes.clear();
      try { context?.close()?.catch(() => {}); } catch { /* Audio is optional. */ }
      context = undefined;
    },
  };
}
export const notificationSounds = createNotificationSounds();

// Subscribe once above all tabs. Only live events are accepted; no history or
// active-run query is used. Transition identities survive listener remounts.
export function createSoundDispatcher(play) {
  const seen = new Set();
  return (kind, event, transition) => {
    if (!notes[kind]) return;
    if (!event?.requestId && !event?.runId) return;
    if (event.resolved || event.parentRunId || event.subagentId || !transition) return;
    const key = JSON.stringify([event.sessionId, event.runId || event.requestId, kind, transition]);
    if (seen.has(key)) return;
    seen.add(key);
    try { Promise.resolve(play(kind)).catch(() => {}); } catch { /* Never affect execution. */ }
  };
}
const dispatch = createSoundDispatcher(kind => notificationSounds.play(kind));
export function subscribeNotificationSounds(api, accept = dispatch) {
  const off = [];
  const listen = (name, fn) => { const remove = api?.[name]?.(fn); if (remove) off.push(remove); };
  listen('onEvent', e => { if (e.type === 'task-outcome') accept(e.outcome, e, 'terminal'); });
  listen('onToolApproval', e => accept('inputRequired', e, e.approvalId));
  listen('onAskUser', e => accept('inputRequired', e, e.questionId));
  listen('onToolLimitReached', e => accept('inputRequired', e, `tool-limit:${e.currentCount}`));
  listen('onLoopPaused', e => { if (e.executionState === 'paused_turn_limit') accept('inputRequired', e, e.pauseId); });
  return () => off.forEach(remove => remove());
}
