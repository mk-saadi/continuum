import React, { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { GrAttachment } from 'react-icons/gr';
import { FaStop } from 'react-icons/fa';
import { IoSend } from 'react-icons/io5';
import useSessionDraft from '../hooks/useSessionDraft';

const ChatInput = memo(forwardRef(function ChatInput({ sessionId, onSubmit, onStop, onAttach,
  canSubmit, hasAttachments, streaming, loading, attachDisabled, sendTitle,
  supportedEfforts = [], reasoningEffort, onEffortChange, showEffort }, ref) {
  // This hook owns the local text and the cancellable 1-second storage debounce.
  const { input: draftText, updateDraft, clearSubmitted } = useSessionDraft(sessionId);
  const textarea = useRef(null);
  useImperativeHandle(ref, () => ({ clearSubmitted }), [clearSubmitted]);
  useLayoutEffect(() => {
    const element = textarea.current;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draftText]);
  const ready = canSubmit && !streaming && !loading && (draftText.trim() || hasAttachments);
  const submit = () => { if (ready) onSubmit(draftText); };
  return <>
    <textarea ref={textarea} aria-label="Message"
      className="max-h-[200px] sm:max-h-[350px] min-h-[38px] w-full resize-none overflow-y-auto rounded-md py-[9px] text-sm leading-normal text-[var(--text-primary)] transition-colors duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      value={draftText} onChange={event => updateDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          if (!event.repeat) submit();
        }
      }} placeholder="Type a message..." rows={1} />
    <div className="flex items-center justify-between gap-2">
      <button type="button" aria-label="Attach files" title="Attach images, PDF, TXT, Markdown, or CSV"
        disabled={streaming || loading || attachDisabled} onClick={onAttach}
        className="flex shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"><GrAttachment /></button>
      {showEffort && supportedEfforts.length > 0 && <label className="ml-auto flex items-center gap-1 text-xs text-[var(--text-secondary)]">
        <span>🧠 Effort:</span>
        <select aria-label="Reasoning effort" value={reasoningEffort} disabled={streaming || loading}
          onChange={event => onEffortChange(event.target.value)}
          className="max-w-32 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text-primary)]">
          {supportedEfforts.map(effort => <option key={effort} value={effort}>{effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
        </select>
      </label>}
      <button type="button" title={streaming ? 'Stop' : sendTitle} aria-label={streaming ? 'Stop' : 'Send'}
        onClick={streaming ? onStop : submit} disabled={!streaming && !ready}
        className="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-[var(--accent)] text-[var(--on-accent)] transition-all duration-300 hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40">
        {streaming ? <FaStop /> : <IoSend />}
      </button>
    </div>
  </>;
}));

export default ChatInput;
