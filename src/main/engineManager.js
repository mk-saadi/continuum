'use strict';
const { normalizeLoadConfig } = require('./configManager');

// Pass this array directly to spawn with shell:false. Paths remain single arguments.
function buildLlamaServerArgs(model, input, port) {
  if (!model || typeof model.modelPath !== 'string' || !model.modelPath || model.modelPath.includes('\0')) throw new Error('Invalid model path.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port.');
  const config = normalizeLoadConfig(input);
  const args = ['-m', model.modelPath, '--jinja'];
  const flags = { contextLength: '-c', gpuOffload: '-ngl', threads: '-t', evalBatch: '-b', physicalBatch: '-ub', parallel: '-np', loadMode: '-lm', flashAttention: '-fa' };
  for (const [key, flag] of Object.entries(flags)) args.push(flag, String(config[key]));
  if (config.seed !== undefined) args.push('-s', String(config.seed));
  args.push('--port', String(port));
  if ((model.hasVisionProjector || model.isVision) && model.mmprojPath) {
    if (typeof model.mmprojPath !== 'string' || model.mmprojPath.includes('\0')) throw new Error('Invalid projector path.');
    args.push('--mmproj', model.mmprojPath);
  }
  return args;
}
module.exports = { buildLlamaServerArgs };

// One warmup per process, across both output streams and split log chunks.
function createStartupHandler({ port = 8080, apiKey = '', getTools, onStatus, fetchImpl = fetch, timeoutMs = 120000 }) {
  const { BASE_SYSTEM_PROMPT_WITH_TOOLS } = require('./baseSystemPrompt');
  const controller = new AbortController();
  const buffers = { stdout: '', stderr: '' };
  let started = false;
  let loaded = false;
  let listening = false;
  let timer;
  async function warmup() {
    onStatus('warming');
    timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const tools = await getTools();
      controller.signal.throwIfAborted();
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
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
    } finally {
      clearTimeout(timer);
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
    cancel() { cancelled = true; clearTimeout(timer); controller.abort(); },
  };
}

module.exports.createStartupHandler = createStartupHandler;
