export const DEFAULT_CONTEXT_SIZE = 32768;

export function maxThinkingBudget(contextSize = DEFAULT_CONTEXT_SIZE) {
  const context = Number.isFinite(contextSize) && contextSize > 0 ? contextSize : DEFAULT_CONTEXT_SIZE;
  return Math.max(0, Math.floor((context - 2048) / 256) * 256);
}

export function resolveThinkingBudget(value = -1, contextSize) {
  if (value === -1) return -1;
  if (!Number.isSafeInteger(value) || value < 256 || value % 256 !== 0) {
    throw new Error('Thinking budget must be -1 or a multiple of 256 tokens.');
  }
  const maximum = maxThinkingBudget(contextSize);
  if (maximum < 256) throw new Error('The loaded context is too small for a custom thinking budget. Select Unlimited / Default.');
  return Math.min(value, maximum);
}
