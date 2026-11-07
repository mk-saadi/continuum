import React, { useSyncExternalStore } from 'react';
import { activeReplyVariant } from '../../lib/messageIdentity.mjs';

const subscribeToNothing = () => () => {};
const noText = () => false;

// Subscribe to a boolean: only the first text chunk changes this snapshot,
// so processing status never makes the message tree render for every token.
export default function PromptProcessingGate({ message, buffer, children }) {
  const hasLiveText = useSyncExternalStore(
    buffer?.subscribe ?? subscribeToNothing,
    buffer ? () => buffer.getSnapshot().length > 0 : noText,
    noText,
  );
  const reply = activeReplyVariant(message);
  const hasOutput = hasLiveText || !!reply.content || !!reply.thinking || !!reply.thinkingText ||
    !!reply.thinking_text || (reply.thinking_duration ?? reply.thinkingDuration ?? 0) > 0 ||
    !!(reply.tool_calls ?? reply.toolCalls)?.length ||
    reply.executionSteps?.some(step => ['text', 'thought', 'tool_call'].includes(step.type));
  if (message.streaming && !hasOutput) {
    return <p role="status" aria-live="polite" className="py-1 text-sm text-[var(--text-muted)]">Prompt processing…</p>;
  }
  return children;
}
