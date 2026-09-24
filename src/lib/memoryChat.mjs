import { mergeMetrics, phaseStats, mergePhaseStats } from './completionStats.mjs';
import { createThinkingStream } from './thinkingStream.mjs';

// Convert native definitions to the OpenAI-compatible format llama-server uses.
export function toChatTools(memoryTools) {
  return memoryTools.map(({ name, description, input_schema }) => ({
    type: 'function', function: { name, description, parameters: input_schema },
  }));
}

// Strip application metadata and normalize both native and OpenAI tool calls.
export function sanitizeChatMessages(messages) {
  const reservedIds = new Set(messages.flatMap(message =>
    (message.tool_calls ?? message.toolCalls ?? []).map(call => call.id).filter(Boolean)));
  let nextId = 0;
  let pending = [];
  const sanitized = messages.map(message => {
    const { role } = message;
    const imageParts = role === 'user' && Array.isArray(message.content) && message.content.length > 0 &&
      message.content.every(part => (part?.type === 'text' && typeof part.text === 'string') ||
        (part?.type === 'image_url' && typeof part.image_url?.url === 'string'));
    const content = imageParts ? message.content.map(part => part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: part.image_url.url } }) : message.content == null ? null
      : typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (role === 'tool') {
      // Missing IDs follow assistant call order; explicit IDs may arrive out of order.
      const index = message.tool_call_id
        ? pending.findIndex(call => call.id === message.tool_call_id) : 0;
      if (index < 0 || !pending[index]) throw new Error('Tool result has no matching assistant tool call.');
      const [call] = pending.splice(index, 1);
      return { role, tool_call_id: call.id,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '') };
    }
    if (pending.length) throw new Error('Assistant tool calls are missing tool results.');
    const calls = message.tool_calls ?? message.toolCalls;
    if (role === 'assistant' && calls?.length) {
      const tool_calls = calls.map(call => {
        let id = call.id;
        if (!id) {
          do { id = `call_${nextId++}`; } while (reservedIds.has(id));
          reservedIds.add(id);
        }
        const args = call.function?.arguments ?? call.args;
        return { id, type: 'function', function: {
          name: call.function?.name ?? call.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
        } };
      });
      if (new Set(tool_calls.map(call => call.id)).size !== tool_calls.length) {
        throw new Error('Repeated assistant tool-call ID.');
      }
      pending = [...tool_calls];
      return { role, content, tool_calls };
    }
    return { role, content };
  });
  if (pending.length) throw new Error('Assistant tool calls are missing tool results.');
  return sanitized;
}

async function readCompletion(response, onText, signal, now, onThinking) {
  if (response.headers.get('content-type')?.includes('application/json')) {
    const result = await response.json();
    if (result.error) throw new Error(result.error.message || 'Model error.');
    const choice = result.choices?.[0];
    if (!choice?.message) throw new Error('Missing model message.');
    const content = choice.message.content || '';
    const toolCalls = choice.message.tool_calls || [];
    if (toolCalls.length && choice.finish_reason !== 'tool_calls') throw new Error('Incomplete tool-call response; no tools were executed.');
    const reasoning = choice.message.reasoning_content ?? choice.message.reasoning;
    if (typeof reasoning === 'string') onThinking(reasoning);
    onText(content);
    return { content, toolCalls, usage: mergeMetrics(null, result.usage), timings: mergeMetrics(null, result.timings), endTime: now() };
  }
  if (!response.body) throw new Error('The model returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map();
  let usage = null, timings = null, endTime = null;
  let buffer = '', eventData = [], content = '', finishReason = null, done = false;
  function dispatch() {
    if (!eventData.length) return;
    const data = eventData.join('\n');
    eventData = [];
    if (data.trim() === '[DONE]') { endTime ??= now(); done = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || 'Model streaming error.');
    usage = mergeMetrics(usage, chunk.usage);
    timings = mergeMetrics(timings, chunk.timings);
    const choice = chunk.choices?.find((entry) => entry.index === 0) ?? chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string') onThinking(reasoning);
    if (typeof delta.content === 'string') { content += delta.content; onText(delta.content); }
    for (const fragment of delta.tool_calls ?? []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index >= 16) {
        throw new Error('Invalid tool-call index.');
      }
      const call = calls.get(fragment.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      if (call.function.arguments.length > 65536) throw new Error('Tool arguments exceed the size limit.');
      calls.set(fragment.index, call);
    }
  }
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (value === '') dispatch();
    else if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (!done) {
      signal?.throwIfAborted();
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let boundary;
      while (!done && (boundary = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
      }
      if (next.done) { endTime ??= now(); if (buffer) line(buffer); dispatch(); break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.length && finishReason !== 'tool_calls') {
    throw new Error('Incomplete tool-call response; no tools were executed.');
  }
  if (!finishReason && !done) throw new Error('The model stream ended unexpectedly.');
  return { content, toolCalls, usage, timings, endTime };
}

export async function runMemoryChat({
  baseUrl, apiKey, modelId, messages, memoryTools = [], chatTools, executeTool,
  onText = () => {}, onStats = () => {}, onThinking = () => {}, signal, fetchImpl = fetch, maxToolRounds = 6,
  now = () => performance.now(),
}) {
  if (!Number.isInteger(maxToolRounds) || maxToolRounds < 1 || maxToolRounds > 20) {
    throw new TypeError('maxToolRounds must be between 1 and 20.');
  }
  if (messages[0]?.role !== 'system') throw new Error('The first message must be the system prompt.');
  const history = messages.map((message) => ({ ...message }));
  const tools = chatTools ?? toChatTools(memoryTools);
  const allowedNames = new Set(tools.map((tool) => tool.function.name));
  const usedIds = new Set();
  let text = '', thinkingText = '', thinkingDuration = 0;
  const startTime = now();
  const phases = []; // Fresh for every chat invocation.

  for (let round = 0; round <= maxToolRounds; round += 1) {
    signal?.throwIfAborted();
    const phaseStart = round === 0 ? startTime : now();
    const requestPayload = {
      model: modelId, messages: sanitizeChatMessages(history), tools,
      tool_choice: round === maxToolRounds ? 'none' : 'auto',
      stream: true, stream_options: { include_usage: true }, temperature: 0.7, max_tokens: 2048,
    };
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(requestPayload),
      signal,
    });
    if (!response.ok) {
      const responseBody = await response.text();
      console.error(`Model request failed: HTTP ${response.status}`, responseBody);
      console.error('Model request payload:', JSON.stringify(requestPayload, null, 2));
      throw new Error(`Model request failed: HTTP ${response.status}`);
    }
    const priorThinking = thinkingText;
    const priorDuration = thinkingDuration;
    let visibleContent = '';
    const thinking = createThinkingStream({ now,
      onText: delta => { visibleContent += delta; text += delta; onText(delta); },
      onThinking: value => {
        thinkingText = priorThinking + (priorThinking && value.text ? '\n\n' : '') + value.text;
        thinkingDuration = priorDuration + value.duration;
        onThinking({ text: thinkingText, duration: thinkingDuration });
      },
    });
    let result;
    try { result = await readCompletion(response, thinking.text, signal, now, thinking.reasoning); }
    finally { thinking.finish(); }
    result.content = visibleContent;
    phases.push(phaseStats({ ...result, startTime: phaseStart, endTime: result.endTime ?? now() }));
    if (!result.toolCalls.length) {
      onStats(mergePhaseStats(phases, startTime));
      return text;
    }
    if (round === maxToolRounds) throw new Error('The model exceeded the memory tool-call limit.');

    for (const call of result.toolCalls) {
      if (!call.id || usedIds.has(call.id)) throw new Error('Missing or repeated tool-call ID.');
      usedIds.add(call.id);
    }
    history.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      signal?.throwIfAborted();
      let output;
      if (!allowedNames.has(call.function.name)) {
        output = { success: false, error: 'Unknown tool.' };
      } else {
        // Execution crosses the restricted preload bridge; SQLite stays in main.
        output = await executeTool({ name: call.function.name, arguments: call.function.arguments, modelId });
      }
      history.push({ role: 'tool', tool_call_id: call.id, content: typeof output === 'string' ? output : JSON.stringify(output) });
    }
  }
}
