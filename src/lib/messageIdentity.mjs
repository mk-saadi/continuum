export function activeReplyVariant(message) {
  const variant = message.variants?.[message.active_variant_index ?? 0];
  return typeof variant === 'string' ? { ...message, content: variant } : variant ?? message;
}

export function formatModelName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().split(/[\\/]/).pop().replace(/\.gguf$/i, '');
}

export function assistantLabel(message, activeModelName) {
  message = activeReplyVariant(message);
  // SQLite fields are authoritative, including an explicitly null agent name.
  // Camel-case aliases support messages that have not been persisted yet.
  const modelName = Object.hasOwn(message, 'model_name') ? message.model_name : message.modelName;
  const modelId = Object.hasOwn(message, 'model_id') ? message.model_id : message.modelId;
  const agentName = Object.hasOwn(message, 'agent_name') ? message.agent_name : message.agentName;
  return agentName || formatModelName(modelName) || formatModelName(modelId) ||
    formatModelName(activeModelName) || 'Assistant';
}
