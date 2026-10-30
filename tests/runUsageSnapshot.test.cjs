'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { runUsageSnapshot } = require('../src/main/runUsageSnapshot');
const snapshot = previous => runUsageSnapshot({ phases: [{ promptTokens: 100, completionTokens: 10, startTime: 1000 }],
    current: { promptTokens: 200, completionTokens: 20 },
    estimates: [{ totalCost: 0.01 }, { totalCost: 0.02 }], previous, now: 3000 });

test('live usage replaces snapshots without double counting, retaining known cost on missing pricing', () => {
    const first = snapshot();
    assert.equal(first.cost.total, 0.03);
    assert.equal(first.totalTokens, 330);
    assert.equal(first.time, 2);
    assert.deepEqual(snapshot(first), first);
    const missing = runUsageSnapshot({ current: {}, estimates: [{}], previous: first, now: 4000 });
    assert.deepEqual(missing.cost, first.cost);
});

test('live run metadata and active variant survive interruption, late null stats, and restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-run-cost-'));
    const original = Module._load;
    Module._load = function(name, ...args) {
        if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
        return original.call(this, name, ...args);
    };
    const storage = require('../src/main/db');
    try {
        storage.initDatabase(directory);
        const sessions = require('../src/main/sessionManager');
        sessions.getOrCreateSession('live-cost', 'cloud-model');
        const persistence = require('../src/main/engineManager').createMessagePersistence({ sessionId: 'live-cost', modelId: 'cloud-model', runId: 'run-cost' });
        persistence.update({ content: 'Partial reply', executionSteps: [], stats: snapshot() });
        // Simulate a crash: no terminal update or final onStats callback.
        storage.closeDatabase();
        storage.initDatabase(directory);
        let row = storage.db.prepare('SELECT * FROM messages WHERE id = ?').get(persistence.messageId);
        assert.equal(row.status, 'interrupted');
        assert.equal(JSON.parse(row.stats).cost.total, 0.03);
        assert.equal(JSON.parse(row.variants)[0].stats.cost.total, 0.03);
        const saved = sessions.saveMessage('live-cost', 'assistant', row.content, [], null, null, null, row.id);
        row = storage.db.prepare('SELECT * FROM messages WHERE id = ?').get(saved.id);
        assert.equal(JSON.parse(row.stats).cost.estimated, true);
        assert.equal(JSON.parse(row.stats).totalTokens, 330);
    } finally {
        storage.closeDatabase(); Module._load = original;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
