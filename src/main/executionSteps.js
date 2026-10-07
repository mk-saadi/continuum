'use strict';

function normalizeExecutionSteps(steps) {
  if (steps == null) return null;
  if (!Array.isArray(steps)) throw new TypeError('executionSteps must be an array.');
  for (const step of steps) {
    if (!step || typeof step !== 'object') throw new TypeError('Invalid execution step.');
    if (step.type === 'thought') {
      if (typeof step.content !== 'string' || !Number.isFinite(step.durationMs) || step.durationMs < 0) throw new TypeError('Invalid thought step.');
    } else if (step.type === 'tool_call') {
      if (typeof step.toolName !== 'string' || !['preparing', 'pending', 'running', 'complete', 'error'].includes(step.status) ||
          (step.serverName != null && typeof step.serverName !== 'string') ||
          (step.args != null && (typeof step.args !== 'object' || Array.isArray(step.args)))) throw new TypeError('Invalid tool step.');
    } else throw new TypeError('Unknown execution step type.');
  }
  return JSON.parse(JSON.stringify(steps));
}

// Old records did not retain ordering; preserve their known metadata as a fallback.
function readExecutionSteps(row) {
  const raw = row.executionSteps ?? row.execution_steps;
  if (raw != null) {
    try { return normalizeExecutionSteps(typeof raw === 'string' ? JSON.parse(raw) : raw) || []; }
    catch { return []; }
  }
  const steps = [];
  const thought = row.thinking ?? row.thinking_text ?? row.thinkingText;
  if (thought) steps.push({ type: 'thought', content: thought, durationMs: Math.max(0, (row.thinking_duration ?? row.thinkingDuration ?? 0) * 1000) });
  let tools = row.tool_calls ?? row.toolCalls ?? [];
  try { if (typeof tools === 'string') tools = JSON.parse(tools); } catch { tools = []; }
  if (Array.isArray(tools)) for (const tool of tools) steps.push({ ...tool, type: 'tool_call', toolName: tool.toolName ?? tool.function?.name ?? 'Tool', args: tool.args ?? null,
    status: tool.status === 'cancelled' ? 'error' : tool.status ?? 'complete' });
  return steps;
}
module.exports = { normalizeExecutionSteps, readExecutionSteps };
