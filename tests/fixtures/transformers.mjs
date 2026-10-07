export const env = {};
export async function pipeline(task, model, options) {
  const state = globalThis.embeddingTest;
  state.loads++;
  Object.assign(state, { task, model, options, cacheDir: env.cacheDir });
  if (state.failLoad) {
    state.failLoad = false;
    throw new Error('model load failed');
  }
  return async (text, options) => {
    state.calls.push({ text, options });
    state.duringInference?.();
    return { data: new Float32Array([3, 4]) };
  };
}
