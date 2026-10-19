const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseModelMetadata, scanDirectoryForModels } = require('../src/main/modelScanner');

// Minimal GGUF v3 metadata with no tensor records or weights.
function gguf(metadata) {
  const string = value => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  };
  const header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(BigInt(Object.keys(metadata).length), 16);
  return Buffer.concat([header, ...Object.entries(metadata).flatMap(([key, value]) => {
    const type = Buffer.alloc(4);
    type.writeUInt32LE(typeof value === 'number' ? 4 : typeof value === 'boolean' ? 7 : 8);
    const data = typeof value === 'number' ? Buffer.alloc(4) : typeof value === 'boolean' ? Buffer.from([Number(value)]) : string(value);
    if (typeof value === 'number') data.writeUInt32LE(value);
    return [string(key), type, data];
  })]);
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-metadata-'));
  const file = path.join(root, 'neutral-12B-Q4_K_M.gguf');
  const parse = () => parseModelMetadata(file, path.basename(file), fs.statSync(file));
  try {
    fs.writeFileSync(file, gguf({
      'general.architecture': 'qwen2vl',
      'general.name': 'Example model',
      'tokenizer.chat_template': `<tools>{{ tools }}</tools><think>{% if reasoning_effort == 'low' %}{% elif reasoning_effort == "medium" %}{% elif reasoning_effort=='high' %}{% elif reasoning_effort == 'low' %}`,
    }));
    let result = await parse();
    assert.equal(result.hasVision, true);
    assert.equal(result.hasTools, true);
    assert.equal(result.hasReasoning, true);
    assert.equal(result.reasoningFormat, 'deepseek');
    assert.deepEqual(result.reasoningEfforts, ['low', 'medium', 'high']);
    // Effort is template-reported. A numeric budget needs end tags the
    // installed runtime can enforce, so this template does not advertise one.
    assert.equal(result.supportsReasoningEffort, true);
    assert.equal(result.supportsReasoningBudget, false);
    assert.equal(result.supportsDisableReasoning, true);
    assert.equal(result.generalName, 'Example model');
    fs.writeFileSync(file, gguf({'general.architecture': 'llama', 'tokenizer.chat_template': '{{ messages }}'}));
    result = await parse();
    assert.equal(result.hasVision, false);
    assert.equal(result.hasTools, false);
    assert.equal(result.hasReasoning, false);
    assert.equal(result.reasoningFormat, 'auto');
    assert.deepEqual(result.reasoningEfforts, []);
    assert.equal(result.supportsReasoningEffort, false);
    assert.equal(result.supportsReasoningBudget, false);
    assert.equal(result.supportsDisableReasoning, false);
    fs.writeFileSync(file, gguf({'general.architecture': 'deepseek2', 'tokenizer.chat_template.tool_use': 'tool_calls'}));
    assert.equal((await parse()).hasReasoning, true);
    assert.equal((await parse()).hasTools, true);
    // Sparse weights keep the fixture small on disk while exercising the read cap.
    fs.truncateSync(file, 20 * 1024 * 1024);
    const read = fs.readSync;
    const close = fs.closeSync;
    let bytes = 0;
    let closed = 0;
    try {
      fs.readSync = (...args) => { const count = read(...args); bytes += count; return count; };
      fs.closeSync = (...args) => { closed++; return close(...args); };
      result = await parse();
    } finally { fs.readSync = read; fs.closeSync = close; }
    assert.equal(bytes, 1024 * 1024);
    assert.equal(closed, 1);
    assert.equal(result.hasTools, true);
    const scanned = await scanDirectoryForModels(root);
    assert.equal(scanned[0].hasReasoning, true);
    fs.writeFileSync(file, gguf({
      'general.architecture': 'qwen2moe', 'qwen2moe.context_length': 32768,
      'qwen2moe.block_count': 32, 'qwen2moe.expert_count': 64, 'qwen2moe.expert_used_count': 8,
      'qwen2moe.embedding_length': 2048, 'qwen2moe.attention.head_count': 16,
      'qwen2moe.attention.head_count_kv': 4, 'test.large': 'x'.repeat(6 * 1024 * 1024),
    }));
    result = await parse();
    assert.equal(result.metadataStatus, 'parsed');
    assert.equal(result.contextLength, 32768);
    assert.equal(result.layerCount, 32);
    assert.equal(result.expertCount, 64);
    assert.equal(result.activeExpertCount, 8);
    assert.equal(result.embeddingLength, 2048);
    assert.equal(result.attentionHeads, 16);
    assert.equal(result.kvHeads, 4);
    assert.equal(result.expertLayers, null);
    assert.equal(result.declaredCapabilities.video, null);
    fs.writeFileSync(file, gguf({ 'general.architecture': 'llama' }));
    result = await parse();
    assert.equal(result.contextLength, null);
    assert.equal(result.layerCount, null);
    fs.writeFileSync(file, 'GGUF');
    const warn = console.warn;
    const warnings = [];
    try {
      console.warn = (...args) => warnings.push(args);
      result = await parseModelMetadata(file, 'Qwen2.5-VL-Instruct-Think.gguf', fs.statSync(file));
    } finally { console.warn = warn; }
    assert.equal(warnings.length, 1);
    assert.equal(result.hasVision, true);
    assert.equal(result.hasTools, true);
    assert.equal(result.hasReasoning, true);
    console.log('Real GGUF metadata, named templates, bounded reads, descriptor cleanup, and fallback passed.');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
