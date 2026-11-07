import React, { useEffect, useRef, useState } from 'react';
import { FiArrowLeft, FiChevronRight, FiCommand, FiSearch } from 'react-icons/fi';
import { useTabs } from '../context/TabContext.jsx';
import { useLeftSidebar, useRightSidebar, useTheme, useModalActions, useModalState } from '../context/UIStateContext.jsx';
import { getAppShortcut } from '../lib/appShortcuts.mjs';
import { APPEARANCES, setAppearance } from '../lib/appearance.mjs';
import { themeGroups } from '../lib/themes.mjs';
import { fetchSessionGroups } from '../lib/sessionGroups.mjs';
import ModelSettingsModal from './ModelSettingsModal.jsx';

const COMMANDS = [
  ['messages', 'Search chat messages', 'Search the contents of saved conversations'],
  ['chats', 'Search chats', 'Find a conversation by title'],
  ['workspace', 'Go to workspace', 'Choose a workspace or open all workspaces'],
  ['workspace-search', 'Search workspaces', 'Find a workspace by name'],
  ['models', 'Open model load modal', 'Browse local and cloud models', 'Ctrl+M'],
  ['style', 'Change UI style', 'Flat, Aero Glass, or Skeu'],
  ['themes', 'Change theme', 'Choose a color palette'],
  ['load', 'Load model', 'Choose a local model and review its load settings'],
  ['unload', 'Unload model', 'Choose a running local model'],
  ['enable', 'Enable MCP servers', 'Choose servers to enable'],
  ['disable', 'Disable MCP servers', 'Choose servers to disable'],
  ['casual', 'Go to casual chat', 'Open a new casual conversation'],
  ['tasks', 'Go to scheduled tasks', 'View and manage scheduled tasks'],
  ['settings', 'Open settings', 'Configure the application', 'Ctrl+.'],
  ['left', 'Toggle left sidebar', 'Show or hide navigation', 'Ctrl+['],
  ['right', 'Toggle right sidebar', 'Show or hide conversation details', 'Ctrl+]'],
];

export default function CommandSpotlight({ projects = [], models = [], engines = [], onLoadedModel }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [data, setData] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [configuring, setConfiguring] = useState(null);
  const requestRef = useRef(0);
  const input = useRef(null), panel = useRef(null), returnFocus = useRef(null), executing = useRef(false);
  const tabs = useTabs();
  const left = useLeftSidebar(), right = useRightSidebar(), theme = useTheme();
  const actions = useModalActions(), modals = useModalState();
  const close = () => { requestRef.current++; setOpen(false); };
  const enter = id => { requestRef.current++; setStep(id); setQuery(''); setIndex(0); setData([]); setCursor(null); setError(''); setNotice(''); input.current?.focus(); };
  const navigate = patch => { tabs.updateTab(tabs.activeTabId, patch); close(); };

  useEffect(() => {
    const handler = event => {
      const command = getAppShortcut(event);
      if (!command) return;
      if (command !== 'spotlight' && (open || configuring || modals?.settingsOpen || modals?.modelSelectorOpen || event.target.closest?.('dialog[open], [role="dialog"], [aria-modal="true"]'))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (command === 'spotlight') {
        if (modals?.settingsOpen || modals?.modelSelectorOpen || configuring || document.querySelector('dialog[open]')) return;
        if (open) close();
        else { setStep(null); setQuery(''); setIndex(0); setError(''); setNotice(''); setOpen(true); }
      } else if (command === 'left') left?.toggle();
      else if (command === 'right') right?.toggle();
      else if (command === 'settings') actions?.openSettings();
      else if (command === 'models') actions?.openModelSelector();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, configuring, left, right, actions, modals]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement;
    input.current?.focus();
    return () => { if (document.activeElement === document.body || panel.current?.contains(document.activeElement)) returnFocus.current?.focus?.(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const token = ++requestRef.current;
    setError(''); setCursor(null); setBusy(false);
    let timer;
    const run = async () => {
      setBusy(true);
      try {
        let rows = [], nextCursor = null;
        if (step === 'chats') rows = (await fetchSessionGroups(window.memoryPalace)).flatMap(group => group.sessions);
        if (step === 'enable' || step === 'disable') {
          const config = await window.api.getMcpConfig();
          rows = Object.entries(config.mcpServers || {}).map(([name, value]) => ({ name, label: value.displayName || name, disabled: !!value.disabled }));
        }
        if (step === 'messages' && query.trim()) {
          const result = await window.memoryPalace.searchMessages({ query });
          rows = result.matches; nextCursor = result.cursor;
        }
        if (token === requestRef.current) { setData(rows); setCursor(nextCursor); }
      } catch (problem) { if (token === requestRef.current) setError(problem.message); }
      finally { if (token === requestRef.current) setBusy(false); }
    };
    if (['chats', 'enable', 'disable'].includes(step) || (step === 'messages' && query.trim())) timer = setTimeout(run, step === 'messages' ? 200 : 0);
    return () => { clearTimeout(timer); if (token === requestRef.current) requestRef.current++; };
  }, [open, step, step === 'messages' ? query : null]);

  const openChat = async (sessionId, messageId) => {
    const session = await window.memoryPalace.loadSession(sessionId);
    if (!session) throw new Error('This conversation no longer exists.');
    if (messageId && Array.isArray(session.messages) && !session.messages.some(message => message.id === messageId))
      throw new Error('This result belongs to another conversation branch. Open the chat and choose that branch to view it.');
    const existing = tabs.tabs.find(tab => tab.sessionId === sessionId);
    const id = existing?.id || tabs.openTab(session.model_id || '', session.project_id ?? null);
    tabs.updateTab(id, { sessionId, title: session.title || 'Untitled chat', modelId: session.model_id || '', projectId: session.project_id ?? null, saved: true, view: 'chat',
      navigationTarget: messageId ? { messageId, nonce: crypto.randomUUID() } : null });
    tabs.activateTab(id); close();
  };
  const finish = callback => async () => { await callback(); close(); };
  const chooseCommand = id => {
    if (id === 'models') { close(); actions.openModelSelector(); }
    else if (id === 'settings') { close(); actions.openSettings(); }
    else if (id === 'left') left.toggle();
    else if (id === 'right') right.toggle();
    else if (id === 'tasks') navigate({ view: 'tasks' });
    else if (id === 'casual') { tabs.openTab(tabs.activeTab?.modelId || '', null); close(); }
    else enter(id);
  };
  let rows;
  if (!step) rows = COMMANDS.map(([id, label, description, shortcut]) => ({ id, label, description, shortcut, next: !['models','settings','left','right','tasks','casual'].includes(id), run: () => chooseCommand(id) }));
  else if (step === 'workspace' || step === 'workspace-search') rows = [
    ...(step === 'workspace' ? [{ id: 'all', label: 'All workspaces', description: 'Open workspace overview', run: () => navigate({ view: 'projects' }) }] : []),
    ...projects.map(project => ({ id: project.id, label: project.name, description: project.root_path, run: () => navigate({ view: 'project', projectId: project.id }) })),
  ];
  else if (step === 'style') rows = APPEARANCES.map(id => ({ id, label: { aero: 'Aero Glass', flat: 'Flat', skeu: 'Skeu' }[id], run: finish(() => setAppearance(id)) }));
  else if (step === 'themes') rows = themeGroups.flatMap(group => group.themes).map(item => ({ ...item, run: finish(() => theme.setTheme(item.id)) }));
  else if (step === 'load') rows = models.map(model => ({ id: model.id, label: model.name || model.id, description: engines.some(engine => engine.modelPath === model.id && engine.isLoaded) ? 'Already loaded · review settings' : 'Review load settings', run: () => { close(); setConfiguring(model); } }));
  else if (step === 'unload') rows = engines.filter(engine => engine.isLoaded).map(engine => ({ id: engine.modelPath, label: engine.modelName || engine.modelPath, run: async () => { await window.api.unloadEngine(engine.modelPath); setNotice('Model unloaded.'); } }));
  else if (step === 'chats') rows = data.map(session => ({ id: session.id, label: session.title || 'Untitled chat', description: session.project_id ? 'Workspace chat' : 'Casual chat', run: () => openChat(session.id) }));
  else if (step === 'messages') rows = data.map(match => ({ id: match.id, label: match.session_title || 'Untitled chat', description: match.excerpt.replace(/\[\/?MATCH\]/g, ''), run: () => openChat(match.session_id, match.id) }));
  else rows = data.filter(server => step === 'enable' ? server.disabled : !server.disabled).map(server => ({ id: server.name, label: server.label, description: `${server.name} · ${server.disabled ? 'Disabled' : 'Enabled'}`, run: async () => {
    await window.mcpAPI.setServerEnabled(server.name, step === 'enable');
    setData(previous => previous.map(item => item.name === server.name ? { ...item, disabled: step !== 'enable' } : item));
    setNotice(`${server.label} ${step === 'enable' ? 'enabled' : 'disabled'}.`);
  } }));
  rows = rows.filter(row => step === 'messages' || `${row.label} ${row.description || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selected = Math.min(index, Math.max(0, rows.length - 1));
  const execute = async row => {
    if (!row || executing.current || busy) return;
    executing.current = true; setBusy(true); setError('');
    try { await row.run(); } catch (problem) { setError(problem.message); }
    finally { executing.current = false; setBusy(false); }
  };
  const more = async () => {
    const token = requestRef.current;
    setBusy(true); setError('');
    try {
      const result = await window.memoryPalace.searchMessages({ query, cursor });
      if (token === requestRef.current) { setData(previous => [...previous, ...result.matches]); setCursor(result.cursor); }
    } catch (problem) { if (token === requestRef.current) setError(problem.message); }
    finally { if (token === requestRef.current) setBusy(false); }
  };
  useEffect(() => { panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected, query, step]);

  return <>
    {configuring && <ModelSettingsModal model={configuring} onClose={() => setConfiguring(null)} onLoaded={result => { onLoadedModel?.(result); setConfiguring(null); }} />}
    {open && <div className="sk-overlay fixed inset-0 z-[100] flex items-start justify-center bg-black/45 px-4 pt-[12vh]" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section ref={panel} role="dialog" aria-modal="true" aria-label="Command spotlight" className="aero-dialog sk-window sk-dialog w-full max-w-[620px] overflow-hidden text-[var(--text-primary)]" onKeyDown={event => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); step ? enter(null) : close(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(previous => rows.length ? (previous + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length : 0); input.current?.focus(); }
        else if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); execute(rows[selected]); }
        else if (event.key === 'Backspace' && !query && step && event.target === input.current) { event.preventDefault(); enter(null); }
        else if (event.key === 'Tab') {
          const controls = [...panel.current.querySelectorAll('input, button:not(:disabled)')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        {step && <div className="aero-header sk-toolbar flex items-center gap-2 px-4 py-2 text-xs text-[var(--text-muted)]"><button type="button" aria-label="Back to commands" onClick={() => enter(null)} className="aero-control sk-icon-button rounded p-1"><FiArrowLeft /></button><span>Commands / {COMMANDS.find(command => command[0] === step)?.[1]}</span></div>}
        <div className="aero-header sk-window-header flex items-center gap-3 px-5 py-4"><FiSearch className="shrink-0 text-[var(--text-muted)]" /><input ref={input} role="combobox" aria-label={step ? 'Search options' : 'Search commands'} aria-expanded="true" aria-controls="spotlight-results" aria-activedescendant={rows.length ? `spotlight-option-${selected}` : undefined} autoComplete="off" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); if (step === 'messages') { requestRef.current++; setData([]); setCursor(null); } }} placeholder={step === 'messages' ? 'Search all saved messages…' : step ? 'Type to filter…' : 'Search commands…'} className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]" /><kbd className="text-[10px] text-[var(--text-muted)]">Esc</kbd></div>
        <div className="max-h-[50vh] overflow-y-auto p-2" id="spotlight-results" role="listbox" aria-label="Commands" aria-busy={busy}>
          {rows.map((row, position) => <button key={row.id} id={`spotlight-option-${position}`} role="option" aria-selected={position === selected} type="button" disabled={busy} onMouseEnter={() => setIndex(position)} onClick={() => execute(row)} className={`aero-list-item ${position === selected ? 'sk-button' : ''} flex w-full items-center gap-3 border border-transparent ui-radius-control px-3 py-3 text-left disabled:opacity-60`}><FiCommand className={`shrink-0 ${position === selected ? 'text-current opacity-75' : 'text-[var(--text-muted)]'}`} /><span className="min-w-0 flex-1"><span className="block text-sm">{row.label}</span>{row.description && <span className={`mt-1 block truncate text-xs ${position === selected ? 'text-current opacity-75' : 'text-[var(--text-muted)]'}`}>{row.description}</span>}</span>{row.shortcut && <kbd className="text-[10px] text-[var(--text-muted)]">{row.shortcut}</kbd>}{row.next && <FiChevronRight />}</button>)}
        </div>
        {(!rows.length || busy || error || notice || cursor) && <div className="border-t border-[var(--border)] px-5 py-3 text-xs"><div role="status" className="text-[var(--text-muted)]">{busy ? 'Loading…' : notice || (!rows.length ? (step === 'messages' && !query.trim() ? 'Type a few words to search saved messages.' : 'No matching results.') : '')}</div>{error && <p role="alert" className="mt-1 text-[var(--error)]">{error}</p>}{cursor && <button type="button" disabled={busy} onClick={more} className="mt-2 underline">Search more messages</button>}</div>}
        <footer className="aero-footer sk-window-footer flex gap-4 px-5 py-2 text-[10px] text-[var(--text-muted)]"><span>↑ ↓ Navigate</span><span>Enter Select</span><span>Esc {step ? 'Back' : 'Close'}</span></footer>
      </section>
    </div>}
  </>;
}
