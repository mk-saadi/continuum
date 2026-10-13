'use strict';

// Assemble the same completion shape the execution layer already consumes,
// while publishing a bounded preview of the current generation.
async function readCompletion(response, onProgress) {
  // Share the parent parser: local Qwen can emit XML in content even when
  // tools are disabled. Such requests are never a visible final answer.
  const { createXmlToolCallInterceptor } = await import('../../../lib/memoryChat.mjs');
  if (!response.headers?.get('content-type')?.includes('text/event-stream')) {
    const result = await response.json();
    const message = result?.choices?.[0]?.message;
    if (typeof message?.content === 'string') {
      const xml = createXmlToolCallInterceptor();
      const original = message.content;
      message.content = xml.push(original) + xml.finish();
      if (xml.calls.length) message.tool_calls = [...(message.tool_calls ?? []), ...xml.calls];
      if (!xml.calls.length && /<tool_call\b|<function\s*=/i.test(original)) message.toolMarkupIncomplete = true;
    }
    return result;
  }
  const message = { role: 'assistant', content: '', reasoning_content: '' };
  const calls = new Map();
  const xml = createXmlToolCallInterceptor();
  let rawContent = '';
  let usage;
  let finishReason = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  function consume(frame) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || 'Sub-agent generation failed.');
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    finishReason = choice.finish_reason ?? finishReason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') {
      rawContent += delta.content;
      message.content += xml.push(delta.content);
    }
    message.reasoning_content += delta.reasoning_content ?? delta.reasoning ?? '';
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? 0;
      const call = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      call.function.name += part.function?.name ?? '';
      call.function.arguments += part.function?.arguments ?? '';
      calls.set(index, call);
    }
    if (!delta.content && !delta.reasoning_content && !delta.reasoning && !delta.tool_calls?.length) return;
    const type = delta.tool_calls?.length || xml.calls.length || /<tool_call\b|<function\s*=/i.test(rawContent) ? 'tool-planning'
      : delta.reasoning_content || delta.reasoning ? 'thinking' : 'responding';
    onProgress?.({ type, text: (type === 'thinking' ? message.reasoning_content : message.content).slice(-3000),
      tools: [...calls.values(), ...xml.calls].map(call => call.function.name).filter(Boolean) });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Keep CRLF boundaries intact even when network chunks split a CR/LF.
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, match.index).replace(/\r\n/g, '\n'));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  message.content += xml.finish();
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call).concat(xml.calls);
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (!xml.calls.length && /<tool_call\b|<function\s*=/i.test(rawContent)) message.toolMarkupIncomplete = true;
  return { choices: [{ message, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}

module.exports = { readCompletion };
