"use strict";
// Diagnostic accounting only. No prompts or private content are persisted.
// Each JSON character belongs to exactly one bucket. Structural delimiters and
// request options are charged to serialization. Characters/4 is not a tokenizer.
function measureRequest(body, previousTools = null) {
  const parts = { nativeSchemas: 0, mcpSchemas: 0, instructions: 0,
    user: 0, history: 0, toolResults: 0, taskState: 0, otherContext: 0 };
  const size = value => JSON.stringify(value).length;
  for (const tool of body.tools || []) {
    parts[(tool.function?.name || tool.name).startsWith('mcp_') ? 'mcpSchemas' : 'nativeSchemas'] += size(tool);
  }
  for (const message of body.messages || []) {
    const text = typeof message.content === 'string' ? message.content : '';
    let key = 'history';
    if (message.role === 'tool') key = 'toolResults';
    else if (message.role === 'system' || message.role === 'developer') {
      key = /^\[(?:WORKSPACE TASK BRIEF|TASK CHECKPOINT|WORK LOG|WORKSPACE PLAN|EARLIER CONVERSATION SUMMARY)\]/.test(text) ? 'taskState'
        : /Context from attached documents:/.test(text) ? 'otherContext' : 'instructions';
    } else if (message.role === 'user') key = 'user';
    parts[key] += size(message);
  }
  // Anthropic separates system blocks from messages.
  if (body.system !== undefined) parts.instructions += size(body.system);
  const characters = size(body);
  parts.serialization = characters - Object.values(parts).reduce((sum, n) => sum + n, 0);
  const tools = JSON.stringify(body.tools || []);
  return { serializedBytes: Buffer.byteLength(JSON.stringify(body)), serializedCharacters: characters,
    estimatedInputTokens: Math.ceil(characters / 4), exactInputTokens: null,
    componentsCharacters: parts,
    componentsEstimatedTokens: Object.fromEntries(Object.entries(parts).map(([k,v]) => [k, v / 4])),
    advertisedTools: (body.tools || []).length,
    pendingToolCalls: (body.messages || []).flatMap(m => m.tool_calls || []).filter(c => !(body.messages || []).some(m => m.tool_call_id === c.id)).length,
    toolListChanged: previousTools === null ? null : previousTools !== tools,
    cacheRequested: body.cache_prompt === true, cachedPromptTokens: null,
    promptEvaluationMs: null, promptTokensEvaluated: null, outputTokens: null };
}
module.exports = { measureRequest };
