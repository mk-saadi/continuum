import React, { useEffect, useRef, useState } from 'react';
import { FaSlidersH } from 'react-icons/fa';

const controls = [
  { key: 'temperature', label: 'Temperature', type: 'range', min: 0, max: 2, step: 0.05 },
  { key: 'top_p', label: 'Top-P', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'top_k', label: 'Top-K', type: 'number', min: 1, max: 100, step: 1 },
  { key: 'repeat_penalty', label: 'Repeat Penalty', type: 'range', min: 1, max: 1.5, step: 0.01 },
  { key: 'max_tokens', label: 'Max Tokens', type: 'number', min: -1, step: 1 },
];

function ParameterControls({ sessionId, modelId }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Loading…');
  const version = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        if (!window.api?.getSamplingParams) throw new Error('Open the desktop app to tune generation.');
        const result = await window.api.getSamplingParams(sessionId);
        if (alive.current) { setState(result); setStatus(''); }
      } catch (err) { if (alive.current) { setError(err.message); setStatus(''); } }
    })();
    return () => { alive.current = false; };
  }, [sessionId]);

  async function save(params) {
    const request = ++version.current;
    setError(''); setStatus('Saving…');
    try {
      const result = await window.api.saveSamplingParams(sessionId, modelId, params);
      if (alive.current && request === version.current) { setState(result); setStatus('Saved'); }
    } catch (err) {
      if (alive.current && request === version.current) { setError(err.message); setStatus('Not saved'); }
    }
  }
  return <div className="space-y-4">
    <p className="text-xs text-[var(--text-secondary)]">Changes auto-save and apply to the next generation request. A response already streaming keeps its current settings.</p>
    {state && controls.map(control => <label key={control.key} className="block space-y-1 text-xs">
      <span className="flex justify-between gap-2"><span>{control.label}</span><span>{state.params[control.key]}</span></span>
      <input type={control.type} min={control.min} max={control.max} step={control.step} value={state.params[control.key]}
        disabled={!!sessionId && !modelId && !state.exists}
        className="w-full rounded border border-[var(--border)] bg-[var(--input)] p-1.5 accent-cyan-500 disabled:opacity-40"
        onChange={event => {
          const raw = event.target.value;
          setState(previous => ({ ...previous, params: { ...previous.params, [control.key]: raw } }));
          const value = Number(raw);
          if (raw === '' || !Number.isFinite(value) || value < control.min || (control.max !== undefined && value > control.max) ||
              (control.type === 'number' && !Number.isSafeInteger(value)) || (control.key === 'max_tokens' && value === 0)) {
            setError('Enter a valid value. Max Tokens accepts -1 (unlimited) or a positive integer.'); return;
          }
          save({ [control.key]: value });
        }} />
      {control.key === 'max_tokens' && <span className="block text-[var(--text-muted)]">-1 means unlimited generation, subject to the model’s context window.</span>}
    </label>)}
    {sessionId && state && <>
      <p className="text-xs text-[var(--text-muted)]">{Object.keys(state.overrides).length ? 'This chat has custom overrides.' : 'This chat follows global defaults.'}</p>
      <button type="button" className="rounded border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40"
        disabled={!Object.keys(state.overrides).length || status === 'Saving…'} onClick={() => save(null)}>Use global defaults</button>
    </>}
    {!modelId && sessionId && state && !state.exists && <p className="text-xs">Select a model to save tuning for this new chat.</p>}
    <p role="status" className="text-xs text-[var(--text-secondary)]">{status}</p>
    {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
  </div>;
}

export default function ChatTuning({ sessionId, modelId }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('chat');
  const trigger = useRef(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="relative flex shrink-0 justify-end border-b border-[var(--border)] px-3 py-1" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls="chat-tuning-panel"
      className="flex items-center gap-2 rounded px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
      onClick={() => setOpen(value => !value)}><FaSlidersH aria-hidden="true" /> Tuning</button>
    {open && <section id="chat-tuning-panel" aria-label="Generation tuning" className="absolute right-0 top-full z-40 max-h-[65vh] w-80 max-w-full overflow-y-auto rounded-b-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Generation tuning</h3>
        <button type="button" autoFocus aria-label="Close tuning" onClick={close} className="rounded px-2 py-1 hover:bg-[var(--surface-hover)]">×</button>
      </div>
      <label className="mb-4 block text-xs">Apply to
        <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--input)] p-2" value={scope} onChange={event => setScope(event.target.value)}>
          <option value="chat">This chat</option><option value="global">Global defaults</option>
        </select>
      </label>
      <ParameterControls key={`${scope}:${sessionId}`} sessionId={scope === 'chat' ? sessionId : undefined} modelId={modelId} />
    </section>}
  </div>;
}
