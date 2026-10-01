'use strict';
const { localEngineFetch } = require('./localEngineFetch');
const { normalizeLoadConfig } = require('./configManager');
const { createHash } = require('node:crypto');

const TOOL_OUTPUT_LIMIT = 20000;
const TOOL_OUTPUT_NOTICE = '\n\n[SYSTEM NOTICE: Tool output exceeded context threshold (20,000 chars) and was safely truncated by Continuum Engine to prevent context overflow.]';

function truncateToolOutput(toolResult) {
  const isMediaParts = Array.isArray(toolResult) && toolResult.every(part =>
    part?.type === 'text' && typeof part.text === 'string' || part?.type === 'image_url');
  // Image bytes are carried as multimodal attachments, not tokenizer-facing text.
  const measure = value => JSON.stringify(isMediaParts ? value.map(part => part.type === 'image_url'
    ? { type: 'image_url', image_url: { url: '[attached image]' } } : part) : value ?? '').length;
  if (measure(toolResult) <= TOOL_OUTPUT_LIMIT) return toolResult;
  const images = isMediaParts ? toolResult.filter(part => part.type === 'image_url') : [];
  const source = isMediaParts ? toolResult.filter(part => part.type === 'text').map(part => part.text).join('\n')
    : typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? '');
  const wrap = count => {
    let prefix = source.slice(0, count);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    const text = prefix + TOOL_OUTPUT_NOTICE;
    return isMediaParts ? [{ type: 'text', text }, ...images] : text;
  };
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(wrap(middle)) <= TOOL_OUTPUT_LIMIT) low = middle;
    else high = middle - 1;
  }
  return wrap(low);
}

function generationSamplingParams(params, thinkingBudget) {
  if (thinkingBudget === undefined) return params;
  if (!Number.isSafeInteger(thinkingBudget) || (thinkingBudget !== -1 && (thinkingBudget < 0 || thinkingBudget > 65536))) {
    throw new Error('Invalid thinking budget.');
  }
  return { ...params, thinking_budget: thinkingBudget };
}

// Pass this array directly to spawn with shell:false. Paths remain single arguments.
function buildLlamaServerArgs(model, input, port) {
  if (!model || typeof model.modelPath !== 'string' || !model.modelPath || model.modelPath.includes('\0')) throw new Error('Invalid model path.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port.');
  const config = normalizeLoadConfig(input);
  const args = ['-m', model.modelPath, '--jinja'];
  const flags = { contextLength: '-c', gpuOffload: '-ngl', threads: '-t', evalBatch: '-b', physicalBatch: '-ub', parallel: '-np', flashAttention: '-fa' };
  for (const [key, flag] of Object.entries(flags)) args.push(flag, String(config[key]));
  args.push('--cache-type-k', config.cacheTypeK, '--cache-type-v', config.cacheTypeV);
  if (config.mlock) args.push('--mlock');
  if (config.chatTemplate !== 'auto') args.push('--chat-template', config.chatTemplate);
  args.push('--reasoning-format', config.reasoningFormat);
  if (config.seed !== undefined) args.push('-s', String(config.seed));
  args.push('--port', String(port));
  if ((model.hasVisionProjector || model.isVision) && model.mmprojPath) {
    if (typeof model.mmprojPath !== 'string' || model.mmprojPath.includes('\0')) throw new Error('Invalid projector path.');
    args.push('--mmproj', model.mmprojPath);
  }
  return args;
}
module.exports = { buildLlamaServerArgs, generationSamplingParams, truncateToolOutput, TOOL_OUTPUT_NOTICE };

function buildLlamaServerEnv(source = process.env) {
  const env = { ...source };
  // Parent shell settings must not silently enable local server authentication.
  for (const key of ['LLAMA_API_KEY', 'LLAMA_API_KEY_FILE', 'LLAMA_ARG_API_KEY', 'LLAMA_ARG_API_KEY_FILE']) delete env[key];
  env.LLAMA_ARG_CORS_ORIGINS = '*';
  env.LLAMA_ARG_CORS_HEADERS = '*';
  env.LLAMA_ARG_CORS_METHODS = 'GET, POST, DELETE, OPTIONS';
  return env;
}
module.exports.buildLlamaServerEnv = buildLlamaServerEnv;

// One warmup per process, across both output streams and split log chunks.
function createStartupHandler({ port = 8080, getTools, onStatus, fetchImpl = localEngineFetch }) {
  const { BASE_SYSTEM_PROMPT_WITH_TOOLS } = require('./baseSystemPrompt');
  const controller = new AbortController();
  const buffers = { stdout: '', stderr: '' };
  let started = false;
  let loaded = false;
  let listening = false;
  async function warmup() {
    onStatus('warming');
    try {
      const tools = await getTools();
      controller.signal.throwIfAborted();
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: [
            { role: 'system', content: BASE_SYSTEM_PROMPT_WITH_TOOLS },
            { role: 'user', content: 'Warmup sequence initialized.' },
          ],
          tools, tool_choice: 'auto', max_tokens: 1, stream: false, cache_prompt: true,
        }),
      });
      if (!response.ok) throw new Error(`Context warmup failed: HTTP ${response.status}`);
      const result = await response.json(); // Wait for prefill and generation, not just headers.
      if (result.error || !result.choices?.[0]?.message) throw new Error(result.error?.message || 'Invalid warmup response.');
      if (!controller.signal.aborted) onStatus('ready');
    } catch (error) {
      if (!cancelled) onStatus('warmup-failed', error.message);
    }
  }
  let cancelled = false;
  return {
    onOutput(data, stream = 'stdout') {
      if (started || cancelled) return;
      buffers[stream] = (buffers[stream] + data.toString()).slice(-16384);
      loaded ||= /model loaded/i.test(buffers[stream]);
      listening ||= /(?:listening|server is listening)/i.test(buffers[stream]);
      if (loaded && listening) {
        started = true;
        void warmup();
      }
    },
    cancel() { cancelled = true; controller.abort(); },
  };
}

module.exports.createStartupHandler = createStartupHandler;


// Each loaded process owns its service, so old requests cannot reset a new model's timer.
function createIdleService({ onIdle, getIdleMinutes = () => require('./configStore').getConfig().engineIdleTimeoutMinutes,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer;
  let keepAliveMinutes = -1;
  let active = 0;
  let disposed = false;
  function resetIdleTimer(minutes = getIdleMinutes()) {
    if (![-1, 5, 15, 60].includes(minutes)) throw new Error('Invalid keepAliveMinutes setting.');
    keepAliveMinutes = minutes;
    clearTimer(timer);
    timer = undefined;
    if (disposed || active || minutes === -1) return;
    timer = setTimer(() => {
      timer = undefined;
      if (!disposed && !active && keepAliveMinutes !== -1) onIdle();
    }, minutes * 60_000);
    timer?.unref?.();
  }
  return {
    resetIdleTimer,
    beginRequest() {
      if (disposed) return () => {};
      active++;
      resetIdleTimer();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        active--;
        resetIdleTimer();
      };
    },
    dispose() { disposed = true; clearTimer(timer); },
  };
}
module.exports.createIdleService = createIdleService;

// Synchronous commits ensure each published snapshot survives process termination.
function createMessagePersistence({ sessionId, modelId, modelName, displayName, agentName }) {
  const { db } = require('./db');
  const { variantFromRow } = require('./messageVariants');
  const messageId = Number(db.prepare(`INSERT INTO messages
    (session_id, role, content, status, model_id, model_name, display_name, agent_name)
    VALUES (?, 'assistant', '', 'in_progress', ?, ?, ?, ?)`).run(
      sessionId, modelId, modelName ?? modelId, displayName, agentName ?? null).lastInsertRowid);
  return {
    messageId,
    update({ content, executionSteps, stats, status = 'in_progress' }) {
      db.transaction(() => {
        db.prepare(`UPDATE messages SET content = ?, execution_steps = ?, tool_calls = ?,
          stats = ?, estimated_tokens = ?, status = ? WHERE id = ? AND session_id = ?`).run(
          content, JSON.stringify(executionSteps),
          JSON.stringify(executionSteps.filter(step => step.type === 'tool_call')),
          stats ? JSON.stringify(stats) : null, Math.ceil(content.length / 4), status, messageId, sessionId);
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        if (!row) throw new Error('Assistant message was deleted during generation.');
        db.prepare('UPDATE messages SET variants = ? WHERE id = ?').run(JSON.stringify([variantFromRow(row)]), messageId);
        db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
      })();
    },
  };
}
module.exports.createMessagePersistence = createMessagePersistence;

// A renderer may host several chat tabs. Controllers belong to sessions, not
// to whichever tab happens to be visible when an IPC event is delivered.
const activeStreams = new Map();
module.exports.activeStreams = activeStreams;

// Only completed tool attempts are eligible. A nonzero shell exit is an error
// even when the command tool itself returned a well-formed result object.
function failedToolReason(output, toolName = '') {
  if (typeof output === 'string') {
    try { return failedToolReason(JSON.parse(output), toolName); }
    catch {
      if (/\b(?:ENOENT|no such file or directory|file not found|path does not exist)\b/i.test(output)) return 'A file path was not found.';
      if (/\b(?:execution blocked|permission denied|approval denied|rejected call)\b/i.test(output)) return 'A tool call was rejected.';
      return null;
    }
  }
  if (!output || typeof output !== 'object') return null;
  if (Array.isArray(output)) return output.map(item => failedToolReason(item, toolName)).find(Boolean) ?? null;
  if (typeof output.exitCode === 'number' && output.exitCode !== 0) {
    return `Command exited with status ${output.exitCode}.`;
  }
  if (output.isError === true || output.success === false) {
    const detail = String(output.error ?? output.message ?? '');
    if (/\b(?:ENOENT|no such file or directory|file not found|path does not exist)\b/i.test(detail)) return 'A file path was not found.';
    if (/\b(?:execution blocked|permission denied|approval denied|rejected)\b/i.test(detail)) return 'A tool call was rejected.';
    return /(?:command|shell|execute)/i.test(toolName) ? 'A shell command failed.' : 'A tool call failed.';
  }
  if (Array.isArray(output.content)) return failedToolReason(output.content, toolName);
  if (typeof output.text === 'string') return failedToolReason(output.text, toolName);
  return null;
}
module.exports.failedToolReason = failedToolReason;

// This only changes an in-memory prompt snapshot. Persisted messages and
// execution_steps remain the complete audit trail of what actually happened.
function rewindFailedTurnRange(messages, startTurnIndex) {
  if (!Array.isArray(messages) || !Number.isInteger(startTurnIndex) || startTurnIndex < 0 || startTurnIndex >= messages.length) return messages;
  const range = messages.slice(startTurnIndex);
  if (range.some(message => message.role === 'user')) return messages;
  const isCall = message => message.role === 'tool_call' || (message.role === 'assistant' &&
    (message.tool_calls?.length || message.toolCalls?.length));
  const calls = range.filter(isCall);
  if (!calls.length) return messages;
  const ids = new Set(calls.flatMap(message => message.role === 'tool_call'
    ? [message.id ?? message.tool_call_id] : (message.tool_calls ?? message.toolCalls).map(call => call.id)));
  if (ids.has(undefined) || range.some(message => message.role === 'tool' && !ids.has(message.tool_call_id))) return messages;
  const results = range.filter(message => message.role === 'tool' && ids.has(message.tool_call_id));
  // Never leave an unmatched tool call in the prompt or hide an incomplete run.
  if (ids.size !== results.length) return messages;
  const primaryError = results.map(message => failedToolReason(message.content) ||
    (message.status === 'error' ? failedToolReason({ success: false, error: message.error }) : null)).find(Boolean);
  if (!primaryError) return messages;
  const summary = `[CONTEXT REWOUND]: Previous failed tool attempts were removed from active context to optimize context space. Primary error encountered: ${primaryError} Proceeding with alternative strategy.`;
  const retained = range.filter(message => !isCall(message) &&
    !(message.role === 'tool' && ids.has(message.tool_call_id)));
  return [...messages.slice(0, startTurnIndex), { role: 'system', content: summary }, ...retained];
}
module.exports.rewindFailedTurnRange = rewindFailedTurnRange;

// Create once per chat run. The window counts attempted dispatches; the third
// identical call is intercepted before it reaches any native or MCP executor.
function createProjectToolLoopGuard(projectId) {
  const recentTools = [];
  return {
    recentTools,
    inspect(toolName, args) {
      if (!projectId) return null;
      const argsHash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
      recentTools.push({ toolName, argsHash });
      if (recentTools.length > 3) recentTools.shift();
      if (recentTools.length !== 3 ||
          !recentTools.every(entry => entry.toolName === toolName && entry.argsHash === argsHash)) return null;
      recentTools.length = 0;
      return `[LOOP DETECTED]: You have executed '${toolName}' 3 times with identical arguments without making progress. Step back, re-evaluate your plan, or ask the user for guidance.`;
    },
  };
}
module.exports.createProjectToolLoopGuard = createProjectToolLoopGuard;
