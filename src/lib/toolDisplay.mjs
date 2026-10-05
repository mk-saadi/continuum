export const TOOL_DISPLAY_LIMIT = 10_000;

function preview(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length <= TOOL_DISPLAY_LIMIT
    ? value : `${value.slice(0, TOOL_DISPLAY_LIMIT)}\n… [output truncated in chat; full result saved in session]`;
  const json = JSON.stringify(value);
  return json.length <= TOOL_DISPLAY_LIMIT ? value
    : `${json.slice(0, TOOL_DISPLAY_LIMIT)}\n… [output truncated in chat; full result saved in session]`;
}

export function compactStepsForDisplay(steps, previousSteps) {
  if (!steps) return steps;
  const settled = new Map(previousSteps?.filter(step =>
    step.type === 'tool_call' && ['complete', 'error', 'cancelled'].includes(step.status)
  ).map(step => [step.id, step]));
  return steps.map(step => {
    // Completed tools never change again within a run. Reuse their previews so
    // old cards do not reformat and render for each later step snapshot.
    const prior = settled.get(step.id);
    if (prior && prior.status === step.status && prior.toolName === step.toolName) return prior;
    return {
      ...step,
      args: preview(step.args),
      result: preview(step.result),
      error: preview(step.error),
      streamingArguments: preview(step.streamingArguments),
    };
  });
}

export function compactMessageForDisplay(message) {
  if (!message || message.role !== 'assistant') return message;
  return {
    ...message,
    executionSteps: compactStepsForDisplay(message.executionSteps),
    tool_calls: compactStepsForDisplay(message.tool_calls),
    toolCalls: compactStepsForDisplay(message.toolCalls),
    variants: message.variants?.map(variant => ({
      ...variant,
      executionSteps: compactStepsForDisplay(variant.executionSteps),
      tool_calls: compactStepsForDisplay(variant.tool_calls),
      toolCalls: compactStepsForDisplay(variant.toolCalls),
    })),
  };
}
