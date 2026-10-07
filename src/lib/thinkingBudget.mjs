export const DEFAULT_CONTEXT_SIZE = 32768;

export function maxThinkingBudget(contextSize = DEFAULT_CONTEXT_SIZE) {
  const context = Number.isFinite(contextSize) && contextSize > 0 ? contextSize : DEFAULT_CONTEXT_SIZE;
  return Math.max(0, Math.floor((context - 2048) / 256) * 256);
}

export function resolveThinkingBudget(value = -1, contextSize) {
  if (value === -1) return -1;
  if (!Number.isSafeInteger(value) || value < 0 || value > 65536) {
    throw new Error('Thinking budget must be -1 or an integer from 0 to 65,536 tokens.');
  }
  if (value === 0) return 0;
  const maximum = maxThinkingBudget(contextSize);
  if (maximum < 1) throw new Error('The loaded context is too small for a custom thinking budget. Select Unlimited / Default.');
  return Math.min(value, maximum);
}
