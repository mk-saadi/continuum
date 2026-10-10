// Focused coverage for the single composited UI-layer opacity: clamping,
// image-on-<html> + opacity-on-<body> separation, 100% cleanup behavior,
// and clean restoration without leftovers.
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  return import('../src/utils/uiLayerOpacity.mjs');
}

function makeStyle() {
  const props = {};
  return {
    getPropertyValue: (name) => props[name] || '',
    setProperty: (name, value) => {
      props[name] = String(value);
    },
    removeProperty: (name) => {
      delete props[name];
    },
    _props: props,
  };
}

function makeDocument() {
  return { documentElement: { style: makeStyle() }, body: { style: makeStyle() } };
}

test('opacity clamping keeps stored semantics (opacity, not transparency)', async () => {
  const mod = await loadModule();
  assert.equal(mod.clampUiOpacity(90), 90);
  assert.equal(mod.clampUiOpacity(100), 100);
  assert.equal(mod.clampUiOpacity(10), 40);
  assert.equal(mod.clampUiOpacity(400), 100);
  assert.equal(mod.uiOpacityFactor(90), 0.9);
});

test('image goes on <html>, opacity on <body>; 100% removes the group', async () => {
  const mod = await loadModule();
  const doc = makeDocument();
  assert.equal(mod.applyUiLayer(doc, { imageUrl: 'media:///bg.png', opacity: 90 }), true);
  assert.match(doc.documentElement.style.getPropertyValue("background-image"), /media:\/\/\/bg\.png/);
  assert.equal(doc.documentElement.style.getPropertyValue("background-size"), "cover");
  assert.equal(doc.documentElement.style.getPropertyValue("--bg-ui-opacity"), "0.9");
  assert.equal(doc.body.style.getPropertyValue("opacity"), "0.9");
  // 100% keeps the image but avoids a needless compositing group.
  mod.applyUiLayer(doc, { imageUrl: "media:///bg.png", opacity: 100 });
  assert.match(doc.documentElement.style.getPropertyValue("background-image"), /media:/);
  assert.equal(doc.documentElement.style.getPropertyValue("--bg-ui-opacity"), "1");
  assert.equal(doc.body.style.getPropertyValue("opacity"), "");
});

test('missing image clears everything; restore leaves no leftovers', async () => {
  const mod = await loadModule();
  const doc = makeDocument();
  mod.applyUiLayer(doc, { imageUrl: 'media:///bg.png', opacity: 60 });
  assert.equal(mod.applyUiLayer(doc, { imageUrl: '', opacity: 60 }), false);
  const read = mod.readUiLayer(doc);
  assert.equal(read.imageUrl, '');
  assert.equal(read.opacity, '');
  assert.deepEqual(doc.documentElement.style._props, {});
  assert.deepEqual(doc.body.style._props, {});
  // Toggling repeatedly never accumulates state.
  for (let i = 0; i < 3; i += 1) {
    mod.applyUiLayer(doc, { imageUrl: 'media:///bg.png', opacity: 60 });
    mod.clearUiLayer(doc);
  }
  assert.deepEqual(doc.documentElement.style._props, {});
  assert.deepEqual(doc.body.style._props, {});
});

test('partial documents fail safe', async () => {
  const mod = await loadModule();
  assert.equal(mod.applyUiLayer(null, { imageUrl: 'media:///bg.png', opacity: 90 }), false);
  assert.equal(mod.applyUiLayer({}, { imageUrl: 'media:///bg.png', opacity: 90 }), false);
  mod.clearUiLayer(null);
  mod.clearUiLayer({});
});
