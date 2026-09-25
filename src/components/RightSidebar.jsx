import React, { useEffect, useRef, useState } from 'react';
import { ParameterControls } from './ChatTuning';

export default function RightSidebar({ open, onClose, sessionId, modelId, agents, sessionAgent, disabled, onSelectAgent, onManageAgents, onSavePrompt, tuningVersion }) {
  const [tab, setTab] = useState('persona');
  const [scope, setScope] = useState('chat');
  const [prompt, setPrompt] = useState(sessionAgent?.system_prompt || '');
  const [notice, setNotice] = useState('');
  const tabs = useRef([]);
  useEffect(() => { setPrompt(sessionAgent?.system_prompt || ''); setNotice(''); }, [sessionId, sessionAgent]);
  const button = 'rounded border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-40';
  return <aside id="right-sidebar" aria-label="Chat controls" aria-hidden={!open} inert={open ? undefined : ''}
    className={`h-full shrink-0 overflow-hidden bg-[var(--surface)] transition-all duration-300 ease-in-out motion-reduce:transition-none max-[900px]:absolute max-[900px]:right-0 max-[900px]:top-0 max-[900px]:z-30 max-[900px]:shadow-xl ${open ? 'w-80 translate-x-0 opacity-100' : 'w-0 translate-x-full opacity-0'}`}>
    <div className="flex h-full w-80 flex-col border-l border-[var(--border)]">
      <div className="flex shrink-0 items-center justify-between p-3"><h2 className="text-sm font-semibold">Chat Controls</h2><button type="button" aria-label="Close chat controls" className="rounded px-2 py-1 hover:bg-[var(--surface-hover)]" onClick={onClose}>×</button></div>
      <div role="tablist" aria-label="Chat control sections" className="flex shrink-0 border-b border-[var(--border)] px-2">
        {[['persona', 'Agents & Persona'], ['sampling', 'Sampling Tuning']].map(([id, label], index) => <button key={id} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`controls-tab-${id}`} aria-controls={`controls-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
          onClick={() => setTab(id)} onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
              setTab(next ? 'sampling' : 'persona'); tabs.current[next]?.focus();
            }
          }} className={`flex-1 border-b-2 px-2 py-2 text-xs ${tab === id ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)]'}`}>{label}</button>)}
      </div>
      <section role="tabpanel" id="controls-persona" aria-labelledby="controls-tab-persona" hidden={tab !== 'persona'} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <label className="block text-xs">Active agent
          <select className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--input)] p-2" value={sessionAgent?.id || ''} disabled={disabled} onChange={event => onSelectAgent(event.target.value)}>
            <option value="">Default assistant</option>
            {sessionAgent?.id && !agents.some(agent => agent.id === sessionAgent.id) && <option value={sessionAgent.id}>{sessionAgent.name} (saved profile)</option>}
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={disabled} onClick={onManageAgents}>Manage Agents</button>
          {sessionAgent?.id && <button type="button" className={button} disabled={disabled || !agents.some(agent => agent.id === sessionAgent.id)} onClick={() => onSelectAgent(sessionAgent.id)}>Reapply preset</button>}
        </div>
        <form className="space-y-2" onSubmit={async event => { event.preventDefault(); setNotice(''); if (await onSavePrompt(prompt)) setNotice('Session prompt saved.'); }}>
          <label className="block text-xs">System prompt<textarea rows={12} maxLength={32000} disabled={disabled} value={prompt} onChange={event => { setPrompt(event.target.value); setNotice(''); }} placeholder="Add instructions for this chat…" className="mt-2 w-full resize-y rounded border border-[var(--border)] bg-[var(--input)] p-2 text-xs" /></label>
          <p className="text-[11px] text-[var(--text-muted)]">Applies to this chat; the library preset stays unchanged.</p>
          <button type="submit" className={button} disabled={disabled}>Save prompt</button>
          {notice && <p role="status" className="text-xs">{notice}</p>}
        </form>
      </section>
      <section role="tabpanel" id="controls-sampling" aria-labelledby="controls-tab-sampling" hidden={tab !== 'sampling'} className="min-h-0 flex-1 overflow-y-auto p-4">
        <label className="mb-4 block text-xs">Apply to<select value={scope} onChange={event => setScope(event.target.value)} className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--input)] p-2"><option value="chat">This chat</option><option value="global">Global defaults</option></select></label>
        <ParameterControls key={`${scope}:${sessionId}:${tuningVersion}`} sessionId={scope === 'chat' ? sessionId : undefined} modelId={modelId} />
      </section>
    </div>
  </aside>;
}
