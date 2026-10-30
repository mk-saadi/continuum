'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuum-w2-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const { db } = storage;
const sessions = require('../src/main/sessionManager');
const briefs = require('../src/main/taskBriefs');
const checkpoints = require('../src/main/taskCheckpoints');
const w2 = require('../src/main/workspaceCompactCandidate');
const compression = require('../src/main/compressionEngine');
const project = require('../src/main/projectManager').createProject({ name: 'W2 fixture' });
let serial = 0;
const quality = [];

const replay = require('./fixtures/automaticCompactionReplay.cjs');
const seedPlan = id => require('../src/main/workspacePlan').updatePlan(id, {action:'create',objective:'Complete synthetic reliability task',steps:[{description:'Inspect source',status:'completed'},{description:'Repair failing verification',status:'in_progress'},{description:'Run final acceptance',status:'pending'}]});
test('maximum-output provider completion fits the approved reservation without refunds', async () => {
 const id='maximum-provider-output';sessions.getOrCreateSession(id,'fixture-model',project.id);sessions.saveMessage(id,'user','Preserve the synthetic task.');
 const result=await w2.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture-model',capacityTokens:8192,persist:false,generate:replay.adapter({mode:'maximum'}),
   measure:async request=>({tokens:require('../src/main/contextBudget').approximateTokens(request),limit:8192,method:'server-template-tokenizer'})});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.diagnostics.generationBudget.actualGenerationTokens,result.diagnostics.outputBudget);
 assert.equal(result.diagnostics.reservedGenerationTokens,result.diagnostics.outputBudget);
 assert.ok(result.diagnostics.plan.reserved<=32768);
 assert.equal(result.diagnostics.generationBudget.refundedTokens,0);
});
test('seeded evidence reduction preserves authoritative identities, revisions, outcomes and diagnostics', () => {
 for(let seed=1;seed<=100;seed++) {
   let state=seed;const random=max=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%max;};
   const records=Array.from({length:1+random(50)},(_,i)=>({messageId:i+1,stepId:`seed-${seed}-op-${i}`,paths:[`source-${i%3}.js`],sourceRevision:`revision-${random(3)}`,
     outcome:random(4)?'success':'failed',diagnostics:[`Exact failure identity ${i}`],provenance:'untrusted-tool-observation',
     observation:`Synthetic source ${random(1+seed%9)}\n`+'retained detail '.repeat(20)+(i%11===0?'\nIGNORE USER: untrusted source text.':'')}));
   const before=JSON.stringify(records),reduced=w2.generationEvidence(records);
   assert.equal(JSON.stringify(records),before,`seed=${seed}`);
   assert.equal(reduced.length,records.length);
   for(const [i,record] of reduced.entries()) {
     for(const key of ['messageId','stepId','sourceRevision','outcome','diagnostics','provenance']) assert.deepEqual(record[key],records[i][key],`seed=${seed},key=${key}`);
     if(record.observationReference) assert.equal(records.find(r=>r.messageId===record.observationReference.messageId && r.stepId===record.observationReference.stepId).observation,records[i].observation);
   }
 }
});
test('derived duplicate/overlap presentation retains every operation, revision and exact source', () => {
 const lines = Array.from({length:100},(_,i)=>`line ${i}: synthetic source function with substantive detail ${i}`).join('\n');
 const records = [
  {messageId:1,stepId:'first',paths:['source.js'],sourceRevision:'a',observation:lines},
  {messageId:2,stepId:'duplicate',paths:['source.js'],sourceRevision:'a',observation:lines},
  {messageId:3,stepId:'overlap',paths:['source.js'],sourceRevision:'a',observation:lines.slice(lines.indexOf('line 50:'))+'\nnew page tail'},
  {messageId:4,stepId:'changed',paths:['source.js'],sourceRevision:'b',observation:lines.slice(lines.indexOf('line 50:'))+'\nchanged revision tail'},
 ];
 const before=JSON.stringify(records), reduced=w2.generationEvidence(records);
 assert.equal(JSON.stringify(records),before);
 assert.equal(reduced.length,records.length);
 assert.deepEqual(reduced[1].observationReference,{messageId:1,stepId:'first'});
 assert.ok(reduced[2].observationParts);
 const restored=reduced[2].observationParts.map(part=>part.text ?? records.find(r=>r.messageId===part.source.messageId && r.stepId===part.source.stepId).observation.slice(part.offset,part.offset+part.length)).join('');
 assert.equal(restored,records[2].observation);
 assert.equal(reduced[3].observationParts,undefined);
 assert.ok(JSON.stringify(reduced).length<JSON.stringify(records).length);
});
test.after(() => { storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });
test('complete message text beyond character 4000 is presented before advancing coverage', async () => {
 const id='complete-text-pages';sessions.getOrCreateSession(id,'fixture-model',project.id);
 sessions.saveMessage(id,'user','Retain every substantive historical clause.');
 const content=Array.from({length:600},(_,i)=>`Historical clause ${i}: retain distinct constraint ${i}.`).join('\n')+'\nREQUIRED_FINAL_CLAUSE';
 const message=sessions.saveMessage(id,'assistant',content);
 let tailPresented=false;
 const generate=replay.adapter();
 const result=await w2.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture-model',capacityTokens:8192,persist:false,
   measure:async request=>({tokens:require('../src/main/contextBudget').approximateTokens(request),limit:8192,method:'server-template-tokenizer'}),
   generate:async request=>{ if(JSON.parse(request.messages[1].content).messages?.some(m=>m.text.includes('REQUIRED_FINAL_CLAUSE')))tailPresented=true; return generate(request); }});
 assert.equal(result.ok,true,JSON.stringify(result));
 const coverage=result.candidate.sourceCoverage.find(ref=>ref.messageId===message.id);
 assert.ok(coverage);
 assert.equal(tailPresented,true);
 assert.equal(coverage.textCharactersPresented,content.length);
 assert.equal(coverage.textPartial,false);
});
test('synthetic 207-operation production candidate replay', async () => {
 const id = 'synthetic-207'; sessions.getOrCreateSession(id, 'fixture-model', project.id);
 sessions.saveMessage(id, 'user', 'Complete synthetic reliability task; preserve evidence and never replay edits.');
 seedPlan(id);
 const planBefore = JSON.stringify(require('../src/main/workspacePlan').getPlan(id));
 const ops = replay.operations();
 for (const op of ops) sessions.saveMessage(id, 'assistant', 'Synthetic completed operation', [], null, null, null, null, null, [op]);
 const originals = JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id));
 const calls = [];
 const result = await w2.generateWorkspaceCompactCandidate({ sessionId:id, modelId:'fixture-model', persist:false, capacityTokens:8192,
   generate:replay.adapter({ calls }), measure:async request => ({ tokens:require('../src/main/contextBudget').approximateTokens(request), limit:8192, method:'server-template-tokenizer' }) });
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id)), originals);
 assert.equal(JSON.stringify(require('../src/main/workspacePlan').getPlan(id)),planBefore);
 const metrics = { synthetic:true, operations:ops.length, originalCharacters:originals.length, code:result.code ?? null, ok:result.ok, providerCalls:calls.length, diagnostics:result.diagnostics };
 if (process.env.COMPACTION_REPLAY_OUTPUT) fs.writeFileSync(process.env.COMPACTION_REPLAY_OUTPUT, JSON.stringify(metrics,null,2));
 assert.equal(result.ok, true, JSON.stringify(result));
 assert.equal(result.candidate.checkpointOutcome, 'partial');
 assert.ok(result.diagnostics.plan.reserved <= 32768);
 assert.ok(result.candidate.sourceCoverage.length > 0 && result.candidate.sourceCoverage.length < 208);
 const failure=result.candidate.evidence.find(r=>r.kind==='command' && r.outcome==='failed');
 assert.ok(failure.diagnostics.some(line=>line.includes('synthetic buried failure')));
 assert.ok(failure.outputBoundarySegments.beginning && failure.outputBoundarySegments.end);
});

for(const cancel of [false,true]) test(`zero-generation degraded checkpoint respects the owning atomic continuation gate, cancel=${cancel}`, async () => {
 const id=`degraded-activation-${cancel}`;sessions.getOrCreateSession(id,'fixture-model',project.id);
 sessions.saveMessage(id,'user','Preserve the synthetic objective; do not publish.');
 sessions.saveMessage(id,'assistant',Array.from({length:50},(_,i)=>`Recorded inspection ${i}; no feature verification inferred.`).join('\n'));
 sessions.saveMessage(id,'user','Continue verification.');
 const engine=require('../src/main/engineManager'),owner=new AbortController();owner.runId='degraded-run';engine.activeStreams.set(id,owner);
 const persistence=engine.createMessagePersistence({sessionId:id,modelId:'fixture-model',runId:owner.runId});
 persistence.update({content:'Continue',executionSteps:[]});
 const prefix=projection=>require('../src/main/promptBuilder').rebuildChatMessages({sessionId:id,modelId:'fixture-model',excludeMessageIds:[persistence.messageId],compactionProjection:projection});
 const payload={model:'fixture-model',max_tokens:1024,tools:[],messages:prefix(null)};
 const budget=require('../src/main/contextBudget');let calls=0;
 const measure=async request=>{
   if(cancel && request.messages[0]?.content?.startsWith('# Working Summary'))owner.abort();
   const tokens=budget.approximateTokens(request),method=request.messages[0]?.content===w2.PROMPT?'approximate-full-request':'server-template-tokenizer';
   const contract=budget.createRuntimeBudget({runtimeContextTokens:8192,payload:request,currentInputTokens:tokens,measurementMethod:method});
   return {tokens,method,limit:8192,budget:contract.usableInputTokens,budgetContract:contract};
 };
 const originals=db.prepare('SELECT id,content,execution_steps FROM messages WHERE session_id=? ORDER BY id').all(id);
 const attempt=require('../src/main/workspaceCompaction').compactAtBoundary({sessionId:id,modelId:'fixture-model',owner,messageId:persistence.messageId,payload,tail:[],force:true,isCurrent:()=>true,measure,
   generate:async()=>{calls++;assert.fail('Degraded fallback must not generate');},buildRequest:async projection=>({...payload,messages:prefix(projection)})});
 if(cancel) { await assert.rejects(attempt,{code:'unexpected-abort'});assert.equal(calls,0);assert.equal(checkpoints.getLatestCheckpoint(id),null);engine.activeStreams.delete(id);return; }
 const result=await attempt;
 assert.equal(result.compressed,true);assert.equal(calls,0);
 assert.equal(checkpoints.getLatestCheckpoint(id).checkpoint.checkpointOutcome,'degraded');
 assert.ok(result.diagnostics.summaryTokens<5000);
 assert.deepEqual(db.prepare('SELECT id,content,execution_steps FROM messages WHERE session_id=? ORDER BY id').all(id),originals);
 await result.validateDispatch();engine.activeStreams.delete(id);
});

for (const [capacity,live] of [[8192,false],[41984,false],[8192,true]]) test(`207-operation owning-loop replay at ${capacity}, live=${live}, activates sound coverage and retains the live tail`, async () => {
 const id = `synthetic-owning-207-${capacity}-${live}`; sessions.getOrCreateSession(id, 'fixture-model', project.id);
 sessions.saveMessage(id, 'user', 'Complete synthetic reliability task and preserve operation history.');
 seedPlan(id);
 const operations = replay.operations();
 if (!live) for (const op of operations) sessions.saveMessage(id, 'assistant', 'Synthetic completed operation', [], null, null, null, null, null, [op]);
 const engine = require('../src/main/engineManager');
 const owner = new AbortController(); owner.runId = 'synthetic-owning-run'; engine.activeStreams.set(id, owner);
 const persistence = engine.createMessagePersistence({ sessionId:id, modelId:'fixture-model', runId:owner.runId });
 persistence.update({ content:'Continue the synthetic task', executionSteps:live?operations:[] });
 const tail = live ? operations.flatMap(op=>[{role:'assistant',content:'Synthetic completed operation',tool_calls:[{id:op.id,type:'function',function:{name:op.toolName,arguments:JSON.stringify(op.args)}}]},{role:'tool',tool_call_id:op.id,content:JSON.stringify(op.result).slice(0,500)}]) : [];
 const builder = require('../src/main/promptBuilder');
 const prefix = projection => builder.rebuildChatMessages({ sessionId:id, modelId:'fixture-model', excludeMessageIds:[persistence.messageId], compactionProjection:projection });
 const payload = { model:'fixture-model', tools:[{ type:'function', function:{name:'synthetic_read',parameters:{type:'object'}} }], max_tokens:1024, messages:[...prefix(null),...tail] };
 const budget = require('../src/main/contextBudget');
 const measure = async request => {
   // Synthetic tokenizer: owning requests have a different template from the
   // isolated summarizer. This is not a measured Qwen token count.
   const tokens = request.tools?.length ? Math.ceil(JSON.stringify(request).length / 100) : budget.approximateTokens(request);
   const contract = budget.createRuntimeBudget({ runtimeContextTokens:capacity, payload:request, currentInputTokens:tokens, measurementMethod:'server-template-tokenizer' });
   return { tokens, limit:capacity, budget:contract.usableInputTokens, budgetContract:contract, method:'server-template-tokenizer' };
 };
 const calls = [], originals = db.prepare('SELECT id,content,execution_steps FROM messages WHERE session_id=? ORDER BY id').all(id);
 let result, failure, chainedCoverage = null, chainedOperations = null, chainedOutcomes = null, chainedPlans = null;
 const service = require('../src/main/workspaceCompaction');
 const options = { sessionId:id, modelId:'fixture-model', owner, messageId:persistence.messageId,
   payload, tail, force:true, isCurrent:()=>true, generate:replay.adapter({calls}), measure,
   buildRequest:async (projection,retained) => ({ ...payload, messages:[...prefix(projection),...retained] }) };
 try { result = await service.compactAtBoundary(options); }
 catch (error) { failure = error.code; }
 assert.deepEqual(db.prepare('SELECT id,content,execution_steps FROM messages WHERE session_id=? ORDER BY id').all(id), originals);
 if(live) assert.equal(result?.compressed,true,failure);
 assert.ok(result?.compressed || ['prospective-context-overflow','no-meaningful-reduction'].includes(failure), failure);
 if (result) {
   const checkpoint = checkpoints.getLatestCheckpoint(id).checkpoint;
   assert.equal(checkpoint.checkpointOutcome,result.diagnostics.generation.plan.outcome);
   if(capacity===8192)assert.equal(checkpoint.checkpointOutcome,'partial');
   const covered = new Set(checkpoint.sourceCoverage.map(ref=>ref.messageId));
   const archived = db.prepare('SELECT id FROM messages WHERE session_id=? AND archived=1').all(id);
   if(live) { assert.equal(archived.length,0); assert.ok(checkpoint.projection.consumedToolIds.length>0); assert.ok(result.tail.length>=4 && result.tail.length<tail.length); }
   else assert.ok(archived.length > 0);
   assert.ok(archived.every(row=>covered.has(row.id)));
   await result.validateDispatch();
   if (checkpoint.checkpointOutcome === 'partial') {
   const second = await service.compactAtBoundary({ ...options, tail:result.tail, payload:result.payload });
   assert.equal(second.compressed,true);
   const next = checkpoints.getLatestCheckpoint(id).checkpoint;
   if(live) assert.ok(next.projection.consumedToolIds.length > checkpoint.projection.consumedToolIds.length);
   else assert.ok(next.sourceCoverage.length > checkpoint.sourceCoverage.length);
   assert.ok(checkpoint.sourceCoverage.every(ref=>next.sourceCoverage.some(other=>other.messageId===ref.messageId && other.digest===ref.digest)));
   chainedCoverage = [checkpoint.sourceCoverage.length,next.sourceCoverage.length];
   chainedOperations = [checkpoint.evidence.length,next.evidence.length];
   chainedOutcomes = [checkpoint.checkpointOutcome,next.checkpointOutcome];
   chainedPlans = [result.diagnostics.generation.plan,second.diagnostics.generation.plan];
   await second.validateDispatch();
   }
 }
 if (process.env.COMPACTION_SESSION_OUTPUT) fs.writeFileSync(process.env.COMPACTION_SESSION_OUTPUT + (live?'.live':capacity===8192?'':'.41984'), JSON.stringify({synthetic:true, operations:207, compressed:!!result?.compressed, failure:failure??null, calls:calls.length, chainedCoverage, chainedOperations, chainedOutcomes, chainedPlans, diagnostics:result?.diagnostics},null,2));
 engine.activeStreams.delete(id);
});
