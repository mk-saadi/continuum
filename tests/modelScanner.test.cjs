const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDirectoryForModels, parseModelMetadata } = require('../src/main/modelScanner');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-scanner-'));
(async () => {
try {
  const name = 'Qwen2.5-VL-26B-Instruct-Q4_K_M.gguf';
  fs.writeFileSync(path.join(root, name), 'model');
  fs.writeFileSync(path.join(root, 'vision-MMPROJ-f16.GGUF'), 'projector');
  let models = await scanDirectoryForModels(root);
  assert.equal(models.length, 1);
  assert.equal(models[0].hasVisionProjector, true);
  assert.equal(models[0].mmprojPath, path.join(root, 'vision-MMPROJ-f16.GGUF'));
  assert.equal(models[0].hasVision, true);
  assert.equal(models[0].hasTools, true);
  assert.equal(models[0].paramSize, '26B');
  assert.equal(models[0].quantization, 'Q4_K_M');
  const metadata = await parseModelMetadata(path.join(root, name), 'DeepSeek-R1_12B_IQ4_XS.gguf', {size: 7.04 * 1024 ** 3});
  assert.equal(metadata.sizeFormatted, '7.04 GB');
  assert.equal(metadata.paramSize, '12B');
  assert.equal(metadata.quantization, 'IQ4_XS');
  assert.equal(metadata.hasReasoning, true);
  fs.writeFileSync(path.join(root, 'other-mmproj.gguf'), 'projector');
  assert.equal((await scanDirectoryForModels(root))[0].mmprojPath, null);
  fs.writeFileSync(path.join(root, `mmproj-${name}`), 'projector');
  assert.equal((await scanDirectoryForModels(root))[0].mmprojPath, path.join(root, `mmproj-${name}`));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'plain-1.5B-BF16.gguf'), '');
  models = await scanDirectoryForModels(root);
  assert.equal(models.length, 2);
  const plain = models.find(model => model.name.startsWith('nested/'));
  assert.equal(plain.hasVision, false);
  assert.equal(plain.hasTools, false);
  assert.equal(plain.hasReasoning, false);
  assert.equal(plain.hasVisionProjector, false);
  assert.equal(plain.quantization, 'BF16');
  assert.equal(plain.paramSize, '1.5B');
  assert.equal(plain.sizeFormatted, '0.00 B');
  console.log('Model metadata, recursive scanning, projector filtering and association passed.');
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

})().catch(error => { console.error(error); process.exitCode = 1; });
