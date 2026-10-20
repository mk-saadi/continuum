// Focused coverage for the shared VRAM/system-RAM estimator that feeds the
// model load modal readout and the main-process GPU preflight.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { estimateMemoryUsage, kvElementBytes } = require('../src/lib/memoryEstimate.mjs');
const { estimateOffloadRequirements } = require('../src/main/gpuMemory');

const GIB = 1024 * 1024 * 1024;
const model = (overrides = {}) => ({
  modelPath: '/models/qwen.gguf',
  fileIdentity: { size: 10 * GIB },
  layerCount: 64,
  attentionHeads: 32,
  kvHeads: 8,
  embeddingLength: 4096,
  architecture: 'qwen3',
  ...overrides,
});
const config = (overrides = {}) => ({
  contextLength: 32768,
  gpuOffload: 'auto',
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
  kvCacheOffload: 'gpu',
  mmprojOffload: true,
  ...overrides,
});

test('KV element sizes match the shared table', () => {
  assert.equal(kvElementBytes('f16'), 2);
  assert.equal(kvElementBytes('q8_0'), 34 / 32);
  assert.equal(kvElementBytes('q4_0'), 18 / 32);
  assert.equal(kvElementBytes('nonsense'), 2);
});

test('full GPU offload keeps weights out of system RAM', () => {
  const estimate = estimateMemoryUsage({ model: model(), config: config() });
  assert.equal(estimate.ramMiB, 0);
  assert.ok(estimate.vramMiB > 10000, `expected weights on the GPU, got ${estimate.vramMiB}`);
  assert.equal(estimate.confidence, 'high');
});

test('a manual layer count splits the weights across VRAM and RAM', () => {
  const estimate = estimateMemoryUsage({ model: model(), config: config({ gpuOffload: 32 }) });
  assert.ok(estimate.components.weightsVramMiB > 0);
  assert.ok(estimate.components.weightsRamMiB > 0);
  // 10 GiB total, split by 32 of (64 + 1) layers; the two halves must sum back.
  const total = estimate.components.weightsVramMiB + estimate.components.weightsRamMiB;
  assert.ok(Math.abs(total - 10240) < 1, `weights split should sum to the file size, got ${total}`);
  assert.equal(estimate.expectedFullOffload, false);
});

test('moving the KV cache to CPU swaps it from VRAM to RAM', () => {
  const gpu = estimateMemoryUsage({ model: model(), config: config() });
  const cpu = estimateMemoryUsage({ model: model(), config: config({ kvCacheOffload: 'cpu' }) });
  assert.equal(gpu.components.kvRamMiB, 0);
  assert.ok(gpu.components.kvVramMiB > 1000);
  assert.equal(cpu.components.kvVramMiB, 0);
  assert.equal(cpu.components.kvRamMiB, gpu.components.kvVramMiB);
  assert.ok(cpu.vramMiB < gpu.vramMiB, 'VRAM should drop when the KV cache leaves the GPU');
  assert.ok(cpu.ramMiB > gpu.ramMiB, 'RAM should rise when the KV cache moves to the CPU');
});

test('the projector follows its offload choice', () => {
  const bytes = 900 * 1024 * 1024;
  const onGpu = estimateMemoryUsage({ model: model({ mmprojPath: '/m/mmproj.gguf' }), config: config(), projectorBytes: bytes });
  assert.ok(Math.abs(onGpu.components.projectorVramMiB - 900) < 1);
  assert.equal(onGpu.components.projectorRamMiB, 0);

  const onCpu = estimateMemoryUsage({ model: model({ mmprojPath: '/m/mmproj.gguf' }), config: config({ mmprojOffload: false }), projectorBytes: bytes });
  assert.equal(onCpu.components.projectorVramMiB, 0);
  assert.ok(Math.abs(onCpu.components.projectorRamMiB - 900) < 1);
  assert.ok(onCpu.vramMiB < onGpu.vramMiB);
  assert.ok(onCpu.ramMiB > onGpu.ramMiB);
});

test('an unknown CPU projector size makes the RAM total unknown', () => {
  const estimate = estimateMemoryUsage({ model: model({ mmprojPath: '/m/mmproj.gguf' }), config: config({ mmprojOffload: false }) });
  assert.equal(estimate.ramMiB, null);
  assert.equal(estimate.ramIncomplete, true);
});

test('unknown weights leave both totals unknown at low confidence', () => {
  const estimate = estimateMemoryUsage({ model: model({ fileIdentity: null }), config: config() });
  assert.equal(estimate.vramMiB, null);
  assert.equal(estimate.ramMiB, null);
  assert.equal(estimate.confidence, 'low');
  assert.ok(estimate.notes.includes('model-size-unknown'));
});

test('a larger context or lower KV precision changes the VRAM total', () => {
  const small = estimateMemoryUsage({ model: model(), config: config({ contextLength: 8192 }) });
  const large = estimateMemoryUsage({ model: model(), config: config({ contextLength: 131072 }) });
  assert.ok(large.vramMiB > small.vramMiB);
  const quantized = estimateMemoryUsage({ model: model(), config: config({ contextLength: 8192, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' }) });
  assert.ok(quantized.components.kvVramMiB < small.components.kvVramMiB);
});

test('the preflight GPU view matches the shared VRAM total', () => {
  const cases = [
    config(),
    config({ gpuOffload: 32 }),
    config({ gpuOffload: 0 }),
    config({ kvCacheOffload: 'cpu' }),
    config({ cacheTypeK: 'q8_0', cacheTypeV: 'q4_0' }),
  ];
  for (const current of cases) {
    const split = estimateMemoryUsage({ model: model(), config: current });
    const preflight = estimateOffloadRequirements({ model: model(), config: current });
    assert.equal(split.vramMiB, preflight.totalMiB);
    assert.equal(split.components.weightsVramMiB, preflight.components.weightsMiB);
    assert.equal(split.components.kvVramMiB, preflight.components.kvMiB);
    assert.equal(split.components.computeMiB, preflight.components.computeMiB);
  }
});

test('a CPU-placed projector matches the preflight GPU view', () => {
  const bytes = 900 * 1024 * 1024;
  const vision = model({ mmprojPath: '/m/mmproj.gguf' });
  const current = config({ mmprojOffload: false });
  const split = estimateMemoryUsage({ model: vision, config: current, projectorBytes: bytes });
  const preflight = estimateOffloadRequirements({ model: vision, config: current, projectorBytes: bytes });
  assert.equal(split.vramMiB, preflight.totalMiB);
  assert.equal(preflight.components.projectorMiB, 0);
});
