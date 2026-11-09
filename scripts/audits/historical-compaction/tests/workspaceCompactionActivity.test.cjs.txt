'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-w5-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const { db } = storage;
const sessions = require('../src/main/sessionManager');
const activity = require('../src/main/workspaceCompactionActivity');
const { compact } = require('./fixtures/w3Compaction.cjs');
const project = require('../src/main/projectManager').createProject({ name: 'W5 disposable' });
let serial = 0;
function fixture(workspace = true) {
  const id = `w5-${++serial}`;
  sessions.getOrCreateSession(id, 'model', workspace ? project.id : null);
  sessions.saveMessage(id, 'user', 'Preserve task');
  sessions.saveMessage(id, 'assistant', 'Completed inspection. '.repeat(5000));
  sessions.saveMessage(id, 'user', 'Continue');
  return id;
}
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
test('W5 real W3 producer persists verified full-request counts and distinct attempts', async () => {
  const id = fixture();
  const result = await compact({ sessionId: id });
  const [event] = activity.list(id);
  assert.equal(event.status, 'completed');
  assert.equal(event.run_id, `fixture-${id}`);
  assert.equal(event.metadata.beforeTokens, result.diagnostics.beforeTokens);
  assert.equal(event.metadata.afterTokens, result.diagnostics.actualTokens);
  assert.equal(event.metadata.afterMeasurementMethod, result.diagnostics.actualMeasurementMethod);
  assert.equal(event.metadata.checkpointId, result.checkpointId);
  assert.ok(event.metadata.beforeTokens > event.metadata.afterTokens);
  assert.equal(event.metadata.continued, undefined);
  result.markContinued(); result.markContinued();
  assert.equal(activity.list(id)[0].metadata.continued, true);
  if (process.env.W5_METRICS) fs.writeFileSync(process.env.W5_METRICS, JSON.stringify(activity.list(id)));
});
for (const stage of ['generation-start', 'prospective-build', 'transaction-start', 'candidate-promotion', 'message-archival', 'transaction-commit', 'post-commit-build']) {
  test(`W5 real producer failure at ${stage} never reports success`, async () => {
    const id = fixture();
    await assert.rejects(compact({ sessionId: id, inject: at => { if (at === stage) throw Object.assign(new Error('private tool content'), { code: 'provider-error' }); } }));
    const [event] = activity.list(id);
    assert.equal(event.status, 'failed'); assert.equal(event.code, 'provider-error');
    assert.equal(event.metadata.afterTokens, undefined);
    assert.ok(!JSON.stringify(event).includes('private tool content'));
  });
}
test('W5 persistence failure does not roll back actual safe compaction', async () => {
  const id = fixture();
  storage.initDatabase(directory).exec("CREATE TRIGGER w5_fail_insert BEFORE INSERT ON workspace_compaction_activity BEGIN SELECT RAISE(ABORT,'injected'); END;");
  try { assert.equal((await compact({ sessionId: id })).compressed, true); assert.equal(activity.list(id).length, 0); }
  finally { storage.initDatabase(directory).exec('DROP TRIGGER w5_fail_insert'); }
});
test('W5 ordered revisions coalesce duplicates and ignore duplicate terminal updates', () => {
  const id = fixture(), seen = [];
  const event = activity.create({ sessionId: id, runId: 'r', broadcast: value => seen.push(value) });
  for (const status of ['generating', 'generating', 'validating', 'checking-fit', 'committing', 'completed', 'failed']) event.update(status);
  assert.deepEqual(seen.map(e => e.status), ['started','generating','validating','checking-fit','committing','completed']);
  assert.deepEqual(seen.map(e => e.revision), [1,2,3,4,5,6]);
});
test('W5 missed or throwing broadcasts recover through durable list and database reopen', () => {
  const id = fixture();
  const event = activity.create({ sessionId: id, broadcast: () => { throw Error('IPC unavailable'); } });
  event.update('completed', { beforeTokens: 100, afterTokens: 60 });
  const original = activity.list(id); storage.closeDatabase(); storage.initDatabase(directory);
  assert.deepEqual(activity.list(id), original);
});
test('W5 interrupted attempts inspect checkpoint evidence without claiming success', async () => {
  const id = fixture(); const result = await compact({ sessionId: id });
  const event = activity.create({ sessionId: id, runId: `fixture-${id}` }); event.update('committing', { checkpointId: result.checkpointId });
  const other = fixture(); activity.create({ sessionId: other });
  storage.closeDatabase(); storage.initDatabase(directory);
  assert.equal(activity.list(id).at(-1).code, 'interrupted-commit-unverified');
  assert.equal(activity.list(other)[0].code, 'interrupted-before-verified-commit');
  assert.equal(activity.list(id).at(-1).status, 'cancelled');
});
test('W5 H1 conversation deletion cascades and rejects late writes after reopen', () => {
  const id = fixture(), event = activity.create({ sessionId: id });
  sessions.deleteSession(id); event.update('completed');
  assert.equal(activity.list(id).length, 0);
  activity.create({ sessionId: id }).update('failed');
  storage.closeDatabase(); storage.initDatabase(directory);
  assert.equal(activity.list(id).length, 0);
  assert.equal(storage.initDatabase(directory).pragma('foreign_key_check').length, 0);
});
test('W5 eleven attempts stay distinct and conversations remain isolated', () => {
  const a = fixture(), b = fixture();
  for (let i=0;i<11;i++) activity.create({ sessionId:a, runId:'same-run' }).update('completed');
  activity.create({ sessionId:b }).update('deferred', { code:'pending-child-operation' });
  const events=activity.list(a);
  assert.equal(new Set(events.map(e=>e.id)).size,11);
  assert.ok(events.every((e,i)=>i===0||e.sequence>events[i-1].sequence));
  assert.equal(activity.list(b).length,1);
});
test('W5 Casual cannot persist Workspace activity', () => {
  const id=fixture(false); activity.create({sessionId:id}).update('completed'); assert.deepEqual(activity.list(id),[]);
});
test('W5 renderer ordering inserts activity between anchored tools without duplication', async () => {
  const { activitySegments, mergeActivity, measurementLabel }=await import('../src/lib/compactionActivity.mjs');
  const steps=[{id:'read'},{id:'test'},{id:'continue'}];
  const event={id:'attempt',session_id:'a',sequence:1,revision:2,anchor_step_id:'test'};
  const merged=mergeActivity([], [event,event,{...event,session_id:'b'}], 'a');
  assert.equal(merged.length,1);
  assert.equal(mergeActivity(merged,[{...event,revision:1}],'a')[0].revision,2);
  assert.deepEqual(activitySegments(steps,merged),[{steps:steps.slice(0,2)},{activity:event},{steps:steps.slice(2)}]);
  assert.equal(measurementLabel('approximate-full-request'),'Estimated');
  assert.equal(measurementLabel('exact-tokenizer'),'Tokenizer measured');
  assert.deepEqual(mergeActivity(merged,[],'b'),[]);
});
for (const code of ['provider-error', 'schema-invalid', 'prospective-context-overflow']) {
  test(`W5 real producer records ${code} without a reduction`, async () => {
    const id=fixture();
    const overrides=code==='prospective-context-overflow' ? {} : { generate: async()=>{throw Object.assign(Error('private'),{code});} };
    await assert.rejects(compact({sessionId:id, overrides, inject:stage=>{if(code==='prospective-context-overflow'&&stage==='prospective-build') throw Object.assign(Error(code),{code});}}));
    const [event]=activity.list(id);assert.equal(event.status,'failed');assert.equal(event.code,code);assert.equal(event.metadata.afterTokens,undefined);
  });
}
test('W5 real producer cancellation becomes terminal', async () => {
  const id=fixture();
  await assert.rejects(compact({sessionId:id, inject:stage=>{if(stage==='generation-start')require('../src/main/engineManager').activeStreams.get(id).abort();}}));
  assert.equal(activity.list(id)[0].status,'cancelled');
});
test('W5 real producer defers irreducible history with runtime reason', async () => {
  const id=`w5-${++serial}`;sessions.getOrCreateSession(id,'model',project.id);sessions.saveMessage(id,'user','Continue');
  const result=await compact({sessionId:id}); assert.equal(result.compressed,false);
  const [event]=activity.list(id);assert.equal(event.status,'deferred');assert.equal(event.code,'no-reducible-history');
});
test('W5 failed terminal write retries on list without corrupting compaction', async () => {
  const id=fixture();
  storage.initDatabase(directory).exec("CREATE TRIGGER w5_fail_update BEFORE UPDATE ON workspace_compaction_activity WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  try {assert.equal((await compact({sessionId:id})).compressed,true);}
  finally {storage.initDatabase(directory).exec('DROP TRIGGER w5_fail_update');}
  assert.equal(activity.list(id)[0].status,'completed');
});
test('W5 real producer broadcasts actual progress only after durable writes', async () => {
  const id=fixture(), seen=[];
  await compact({sessionId:id,overrides:{onActivity:event=>{assert.deepEqual(activity.list(id).at(-1),event);seen.push(event.status);}}});
  assert.ok(seen.includes('generating'));assert.ok(seen.includes('validating'));assert.ok(seen.includes('checking-fit'));assert.equal(seen.at(-1),'completed');
});
test('W5 actual preload fan-out scopes sessions and cleans every subscription', () => {
  const vm=require('node:vm'), {EventEmitter}=require('node:events');
  const ipc=new EventEmitter(), exposed={};ipc.invoke=async()=>[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/preload.js'),'utf8'),{
    require:name=>{assert.equal(name,'electron');return {ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(name,value)=>exposed[name]=value},webUtils:{}};},
    window:{},console,
  });
  const api=exposed.memoryPalace,seen=[];const subscriptions=[];
  for(let i=0;i<20;i++)subscriptions.push(api.onCompactionActivity(`s${i}`,event=>seen.push(event.session_id)));
  assert.equal(ipc.listenerCount('workspace:compaction-activity'),1);
  ipc.emit('workspace:compaction-activity',{}, {session_id:'s3'});
  assert.deepEqual(seen,['s3']);subscriptions.forEach(dispose=>dispose());
  assert.equal(ipc.listenerCount('workspace:compaction-activity'),0);
});
test('W5 continuation retains pending verified measurements after a transient terminal write failure', async () => {
  const id=fixture();
  storage.initDatabase(directory).exec("CREATE TRIGGER w5_transient BEFORE UPDATE ON workspace_compaction_activity WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  let result;
  try {result=await compact({sessionId:id});}finally{storage.initDatabase(directory).exec('DROP TRIGGER w5_transient');}
  result.markContinued();
  const [event]=activity.list(id);assert.equal(event.metadata.afterTokens,result.diagnostics.actualTokens);assert.equal(event.metadata.continued,true);
});
test('W5 provider-supplied diagnostic text cannot escape the safe code allowlist', () => {
  const id=fixture(), event=activity.create({sessionId:id});event.update('failed',{code:'private-credential-value'});
  assert.equal(activity.list(id)[0].code,'compaction-error');
});
