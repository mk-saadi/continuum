export function activeReplyVariant(message) {
  const variant = message.variants?.[message.active_variant_index ?? 0];
  if (typeof variant === 'string') return { ...message, content: variant };
  if (!variant) return message;
  // Older variants may omit displayName while the finalized message has it.
  // An explicit null belongs to that variant and must not inherit another name.
  if (!Object.hasOwn(variant, 'displayName') && !Object.hasOwn(variant, 'display_name')) {
    return { ...variant, displayName: message.displayName || message.display_name || null };
  }
  return variant;
}

export function formatModelName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().split(/[\\/]/).pop().replace(/\.gguf$/i, '');
}

export function resolveDisplayName(settings, modelPath, modelFilename) {
  const perModel = settings?.perModelNames;
  const custom = perModel && Object.hasOwn(perModel, modelPath) ? perModel[modelPath] : '';
  return (typeof custom === 'string' && custom.trim()) ||
    (typeof settings?.globalModelName === 'string' && settings.globalModelName.trim()) ||
    modelFilename || 'Assistant';
}

export function assistantLabel(message, activeModelName) {
  message = activeReplyVariant(message);
  // SQLite fields are authoritative, including an explicitly null agent name.
  // Camel-case aliases support messages that have not been persisted yet.
  const modelName = Object.hasOwn(message, 'model_name') ? message.model_name : message.modelName;
  const modelId = Object.hasOwn(message, 'model_id') ? message.model_id : message.modelId;
  const agentName = Object.hasOwn(message, 'agent_name') ? message.agent_name : message.agentName;
  const displayName = message.display_name || message.displayName;
  return (typeof displayName === 'string' && displayName.trim()) || agentName || formatModelName(modelName) || formatModelName(modelId) || formatModelName(message.model) ||
    formatModelName(activeModelName) || 'Assistant';
}
