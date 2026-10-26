'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c6e-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager'), briefs = require('../src/main/taskBriefs');
const project = require('../src/main/projectManager').createProject({ name: 'C6-E disposable' });
let serial = 0;
function fixture(current) {
 const id = `c6e-${++serial}`; sessions.getOrCreateSession(id, 'fixture', project.id);
 sessions.saveMessage(id, 'user', 'Suggest features.');
 for (let i=0;i<100;i++) sessions.saveMessage(id, 'assistant', `Finding ${i}: ` + 'feature observation '.repeat(20));
 sessions.saveMessage(id, 'user', current); return id;
}
for (const current of ['Create a new settings component.', 'Implement the features you suggested earlier.']) test(`oversized historical index: ${current}`, () => {
 const id=fixture(current);
 const section=briefs.buildTaskBriefSection(id, {contextWindowLimit: 90000});
 assert.ok(section.content.length < 24000);
 assert.equal(briefs.getAllBriefs(id).length, 2);
 if (current.includes('earlier')) assert.match(section.content, /source_message_id/);
});
test.after(() => { storage.closeDatabase(); Module._load=load; fs.rmSync(directory,{recursive:true,force:true}); });
const checkpoints = require('../src/main/taskCheckpoints'), crypto = require('node:crypto');
const evidence = require('../src/main/workspaceEvidence'), budget = require('../src/main/contextBudget');
const captures=[];
async function dispatch(id, before=false) {
 const original=briefs.buildTaskBriefSection, originalCheckpoint=checkpoints.buildCheckpointSection;
 if(before) {
  const old=new Module(path.resolve('src/main/taskBriefs.js'), module); old.filename=path.resolve('src/main/taskBriefs.js'); old.paths=module.paths;
  old._compile(fs.readFileSync(path.join(__dirname,'fixtures/c6e-taskBriefs-before.cjs'),'utf8'),old.filename);
  briefs.buildTaskBriefSection=old.exports.buildTaskBriefSection;
  checkpoints.buildCheckpointSection=id=>require('./fixtures/c6eCheckpointBefore.cjs')(checkpoints.getLatestCheckpoint(id).checkpoint);
 }
 let request;
 try {
  const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
  await runMemoryChat({modelId:'fixture',baseUrl:'http://fixture.invalid',projectId:project.id,
   messages:require('../src/main/promptBuilder').rebuildChatMessages({sessionId:id,modelId:'fixture'}),
   chatTools:require('../src/main/tools/agentTools').agentTools.filter(t=>t.function.name==='get_recent_chat_history'),
   fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return Response.json({choices:[{message:{content:'Done [TASK COMPLETE]'},finish_reason:'stop'}]});}});
 } finally {briefs.buildTaskBriefSection=original;checkpoints.buildCheckpointSection=originalCheckpoint;}
 return request;
}
function composition(request) {
 const serialized=JSON.stringify(request), system=request.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 const cost=regex=>Math.ceil((system.match(regex)?.[0]?.length??0)/4);
 const entries=[...system.matchAll(/\[Brief #(\d+)[^\n]*\]:\n([\s\S]*?)\[End of brief #\1\]/g)];
 const entryCost=items=>Math.ceil(items.reduce((sum,e)=>sum+e[0].length,0)/4);
 const cpStart=system.indexOf('[WORKSPACE CHECKPOINT]');
 let checkpointCharacters=0;
 if(cpStart>=0){const start=system.indexOf('{',cpStart);let depth=0,quoted=false,escaped=false;
  for(let i=start;i<system.length;i++){const c=system[i];if(escaped){escaped=false;continue;}if(quoted&&c==='\\'){escaped=true;continue;}if(c==='"'){quoted=!quoted;continue;}if(quoted)continue;if(c==='{')depth++;if(c==='}'&&--depth===0){checkpointCharacters=i+1-cpStart;break;}}} 
 return {serializedBytes:Buffer.byteLength(serialized),inputTokens:budget.approximateTokens(request),method:'approximate-full-request; no exact tokenizer',
  historicalBriefTokens:entryCost(entries.slice(0,-1).filter(e=>!e[2].includes('Never publish'))),
  currentTaskAndConstraintTokens:entryCost(entries.filter((e,i)=>i===entries.length-1||e[2].includes('Never publish'))),
  historicalIndexTokens:cost(/\[RELEVANT HISTORICAL DEPENDENCY SOURCES\][\s\S]*/),
  checkpointTokens:Math.ceil(checkpointCharacters/4),
  toolSchemaTokens:Math.ceil(JSON.stringify(request.tools??[]).length/4),
  protectedRecentRoundTokens:0,historicalSourceItems:(system.match(/source_message_id":/g)??[]).length,
  storedSourceRetrievals:0,generationStages:1,repeatedToolExecutions:0};
}
for(const count of [5,20,50,100]) test(`covered unknown briefs: serialized ${count}-brief comparison`,async()=>{
 const id=`measure-${++serial}`;sessions.getOrCreateSession(id,'fixture',project.id);
 const first=sessions.saveMessage(id,'user','Use TypeScript. Never publish.\nPersistent constraints:\nComponents target ES2022.\n# Task\nInspect configuration.');
 for(let i=0;i<count;i++) sessions.saveMessage(id,'user',`Historical widget ${i}: ${'Implement an isolated widget. '.repeat(20)}`);
 const finding=sessions.saveMessage(id,'assistant','EARLY_FINDING: config uses monotonic IDs.');
 const w2=require('../src/main/workspaceCompactCandidate');
 const generated=await w2.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture',capacityTokens:90000,persist:false,
  generate:async request=>{const input=JSON.parse(request.messages[1].content); const draft={objective:'Inspect current configuration',briefIds:input.briefs.map(b=>b.id)};
   for(const key of w2.ARRAY_KEYS)draft[key]=[];
   draft.research=[{text:'EARLY_FINDING: config uses monotonic IDs.',sources:[{messageId:finding.id}]}];
   return {choices:[{message:{content:JSON.stringify(draft)},finish_reason:'stop'}]};}});
 assert.ok(generated.ok,JSON.stringify(generated));
 storage.db.transaction(()=>{
  checkpoints.persistCheckpointRow({sessionId:id,modelId:'fixture',checkpoint:{...generated.candidate,lifecycle:'w3-current'},briefIdentity:briefs.getBriefIdentity(id)});
  storage.db.prepare('UPDATE messages SET archived=1 WHERE session_id=?').run(id);
 })();
 sessions.saveMessage(id,'user','Create a new settings component.');
 const before=await dispatch(id,true),after=await dispatch(id);
 assert.doesNotMatch(JSON.stringify(after),/Implement an isolated widget/);
 for(const text of ['Use TypeScript','Never publish','Components target ES2022','EARLY_FINDING','Create a new settings']) assert.ok(JSON.stringify(after).includes(text));
 assert.ok(budget.approximateTokens(after)<budget.approximateTokens(before));
 assert.equal(briefs.getAllBriefs(id).length,count+2);
 assert.match(evidence.retrieve(id,{source_message_id:first.id}).text,/TypeScript/);
 const checkpointSection=checkpoints.workspaceCompactSection(generated.candidate);
 assert.ok(checkpointSection.workingStateEstimatedTokens<3000);
 captures.push({count,before:composition(before),after:composition(after),essentialInformationCoverage:true,requests:{before,after}});
});
test('bounded source navigation finds old references and rejects missing required source',()=>{
 const id=fixture('Implement the features you suggested earlier.');
 const page=evidence.retrieve(id,{source_history:true,query:'Finding 0'});
 assert.equal(page.items.length,1);
 assert.match(evidence.retrieve(id,{source_message_id:page.items[0].source_message_id}).text,/Finding 0/);
 sessions.saveMessage(id,'user','Use earlier plan source_message_id=99999999');
 assert.throws(()=>briefs.buildTaskBriefSection(id),e=>e.code==='HISTORICAL_DEPENDENCY_UNAVAILABLE');
 assert.throws(()=>evidence.retrieve('not-owned',{source_history:true}));
});
test('essential state above soft target is retained and reports reason',()=>{
 const state={objective:'large essential state',outstandingRequirements:[{text:'essential '.repeat(4000),briefId:1,status:'open'}]};
 const section=checkpoints.workspaceCompactSection(state);
 assert.ok(section.workingStateEstimatedTokens>5000);assert.ok(section.workingStateSizeReason);
 assert.match(section.content,/essential essential/);
});
test('invalid coverage cannot suppress old requirements',()=>{
 const id=fixture('New current task.');
 checkpoints.persistCheckpointRow({sessionId:id,modelId:'fixture',checkpoint:{version:2,lifecycle:'w3-current',sourceCoverage:[{messageId:briefs.getAllBriefs(id)[0].message_id,digest:'bad'}]},briefIdentity:briefs.getBriefIdentity(id)});
 assert.match(briefs.buildTaskBriefSection(id).content,/Suggest features/);
});
test.after(()=>{if(process.env.C6E_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.C6E_EVIDENCE_OUTPUT,JSON.stringify({captures},null,2));});
test('40.4% serialized request dispatches; real budget overflow does not',async()=>{
 const id=fixture('Implement the features suggested earlier.');
 const request=await dispatch(id);
 const {backend}=require('./fixtures/contextBackend.cjs');
 const b=backend({context:90112,tokens:35972});
 await b.fetch('http://localhost/v1/chat/completions',{method:'POST',body:JSON.stringify(request),contextWindowLimit:90000});
 assert.equal(b.calls.length,1);
 const over=backend({context:90112,tokens:90000});
 await assert.rejects(over.fetch('http://localhost/v1/chat/completions',{method:'POST',body:JSON.stringify(request),contextWindowLimit:90000}),/cannot fit/);
 assert.equal(over.calls.length,0);
 captures.push({scenario:'reported capacity reproduction; mocked tokenizer, not real-model validation',runtimeCapacity:90112,usableInput:88960,mockedInputTokens:35972,dispatchedRequest:b.calls[0],overflowDispatches:over.calls.length});
});
test('source navigation honors tombstones and active branch ownership',()=>{
 const id=fixture('Independent task.');
 const old=sessions.saveMessage(id,'assistant','PRIVATE_OLD_BRANCH');
 sessions.saveMessage(id,'user','New leaf');
 storage.db.prepare('UPDATE sessions SET active_leaf_id=? WHERE id=?').run(briefs.getAllBriefs(id)[0].message_id,id);
 assert.equal(evidence.retrieve(id,{source_history:true,query:'PRIVATE_OLD_BRANCH'}).items.length,0);
 assert.throws(()=>evidence.retrieve(id,{source_message_id:old.id}),/unavailable/);
 storage.db.prepare('INSERT INTO deleted_sessions(id) VALUES (?)').run(id);
 assert.throws(()=>evidence.retrieve(id,{source_history:true}),e=>e.code==='deleted-conversation');
});
test('eleven compactions reuse archived evidence beyond the per-generation ceiling',async()=>{
 const id=`incremental-${++serial}`;sessions.getOrCreateSession(id,'fixture',project.id);
 sessions.saveMessage(id,'user','Inspect configuration.');
 const w2=require('../src/main/workspaceCompactCandidate');
 let final;
 for(let round=0;round<11;round++){
  const message=sessions.saveMessage(id,'assistant','Inspecting',[],null,null,null,null,null,
   Array.from({length:12},(_,i)=>({id:`e-${round}-${i}`,type:'tool_call',toolName:'read_project_file',status:'complete',args:{relative_path:`config-${i}.js`},result:`Finding ${round}-${i}: `+'configuration evidence '.repeat(35)})));
  final=await w2.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture',capacityTokens:90000,persist:false,
   generate:async request=>{const input=JSON.parse(request.messages[1].content);
    if(round>0){assert.ok(input.messages.every(m=>m.id===message.id));assert.equal(input.evidence.length,12);}
    const draft={objective:'Inspect configuration',briefIds:input.briefs.map(b=>b.id)};
    for(const key of w2.ARRAY_KEYS)draft[key]=[];
    return {choices:[{message:{content:JSON.stringify(draft)},finish_reason:'stop'}]};}});
  assert.ok(final.ok,JSON.stringify(final));assert.equal(final.candidate.evidence.length,(round+1)*12);
  checkpoints.persistCheckpointRow({sessionId:id,modelId:'fixture',checkpoint:{...final.candidate,lifecycle:'w3-current'},briefIdentity:briefs.getBriefIdentity(id)});
  storage.db.prepare('UPDATE messages SET archived=1 WHERE session_id=?').run(id);
 }
 assert.ok(JSON.stringify(final.candidate.evidence).length>48000);
 assert.match(evidence.retrieve(id,{source_step_id:'e-0-0'}).text,/Finding 0-0/);
 captures.push({scenario:'eleven incremental compactions',durableEvidenceItems:final.candidate.evidence.length,durableEvidenceBytes:Buffer.byteLength(JSON.stringify(final.candidate.evidence)),newEvidencePerGeneration:12,duplicateEvidence:0,generationStages:11});
});
test('covered unknown attachment requirements stay available without inferred revocation',async()=>{
 const id=`attachment-${++serial}`;sessions.getOrCreateSession(id,'fixture',project.id);
 fs.mkdirSync(path.join(directory,'attachments'),{recursive:true});
 const file=path.join(directory,'attachments','requirements.txt');fs.writeFileSync(file,'ATTACHMENT_REQUIREMENT: components target ES2022.');
 sessions.saveMessage(id,'user','Review the attached specification.',[{file_path:file,mime_type:'text/plain'}]);
 const w2=require('../src/main/workspaceCompactCandidate');
 const result=await w2.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture',capacityTokens:90000,persist:false,
  generate:async request=>{const input=JSON.parse(request.messages[1].content);const draft={objective:'Review specification',briefIds:input.briefs.map(b=>b.id)};for(const key of w2.ARRAY_KEYS)draft[key]=[];
   return {choices:[{message:{content:JSON.stringify(draft)},finish_reason:'stop'}]};}});
 assert.ok(result.ok,JSON.stringify(result));
 checkpoints.persistCheckpointRow({sessionId:id,modelId:'fixture',checkpoint:{...result.candidate,lifecycle:'w3-current'},briefIdentity:briefs.getBriefIdentity(id)});
 storage.db.prepare('UPDATE messages SET archived=1 WHERE session_id=?').run(id);
 sessions.saveMessage(id,'user','Inspect an independent component.');
 assert.match(briefs.buildTaskBriefSection(id).content,/ATTACHMENT_REQUIREMENT/);
});
