// Focused coverage for the GPU offload preflight/verification helpers and the
// startup-handler integration that reports the runtime's real offload state.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  kvElementBytes,
  parseGpuQueryOutput,
  queryGpuMemory,
  estimateOffloadRequirements,
  assessGpuFit,
  describeGpuFitWarning,
  shouldPreflightOffload,
  parseOffloadDiagnostics,
  evaluateOffloadResult,
  DEFAULT_SAFETY_MARGIN_MIB,
} = require('../src/main/gpuMemory');
const { createStartupHandler, buildLlamaServerArgs, buildLlamaServerEnv } = require('../src/main/engineManager');
const { normalizeLoadConfig } = require('../src/main/configManager');

const GIB = 1024 * 1024 * 1024;
const model = () => ({
  modelPath: '/models/test.gguf',
  fileIdentity: { size: 10 * GIB },
  layerCount: 64,
  attentionHeads: 32,
  kvHeads: 8,
  embeddingLength: 4096,
  architecture: 'qwen3',
});
const config = (overrides = {}) =>
  normalizeLoadConfig({ contextLength: 100000, cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', gpuOffload: 'auto', ...overrides });

test('KV element sizes fall back to f16 for unknown types', () => {
  assert.equal(kvElementBytes('f16'), 2);
  assert.equal(kvElementBytes('bf16'), 2);
  assert.equal(kvElementBytes('q8_0'), 34 / 32);
  assert.equal(kvElementBytes('q4_0'), 18 / 32);
  assert.equal(kvElementBytes('not-a-type'), 2);
});

test('GPU query output parses devices and ignores malformed lines', () => {
  assert.deepEqual(parseGpuQueryOutput('0, NVIDIA GeForce RTX 5060 Ti, 16311, 15300\n'), [
    { index: 0, name: 'NVIDIA GeForce RTX 5060 Ti', totalMiB: 16311, freeMiB: 15300 },
  ]);
  assert.deepEqual(parseGpuQueryOutput('1, Arc A770, 8192, 7000\n0, name, 1200, 900\n'), [
    { index: 1, name: 'Arc A770', totalMiB: 8192, freeMiB: 7000 },
    { index: 0, name: 'name', totalMiB: 1200, freeMiB: 900 },
  ]);
  assert.deepEqual(parseGpuQueryOutput('not, a, row\n'), []);
  assert.deepEqual(parseGpuQueryOutput(''), []);
});

test('GPU query resolves to available/unavailable instead of throwing', async () => {
  const ok = await queryGpuMemory({ execFileImpl: (_c, _a, _o, cb) => cb(null, '0, GPU, 16311, 15300\n') });
  assert.equal(ok.available, true);
  assert.equal(ok.devices[0].freeMiB, 15300);

  const missing = await queryGpuMemory({ execFileImpl: (_c, _a, _o, cb) => cb(Object.assign(new Error('nope'), { code: 'ENOENT' })) });
  assert.deepEqual(missing, { available: false, reason: 'gpu-query-missing' });

  const empty = await queryGpuMemory({ execFileImpl: (_c, _a, _o, cb) => cb(null, '') });
  assert.deepEqual(empty, { available: false, reason: 'gpu-query-empty' });

  const unavailable = await queryGpuMemory({ execFileImpl: false });
  assert.deepEqual(unavailable, { available: false, reason: 'gpu-query-unavailable' });

  const failed = await queryGpuMemory({ execFileImpl: (_c, _a, _o, cb) => cb(new Error('driver error')) });
  assert.deepEqual(failed, { available: false, reason: 'gpu-query-failed' });
});

test('estimate includes weights, KV, compute and projector when metadata permits', () => {
  const estimate = estimateOffloadRequirements({ model: model(), config: config() });
  assert.equal(estimate.expectedFullOffload, true);
  assert.equal(estimate.confidence, 'high');
  assert.ok(estimate.components.weightsMiB === 10240, 'weights use the full file size for full offload');
  // 64 layers * 8 kv heads * 128 head-dim * 100000 tokens * (1.0625 + 0.5625) bytes
  assert.ok(Math.abs(estimate.components.kvMiB - 10158) < 2, `kv ~10158, got ${estimate.components.kvMiB}`);
  assert.ok(estimate.components.computeMiB >= 256);
  assert.equal(estimate.components.projectorMiB, null);
  assert.ok(estimate.totalMiB > 21000 && estimate.totalMiB < 22000, `total ~21115, got ${estimate.totalMiB}`);
});

test('attention-layer count and explicit key/value lengths drive the KV estimate', () => {
  // Hybrid model: only 1 in 4 layers keeps a KV cache, with explicit head dims.
  const hybridModel = { ...model(), kvHeads: 4, keyLength: 256, valueLength: 256, fullAttentionInterval: 4 };
  const hybrid = estimateOffloadRequirements({ model: hybridModel, config: config() });
  assert.equal(hybrid.confidence, 'high');
  // ceil(64 / 4) = 16 attention layers * 4 kv heads * (256*1.0625 + 256*0.5625)
  const expected = (Math.ceil(64 / 4) * 4 * (256 * 1.0625 + 256 * 0.5625) * 100000) / (1024 * 1024);
  assert.ok(Math.abs(hybrid.components.kvMiB - expected) < 1, `kv ${hybrid.components.kvMiB} ~ ${expected}`);
  assert.ok(hybrid.components.kvMiB < 3000, 'a naive full-layer estimate would be ~4x too high');
});

test('a multimodal projector adds its file size to the estimate', () => {
  const withProjector = estimateOffloadRequirements({
    model: { ...model(), mmprojPath: '/models/mmproj.gguf' },
    config: config(),
    projectorBytes: 900 * 1024 * 1024,
  });
  assert.ok(Math.abs(withProjector.components.projectorMiB - 900) < 1);
  assert.equal(withProjector.confidence, 'high');
  const missingSize = estimateOffloadRequirements({ model: { ...model(), mmprojPath: '/models/mmproj.gguf' }, config: config() });
  assert.equal(missingSize.confidence, 'medium');
  assert.ok(missingSize.notes.includes('projector-size-unknown'));
});

test('manual partial offload scales weights and is not treated as expecting full offload', () => {
  const estimate = estimateOffloadRequirements({ model: model(), config: config({ gpuOffload: 32 }) });
  assert.equal(estimate.expectedFullOffload, false);
  assert.ok(estimate.components.weightsMiB < 10240);
  const all = estimateOffloadRequirements({ model: model(), config: config({ gpuOffload: 999 }) });
  assert.equal(all.expectedFullOffload, true);
  const none = estimateOffloadRequirements({ model: model(), config: config({ gpuOffload: 0 }) });
  assert.equal(none.components.weightsMiB, 0);
});

test('KV offloaded to CPU removes the KV component', () => {
  const estimate = estimateOffloadRequirements({ model: model(), config: config({ kvCacheOffload: 'cpu' }) });
  assert.equal(estimate.components.kvMiB, 0);
});

test('estimation without model size or KV shape degrades to low confidence', () => {
  const noSize = estimateOffloadRequirements({ model: { ...model(), fileIdentity: null }, config: config() });
  assert.equal(noSize.totalMiB, null);
  assert.equal(noSize.confidence, 'low');
  const noKv = estimateOffloadRequirements({ model: { ...model(), kvHeads: null, attentionHeads: null, embeddingLength: null }, config: config() });
  assert.equal(noKv.confidence, 'medium');
  assert.ok(noKv.notes.includes('kv-shape-unknown'));
});

test('assessGpuFit classifies sufficient, insufficient, and unknown', () => {
  const estimate = estimateOffloadRequirements({ model: model(), config: config() });
  const sufficient = assessGpuFit({ estimate, memory: { available: true, devices: [{ index: 0, name: 'GPU', totalMiB: 48000, freeMiB: 30000 }] } });
  assert.equal(sufficient.status, 'sufficient');
  const insufficient = assessGpuFit({ estimate, memory: { available: true, devices: [{ index: 0, name: 'GPU', totalMiB: 16311, freeMiB: 15300 }] } });
  assert.equal(insufficient.status, 'insufficient');
  assert.ok(insufficient.headroomMiB < 0);
  assert.equal(insufficient.safetyMarginMiB, DEFAULT_SAFETY_MARGIN_MIB);
  // A device that has just enough to fit the weights but not the safety margin is still flagged.
  const tight = assessGpuFit({ estimate, memory: { available: true, devices: [{ index: 0, name: 'GPU', totalMiB: 22000, freeMiB: estimate.totalMiB + 100 }] } });
  assert.equal(tight.status, 'insufficient');
  // Query failure and an unavailable estimate both resolve to unknown, never a failure.
  assert.equal(assessGpuFit({ estimate, memory: { available: false, reason: 'gpu-query-missing' } }).status, 'unknown');
  assert.equal(assessGpuFit({ estimate: { totalMiB: null }, memory: { available: true, devices: [{ freeMiB: 999 }] } }).status, 'unknown');
});

test('the preflight warning explains headroom versus margin when the estimate still fits', () => {
  // The report that exposed this: 15,185 needed, 15,834 free — it fits, yet it warns.
  const message = describeGpuFitWarning({
    estimatedMiB: 15185,
    freeMiB: 15834,
    headroomMiB: 649,
    safetyMarginMiB: 1024,
    device: { name: 'NVIDIA GeForce RTX 5060 Ti' },
  });
  assert.match(message, /15,185 MiB/);
  assert.match(message, /15,834 MiB/);
  assert.match(message, /649 MiB of headroom/);
  assert.match(message, /1,024 MiB safety margin/);
  // It must not read as "it does not fit".
  assert.doesNotMatch(message, /short|not fit/i);
});

test('the advisory preflight only applies to automatic offload', () => {
  // `-ngl auto` is unset, so the loader may silently reduce it — worth warning about.
  assert.equal(shouldPreflightOffload({ gpuOffload: 'auto' }), true);
  assert.equal(shouldPreflightOffload({}), true);
  assert.equal(shouldPreflightOffload(null), true);
  // An explicit count cannot be adjusted by the loader, so a tight fit fails
  // loudly (OOM) instead of degrading quietly. A manual 999999 load succeeded
  // with under a gigabyte free on the reporting machine.
  assert.equal(shouldPreflightOffload({ gpuOffload: 999999 }), false);
  assert.equal(shouldPreflightOffload({ gpuOffload: 65 }), false);
  assert.equal(shouldPreflightOffload({ gpuOffload: 0 }), false);
  assert.equal(shouldPreflightOffload({ gpuOffload: 30 }), false);
});

test('the preflight warning states the shortfall when the estimate exceeds free memory', () => {
  const message = describeGpuFitWarning({
    estimatedMiB: 15439,
    freeMiB: 4200,
    headroomMiB: -11239,
    safetyMarginMiB: 1024,
    device: { name: 'NVIDIA GeForce RTX 5060 Ti' },
  });
  assert.match(message, /11,239 MiB short/);
  assert.doesNotMatch(message, /headroom/);
});

test('offload diagnostics parse the fork log format, including split supervision', () => {
  assert.deepEqual(parseOffloadDiagnostics('load_tensors: offloaded 65/65 layers to GPU'), { offloaded: 65, total: 65 });
  assert.deepEqual(parseOffloadDiagnostics('llm_load_tensors: offloaded 33/65 layers to GPU'), { offloaded: 33, total: 65 });
  assert.deepEqual(parseOffloadDiagnostics('load_tensors: offloading 63 repeating layers to GPU'), { offloaded: 63, total: null });
  // The last summary wins when the loader logs more than once.
  assert.deepEqual(parseOffloadDiagnostics('load_tensors: offloaded 1/65 layers to GPU\nload_tensors: offloaded 65/65 layers to GPU'), { offloaded: 65, total: 65 });
  assert.equal(parseOffloadDiagnostics('nothing useful here'), null);
  assert.equal(parseOffloadDiagnostics(''), null);
});

test('offload results distinguish full, unexpected, requested, and resource-limited', () => {
  assert.equal(evaluateOffloadResult({ diagnostics: { offloaded: 65, total: 65 }, gpuOffload: 'auto' }).state, 'full');
  const unexpected = evaluateOffloadResult({ diagnostics: { offloaded: 30, total: 65 }, gpuOffload: 'auto' });
  assert.equal(unexpected.state, 'partial-unexpected');
  assert.equal(unexpected.warning.code, 'gpu-offload-partial');
  // Fewer than requested: a genuine resource limitation.
  const limited = evaluateOffloadResult({ diagnostics: { offloaded: 20, total: 65 }, gpuOffload: 30 });
  assert.equal(limited.state, 'partial-resource-limited');
  assert.equal(limited.warning.code, 'gpu-offload-resource-limited');
  // Explicitly requested partial offload achieved as asked: no warning.
  const requested = evaluateOffloadResult({ diagnostics: { offloaded: 30, total: 65 }, gpuOffload: 30 });
  assert.equal(requested.state, 'partial-requested');
  assert.equal(requested.warning, null);
  // CPU-only by request is not a warning.
  assert.equal(evaluateOffloadResult({ diagnostics: { offloaded: 0, total: 65 }, gpuOffload: 0 }).warning, null);
  // Missing or ambiguous diagnostics never report success or failure.
  assert.equal(evaluateOffloadResult({ diagnostics: null, gpuOffload: 'auto' }).state, 'unknown');
  assert.equal(evaluateOffloadResult({ diagnostics: { offloaded: 30, total: null }, gpuOffload: 'auto' }).state, 'unknown');
  assert.equal(evaluateOffloadResult({ diagnostics: { offloaded: 30, total: null }, gpuOffload: 'auto' }).warning, null);
});

test('a load that fits at preflight but under-offloads is still reported afterwards', () => {
  const estimate = estimateOffloadRequirements({ model: model(), config: config() });
  const preflight = assessGpuFit({ estimate, memory: { available: true, devices: [{ index: 0, name: 'GPU', totalMiB: 48000, freeMiB: 40000 }] } });
  assert.equal(preflight.status, 'sufficient');
  // Another process grabbed VRAM between the preflight reading and the load.
  const result = evaluateOffloadResult({ diagnostics: { offloaded: 24, total: 65 }, gpuOffload: 'auto' });
  assert.equal(result.state, 'partial-unexpected');
  assert.ok(result.warning.message.includes('24/65'), 'the warning reports the actual counts');
  assert.match(result.warning.message, /significantly reduce generation speed/);
});

test('engine environment raises log verbosity so offload diagnostics are emitted', () => {
  const env = buildLlamaServerEnv({ PATH: '/bin' });
  assert.equal(env.LLAMA_ARG_LOG_VERBOSITY, '4', 'trace level is required for the loader summary');
  assert.equal(buildLlamaServerEnv({ LLAMA_ARG_LOG_VERBOSITY: '5' }).LLAMA_ARG_LOG_VERBOSITY, '5', 'an explicitly higher level is preserved');
  assert.equal(buildLlamaServerEnv({ LLAMA_ARG_LOG_VERBOSITY: '2' }).LLAMA_ARG_LOG_VERBOSITY, '4', 'a lower level is raised');
  assert.equal(buildLlamaServerEnv({ LLAMA_ARG_LOG_VERBOSITY: 'nonsense' }).LLAMA_ARG_LOG_VERBOSITY, '4');
});

test('real fork trace output yields exact offload counts', () => {
  // Verbatim shape of the trace the fork prints for a partial offload.
  const trace = [
    '0.00.797.531 I load_tensors: loading model tensors, this can take a while... (load_mode = none)',
    '0.00.797.596 D load_tensors: layer   0 assigned to device CUDA0, is_swa = 0',
    '0.06.100.000 I load_tensors: offloading 59 repeating layers to GPU',
    '0.06.100.010 I load_tensors: offloaded 60/65 layers to GPU',
    '0.06.100.020 I load_tensors:        CUDA0 model buffer size = 10126.50 MiB',
    '0.06.100.030 I load_tensors:    CUDA_Host model buffer size =  1089.24 MiB',
  ].join('\n');
  const diagnostics = parseOffloadDiagnostics(trace);
  assert.deepEqual(diagnostics, { offloaded: 60, total: 65 });
  const result = evaluateOffloadResult({ diagnostics, gpuOffload: 'auto', layerCount: 64 });
  assert.equal(result.state, 'partial-unexpected');
  assert.match(result.warning.message, /60\/65/);
});

test('startup handler reports offload diagnostics once, even across split chunks', async () => {  const seen = [];
  const handler = createStartupHandler({
    onStatus: () => {},
    onDiagnostics: (diagnostics) => seen.push(diagnostics),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) }),
  });
  handler.onOutput('load_tensors: offlo', 'stdout');
  assert.deepEqual(seen, []);
  handler.onOutput('aded 30/65 layers to GPU\n', 'stdout');
  assert.deepEqual(seen, [{ offloaded: 30, total: 65 }]);
  handler.onOutput('load_tensors: offloaded 65/65 layers to GPU\n', 'stdout');
  assert.deepEqual(seen, [{ offloaded: 30, total: 65 }], 'only the first result is reported');
  handler.cancel();
});

test('launch args preserve the user K/V precision and offload settings verbatim', () => {
  const args = buildLlamaServerArgs(model(), config({ cacheTypeK: 'q8_0', cacheTypeV: 'q4_0', gpuOffload: 'auto' }), 8080);
  assert.equal(args[args.indexOf('--cache-type-k') + 1], 'q8_0');
  assert.equal(args[args.indexOf('--cache-type-v') + 1], 'q4_0');
  assert.equal(args[args.indexOf('-ngl') + 1], 'auto');
  // The preflight acknowledgement is a control option, not a server argument.
  const withAck = buildLlamaServerArgs(model(), normalizeLoadConfig({ ...config(), allowPartialOffload: true }), 8080);
  assert.equal(withAck.includes('--allow-partial-offload'), false);
  assert.equal(withAck[withAck.indexOf('-ngl') + 1], 'auto');
  assert.equal(withAck[withAck.indexOf('--cache-type-k') + 1], 'q8_0');
});
