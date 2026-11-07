import { activeReplyVariant } from './messageIdentity.mjs';
import { progressTextOffset } from './executionEvents.mjs';

// Progress text stays in canonical history, but is not the final answer.
export function finalAssistantResponse(message) {
  const variant = activeReplyVariant(message);
  if (message.streaming || ['in_progress', 'interrupted', 'cancelled', 'error'].includes(variant.status ?? message.status)) return '';
  const content = typeof variant.content === 'string' ? variant.content : '';
  const final = content.slice(progressTextOffset(variant.executionSteps));
  return final.trim() ? final : '';
}
