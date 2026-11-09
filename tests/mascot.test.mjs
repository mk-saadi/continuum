import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../src/lib/mascotSettings.cjs';
import { point, normalized, facing, mayMirror } from '../src/lib/mascotGeometry.mjs';
import { chooseActivity, mascotEvent, selectMascotSession, getMascotActivity, mascotAttention, shouldSleep } from '../src/lib/mascotActivity.mjs';
import { createPlayback } from '../src/lib/mascotPlayback.mjs';
import catalog from '../src/lib/mascotCatalog.json' with { type: 'json' };
const flush = () => new Promise(r => setImmediate(r));
test('defaults and invalid persisted values are normalized', () => {
    const s = settings.normalizeMascotSettings({ size: 999, hue: -10, enabled: 'yes', position: { x: -1, y: Infinity }, sleep: 3, animation: 'invalid' });
    assert.equal(s.size, 240);
    assert.equal(s.hue, 0);
    assert.equal(s.enabled, true);
    assert.equal(s.sleep, 5);
    assert.deepEqual(s.position, { x: 0, y: .78 });
    assert.equal(s.animation, 'system');
    assert.deepEqual(settings.normalizeMascotSettings(JSON.parse(JSON.stringify(settings.DEFAULT_MASCOT_SETTINGS))), settings.DEFAULT_MASCOT_SETTINGS);
});
test('clamping survives resize and size changes; facing dead zone and text exceptions', () => {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 400, height: 350 }, { width: 90, height: 90 }])
        for (const size of [80, 128, 240]) {
            const p = point(normalized({ x: 9999, y: -9999 }, viewport, size), viewport, size);
            assert.ok(p.x >= 0 && p.x <= viewport.width);
            assert.ok(p.y >= 0 && p.y <= viewport.height);
        }
    assert.equal(facing(490, 1000, 'left'), 'left');
    assert.equal(facing(490, 1000, 'right'), 'right');
    assert.equal(facing(100, 1000), 'right');
    assert.equal(mayMirror('terminal'), false);
    assert.equal(mayMirror('error-nan'), false);
    assert.equal(mayMirror('happy'), true);
});
test('priority, request identity, foreground conversation and cancellation', () => {
    selectMascotSession('a');
    mascotEvent('a', 'r1', { type: 'begin' });
    mascotEvent('b', 'r2', { type: 'begin' });
    mascotEvent('b', 'r2', { type: 'end', outcome: 'completed' });
    assert.equal(getMascotActivity().state, 'thinking');
    mascotEvent('a', 'r1', { type: 'tool', id: 1, toolName: 'execute_command', status: 'running' });
    assert.equal(getMascotActivity().state, 'terminal');
    mascotAttention('a', true);
    assert.equal(getMascotActivity().state, 'confused');
    mascotAttention('a', false);
    mascotEvent('a', 'old', { type: 'end', outcome: 'interrupted' });
    assert.equal(getMascotActivity().state, 'terminal');
    mascotEvent('a', 'r1', { type: 'end', outcome: 'cancelled' });
    assert.equal(getMascotActivity().state, 'idle');
    mascotEvent('a', 'r3', { type: 'begin' });
    mascotEvent('a', 'r3', { type: 'tool', id: 2, toolName: 'x', status: 'error' });
    assert.equal(getMascotActivity().state, 'error-nan');
    mascotEvent('a', 'r3', { type: 'text' });
    assert.equal(getMascotActivity().state, 'working');
    mascotEvent('a', 'r3', { type: 'end', outcome: 'completed' });
    assert.equal(getMascotActivity().state, 'happy');
    assert.equal(chooseActivity({ active: true, tools: new Map([[1, { toolName: 'spawn_sub_agent', status: 'running' }]]) }).state, 'analytical');
});
function harness() {
    let now = 0, serial = 0;
    const tasks = new Map(), shown = [];
    const c = createPlayback({ catalog: (s, p) => { const r = catalog.find(r => r.state === s && r.part === p); return r && { ...r }; }, prepare: async (clip) => ({ clip }), display: (ready, clip) => shown.push([clip.state, clip.part]), schedule: (fn, delay) => { const id = ++serial; tasks.set(id, { fn, at: now + delay }); return id; }, cancel: id => tasks.delete(id) });
    return { c, shown, tasks, async tick(ms) { now += ms; for (const [id, t] of [...tasks])
            if (t.at <= now) {
                tasks.delete(id);
                t.fn();
            } await flush(); } };
}
test('manifest reaction timing, hold, completion return and deduplication', async () => { const h = harness(); h.c.set('happy', '1'); await flush(); assert.deepEqual(h.shown.at(-1), ['happy', 'success-reaction']); await h.tick(4999); assert.equal(h.shown.length, 1); h.c.set('happy', '1'); assert.equal(h.tasks.size, 1); await h.tick(1); assert.deepEqual(h.shown.at(-1), ['happy', 'hold']); await h.tick(3000); assert.deepEqual(h.shown.at(-1), ['idle', 'main']); });
test('reaction and terminal entry/exit interruption cancel stale callbacks', async () => { const h = harness(); h.c.set('confused', '1'); await flush(); h.c.set('terminal', '2'); await flush(); assert.deepEqual(h.shown.at(-1), ['terminal', 'entry']); await h.tick(333); assert.deepEqual(h.shown.at(-1), ['terminal', 'main']); h.c.set('idle', '2'); await flush(); assert.deepEqual(h.shown.at(-1), ['terminal', 'exit']); h.c.set('working', '3'); await flush(); await h.tick(10000); assert.deepEqual(h.shown.at(-1), ['working', 'main']); h.c.stop(); assert.equal(h.tasks.size, 0); });
test('obsolete decode cannot display and timing starts after display', async () => { let resolve, displayed = 0, timers = 0; const c = createPlayback({ catalog: (s, p) => p === 'main' || s === 'happy' ? ({ state: s, part: p, duration: 5 }) : undefined, prepare: clip => clip.state === 'happy' ? new Promise(r => resolve = r) : Promise.resolve({}), display: () => displayed++, schedule: () => { timers++; return 1; }, cancel: () => { } }); c.set('happy', '1'); assert.equal(timers, 0); c.set('working', '2'); await flush(); resolve({}); await flush(); assert.equal(displayed, 1); assert.equal(timers, 0); });
test('inactivity sleep only when idle; wake and pending attention block sleep', () => { assert.equal(shouldSleep({ busy: false, state: 'idle' }, 300000, 5), true); for (const state of ['confused', 'terminal', 'thinking', 'error-xx'])
    assert.equal(shouldSleep({ busy: true, state }, 999999, 1), false); assert.equal(shouldSleep({ busy: false, state: 'idle' }, 1, 5), false); assert.equal(shouldSleep({ busy: false, state: 'idle' }, 999999, 0), false); });
test('catalog picks latest terminal and includes static fallbacks for every clip', () => { assert.ok(catalog.filter(r => r.state === 'terminal').every(r => r.version === 22)); assert.ok(catalog.every(r => r.static.endsWith('.png'))); for (const r of catalog.filter(r => r.part === 'entry' || r.part === 'exit'))
    assert.equal(r.duration, 333); });
test('settings store serializes patches and exposes save failures without losing saved values', async () => {
    const { initializeMascotSettings, updateMascotSettings, getMascotSettings } = await import('../src/lib/mascotStore.mjs');
    let saved = { mascot: settings.DEFAULT_MASCOT_SETTINGS }, fail = false;
    globalThis.window = { api: { getAppSettings: async () => saved, saveAppSettings: async (patch) => { if (fail)
                throw Error('Disk unavailable'); saved = { ...saved, ...patch }; } } };
    await initializeMascotSettings();
    await Promise.all([updateMascotSettings({ size: 180 }), updateMascotSettings({ hue: 45 })]);
    assert.equal(saved.mascot.size, 180);
    assert.equal(saved.mascot.hue, 45);
    fail = true;
    await updateMascotSettings({ size: 200 });
    assert.equal(getMascotSettings().settings.size, 180);
    assert.equal(getMascotSettings().error, 'Disk unavailable');
    delete globalThis.window;
});

test('browser ESM and main-process CommonJS settings entry points stay aligned', async () => {
    const browser = await import('../src/lib/mascotSettings.mjs');
    assert.deepEqual(browser.DEFAULT_MASCOT_SETTINGS, settings.DEFAULT_MASCOT_SETTINGS);
    for (const input of [undefined, null, {}, [], {size:240,hue:180,enabled:false},
        {size:NaN,hue:Infinity,position:{x:-1,y:2},animation:'invalid',sleep:3},
        {automaticFacing:false,facing:'right',animation:'reduced',sleep:0,locked:true}]) {
        assert.deepEqual(browser.normalizeMascotSettings(input), settings.normalizeMascotSettings(input));
    }
});
