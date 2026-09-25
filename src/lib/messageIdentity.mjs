export function formatModelName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().split(/[\\/]/).pop().replace(/\.gguf$/i, '');
}

export function assistantLabel(message, activeModelName, sessionAgent) {
  const modelName = message.modelName || message.model_name;
  const modelId = message.modelId || message.model_id;
  // A recorded turn must not inherit a persona selected for a later turn.
  const agentName = message.agentName || message.agent_name ||
    (!modelName && !modelId ? sessionAgent?.name : null);
  return agentName || formatModelName(modelName) || formatModelName(modelId) ||
    formatModelName(activeModelName) || 'Assistant';
}
