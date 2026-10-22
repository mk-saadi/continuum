// Each invocation advances the hook's ref, including overlapping requests.
// Results must also belong to the currently selected session/model.
export function acceptsContextMeasurement(sequence, currentSequence, result, sessionId, modelId) {
  return sequence === currentSequence && result?.sessionId === sessionId && result?.modelId === modelId;
}
