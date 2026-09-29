'use strict';
const { localEngineFetch } = require('./localEngineFetch');
const { normalizeLoadConfig } = require('./configManager');

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
module.exports = { buildLlamaServerArgs };

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
