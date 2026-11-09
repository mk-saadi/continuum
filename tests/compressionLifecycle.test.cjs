'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-migration-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager');
const service = require('../src/main/mainChatCompaction');
const builder = require('../src/main/promptBuilder');
const core = require('../src/main/conversationCompaction');
const { createChildContextAdapter } = require('../src/main/subagents/contextRecovery');
let serial = 0;
const engine = { provider: 'local', modelId: 'fixture', port: 9, contextLength: 8192 };
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
async function child() {
  const original = [{ role: 'system', content: 'Read-only instructions' }, { role: 'user', content: 'Original child objective' }, { role: 'assistant', content: 'Recent result' }];
  const messages = [original[0], { role: 'system', content: '[EARLIER CHILD CONTEXT]\nPrior discovery' },
    { role: 'system', content: '[CHILD CHECKPOINT]\nLegacy checkpoint details' }, ...original.slice(1)];
  const session = { id: `migrating-child-${++serial}`, context: messages, inputSummary: { task: original[1].content }, activity: [],
    rawContext: original.map((m, i) => ({ ...m, id: i + 1 })), compactionState: { version: 4, summary: 'Prior discovery', checkpoint: { objective: 'Legacy objective' }, events: [] } };
  const state = await require('../src/main/subagents/executionBudget').getExecutionBudget(session, { kind: 'investigation', engine });
  return { session, messages, state, options: { session, messages, state, engine,
    fetchImpl: async () => assert.fail('migration must not infer'), commit: () => { session.context = messages.slice(); } } };
}
test('short and disabled children migrate summary/checkpoint on restart without inference or budget resets', async () => {
  const f = await child(), raw = structuredClone(f.session.rawContext);
  const ledger = structuredClone(f.state.ledger);
  const profiles = require('../src/main/profileSettings'); profiles.saveProfileSettings('fixture', { compactionEnabled: false });
  try {
    const adapter = createChildContextAdapter(f.options);
    await adapter.prepare({ model: 'fixture', messages: f.messages, tools: [], max_tokens: 512 });
    assert.equal(f.messages.filter(m => m.content?.startsWith(core.MARKER)).length, 1);
    assert.ok(!f.messages.some(m => m.content?.startsWith('[CHILD CHECKPOINT]')));
    assert.match(f.session.compactionState.summary, /Prior discovery/); assert.match(f.session.compactionState.summary, /Legacy objective/);
    assert.equal(f.session.compactionState.checkpoint, null); assert.equal(f.session.compactionState.version, 4);
    assert.deepEqual(f.state.ledger, ledger); assert.deepEqual(f.session.rawContext, raw);
    const persisted = storage.db.prepare('SELECT compaction_json FROM subagent_runs WHERE child_session_id=?').get(f.session.id);
    assert.equal(JSON.parse(persisted.compaction_json).summary, f.session.compactionState.summary);
    const saved = JSON.stringify(f.session.compactionState);
    createChildContextAdapter(f.options); assert.equal(JSON.stringify(f.session.compactionState), saved);
  } finally { profiles.saveProfileSettings('fixture', null); }
});
test('child migration persistence failure restores the old projection and preserves raw records', async () => {
  const f = await child(), original = structuredClone(f.messages), raw = structuredClone(f.session.rawContext);
  storage.db.prepare(`CREATE TRIGGER reject_child_migration BEFORE INSERT ON subagent_runs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run();
  const error = console.error; console.error = () => {};
  try { assert.throws(() => createChildContextAdapter(f.options), e => e.code === 'persistence-failed'); }
  finally { console.error = error; storage.db.prepare('DROP TRIGGER reject_child_migration').run(); }
  assert.deepEqual(f.messages, original); assert.deepEqual(f.session.rawContext, raw); assert.equal(f.session.compactionState.version, 4);
});
test('old checkpoints from another branch never become current summary context', () => {
  const id = `migration-main-${++serial}`; sessions.getOrCreateSession(id, 'fixture');
  const first = sessions.saveMessage(id, 'user', 'Branch root');
  const other = sessions.saveMessage(id, 'assistant', 'Unrelated future reply');
  storage.db.prepare(`INSERT INTO workspace_checkpoints(session_id,checkpoint_json,active_leaf_id,archived_ids_json) VALUES (?,?,?,?)`)
    .run(id, '{"objective":"PRIVATE_FUTURE_CONTEXT"}', other.id, JSON.stringify([first.id, other.id]));
  sessions.editMessage(first.id, 'Corrected branch root');
  assert.equal(service.stateFor(id), null);
  assert.ok(!JSON.stringify(builder.rebuildChatMessages({sessionId:id, modelId:'fixture'})).includes('PRIVATE_FUTURE_CONTEXT'));
});
test('old archive flags neither hide originals nor cause writes when context is rebuilt', () => {
  const id = `migration-flags-${++serial}`; sessions.getOrCreateSession(id, 'fixture');
  for (let i = 0; i < 5; i++) sessions.saveMessage(id, i % 2 ? 'assistant' : 'user', `original ${i}`);
  storage.db.prepare('UPDATE messages SET archived=1,is_summarized=1 WHERE session_id=?').run(id);
  storage.db.prepare('INSERT INTO session_summaries(session_id,summary_text) VALUES (?,?)').run(id, 'Saved legacy context');
  const before = sessions.loadSession(id).messages;
  const a = builder.rebuildChatMessages({sessionId:id, modelId:'fixture'}), b = builder.rebuildChatMessages({sessionId:id,modelId:'fixture'});
  assert.deepEqual(a,b); assert.deepEqual(sessions.loadSession(id).messages,before); assert.equal(sessions.getActiveMessages(id).length,5);
  assert.equal(service.read(id).summary,'Saved legacy context');
});
test('new workspace messages and edits do not create historical brief lifecycle state', () => {
  const project = require('../src/main/projectManager').createProject({ name:'Migration continuity' });
  const id = `new-main-${++serial}`; sessions.getOrCreateSession(id,'fixture',project.id);
  const user = sessions.saveMessage(id,'user','Current objective'); sessions.editMessage(user.id,'New correction');
  assert.equal(storage.db.prepare('SELECT count(*) n FROM workspace_task_briefs WHERE session_id=?').get(id).n,0);
  assert.match(JSON.stringify(builder.rebuildChatMessages({sessionId:id,modelId:'fixture'})),/New correction/);
});
