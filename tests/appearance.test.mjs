import test from 'node:test';
import assert from 'node:assert/strict';

// No DOM/framework needed: preference changes update the root without
// broadcasting state through the chat transcript's React context.
test('appearance persists, restores, syncs windows, and survives unavailable storage', async () => {
  const original = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const saved = new Map();
  const root = { dataset: {} };
  globalThis.window = new EventTarget();
  globalThis.document = { documentElement: root };
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  try {
    const store = await import('../src/lib/appearance.mjs?initial');
    store.initializeAppearance();
    assert.equal(root.dataset.appearance, 'neumorphism');
    let notifications = 0;
    const stop = store.subscribeAppearance(() => notifications++);
    store.setAppearance('flat');
    assert.equal(root.dataset.appearance, 'flat');
    assert.equal(saved.get('appearance'), 'flat');
    assert.equal(store.getAppearance(), 'flat');
    assert.equal(notifications, 1);
    const restarted = await import('../src/lib/appearance.mjs?restart');
    restarted.initializeAppearance();
    assert.equal(root.dataset.appearance, 'flat');
    saved.set('appearance', 'material');
    const storage = new Event('storage');
    Object.defineProperty(storage, 'key', { value: 'appearance' });
    window.dispatchEvent(storage);
    assert.equal(store.getAppearance(), 'neumorphism');
    assert.equal(root.dataset.appearance, 'neumorphism');
    assert.equal(saved.get('appearance'), 'neumorphism', 'legacy preference is rewritten');
    assert.equal(root.dataset.style, 'neumorphism');
    stop();
    store.setAppearance('flat');
    assert.equal(notifications, 2, 'unsubscribed listener stays detached');
    globalThis.localStorage = { getItem() { throw Error('unavailable'); }, setItem() { throw Error('unavailable'); } };
    const unavailable = await import('../src/lib/appearance.mjs?unavailable');
    assert.equal(unavailable.getAppearance(), 'neumorphism');
    unavailable.setAppearance('flat');
    assert.equal(root.dataset.appearance, 'flat');
    assert.equal(unavailable.getAppearance(), 'flat');
    unavailable.setAppearance('invalid');
    assert.equal(root.dataset.appearance, 'neumorphism');
    globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
    store.setAppearance('skeu');
    assert.equal(root.dataset.style, 'skeu', 'Skeu scope includes body portals');
    assert.equal(saved.get('appearance'), 'skeu');
    const skeuRestart = await import('../src/lib/appearance.mjs?skeu-restart');
    assert.equal(skeuRestart.getAppearance(), 'skeu', 'Skeu survives restart');
    let synced = 0;
    const stopSkeu = skeuRestart.subscribeAppearance(() => synced++);
    saved.set('appearance', 'flat');
    const sync = new Event('storage');
    Object.defineProperty(sync, 'key', { value: 'appearance' });
    window.dispatchEvent(sync);
    assert.equal(root.dataset.style, 'flat', 'cross-window changes remove the Skeu scope');
    assert.equal(synced, 1);
    stopSkeu();
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('boot script migrates legacy values before paint and preserves other styles', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [saved, expected] of [['material', 'neumorphism'], ['neumorphism', 'neumorphism'], ['flat', 'flat'], ['skeu', 'skeu'], [null, 'neumorphism']]) {
    const root = { dataset: {} };
    let persisted = saved;
    runInNewContext(script, { URLSearchParams, location: { search: '' }, document: { documentElement: root }, localStorage: { getItem: () => saved, setItem: (_, value) => { persisted = value; } } });
    assert.equal(root.dataset.appearance, expected);
    assert.equal(root.dataset.style, expected);
    if (saved === 'material') assert.equal(persisted, expected);
  }
});
