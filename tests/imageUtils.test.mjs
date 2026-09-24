import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeImage } from '../src/utils/imageUtils.mjs';

for (const [width, height, expected] of [[4096, 2048, [1024, 512]], [2048, 4096, [512, 1024]], [320, 240, [320, 240]]]) {
  test(`resizes ${width}x${height} while preserving aspect ratio`, async t => {
    let revoked, drawn, exported;
    t.mock.method(URL, 'createObjectURL', () => 'blob:test');
    t.mock.method(URL, 'revokeObjectURL', url => { revoked = url; });
    const oldImage = globalThis.Image, oldDocument = globalThis.document;
    t.after(() => { globalThis.Image = oldImage; globalThis.document = oldDocument; });
    globalThis.Image = class {
      naturalWidth = width; naturalHeight = height;
      set src(value) { queueMicrotask(() => this.onload()); }
    };
    const canvas = {
      getContext: () => ({ fillRect() {}, drawImage(...args) { drawn = args.slice(1); } }),
      toDataURL(...args) { exported = args; return 'data:image/jpeg;base64,/9j/'; },
    };
    globalThis.document = { createElement: () => canvas };
    assert.equal(await optimizeImage({ name: 'photo.png' }), 'data:image/jpeg;base64,/9j/');
    assert.deepEqual([canvas.width, canvas.height], expected);
    assert.deepEqual(drawn, [0, 0, ...expected]);
    assert.deepEqual(exported, ['image/jpeg', 0.8]);
    assert.equal(revoked, 'blob:test');
  });
}

test('decode errors reject and release the object URL', async t => {
  let revoked = false;
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', () => { revoked = true; });
  const original = globalThis.Image;
  t.after(() => { globalThis.Image = original; });
  globalThis.Image = class { set src(value) { queueMicrotask(() => this.onerror()); } };
  await assert.rejects(optimizeImage({ name: 'broken.png' }), /Could not decode/);
  assert.equal(revoked, true);
});
