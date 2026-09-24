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
  if (model.isVision && model.mmprojPath) {
    if (typeof model.mmprojPath !== 'string' || model.mmprojPath.includes('\0')) throw new Error('Invalid projector path.');
    args.push('--mmproj', model.mmprojPath);
  }
  return args;
}
module.exports = { buildLlamaServerArgs };
