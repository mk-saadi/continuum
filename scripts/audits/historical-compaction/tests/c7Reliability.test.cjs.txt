'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-')), load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, Notification: { isSupported: () => false } };
  return load.call(this, name, ...args);
};
const storage = require('../src/main/db'); storage.initDatabase(directory);
const sessions = require('../src/main/sessionManager'), budget = require('../src/main/contextBudget');
const project = require('../src/main/projectManager').createProject({ name: 'C7 disposable' });
let candidate = require('../src/main/workspaceCompactCandidate');
if (process.env.C7_BEFORE_SOURCE) {
  const old = new Module(path.resolve('src/main/workspaceCompactCandidate.js'), module);
  old.filename = path.resolve('src/main/workspaceCompactCandidate.js'); old.paths = module.paths;
  old._compile(fs.readFileSync(process.env.C7_BEFORE_SOURCE, 'utf8'), old.filename); candidate = old.exports;
}
const captures = []; let serial = 0;
test.after(() => {
  if (process.env.C7_OUTPUT) fs.writeFileSync(process.env.C7_OUTPUT, JSON.stringify(captures, null, 2));
  storage.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true });
});
for (const [count, size, diagnostic, mixed = false] of [[3,100,false],[55,2000,false],[70,2000,false],[71,2000,false],[175,8000,false],[175,8000,false,true],[250,10000,false],[1,200000,false],[1,100000,true]]) {
 test(`C7 bounded evidence ${count} operations / ${size} characters / diagnostics=${diagnostic} mixed=${mixed}`, async () => {
  const id = `c7-${++serial}`; sessions.getOrCreateSession(id, 'fixture', project.id);
  sessions.saveMessage(id, 'user', 'Inspect source; preserve failures and do not publish.');
  const steps = Array.from({length:count}, (_,i) => ({ id:`op-${i}`, type:'tool_call',
   toolName: diagnostic || mixed && i % 3 === 0 ? 'execute_command' : mixed && i % 3 === 1 ? 'edit_project_files' : 'read_project_file', status:'complete',
   args: diagnostic || mixed && i % 3 === 0 ? {command:`npm test -- case-${i}`} : {relative_path:`src/file-${i}.js`},
   result: mixed ? (i % 3 === 0 ? {exitCode:i%2,stdout:`${i%2?'FAIL':'PASS'} case-${i}\n`+'log '.repeat(size/4)} : i % 3 === 1 ? {success:false,error:'Old text not found'} : 'source '.repeat(size/7)) : diagnostic ? {exitCode:1,stdout:Array.from({length:800},(_,n)=>`FAIL case-${n} ${'detail '.repeat(20)}`).join('\n')} : `finding-${i} `+'x'.repeat(size) }));
  const messageId = sessions.saveMessage(id,'assistant','Inspecting sources',[],null,null,null,null,null,steps).id;
  const before = JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id));
  const requests=[]; const started=performance.now();
  const result=await candidate.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture',capacityTokens:80000,persist:false,measure:require('./fixtures/c9SummaryTokenizer.cjs').withSummaryTokenizer(),
   generate:async request=>{
    requests.push(request); const input=JSON.parse(request.messages[1].content);
    const draft={objective:'Continue source inspection',briefIds:input.briefs.map(b=>b.id)};
    for(const key of candidate.ARRAY_KEYS) draft[key]=[];
    draft.outstandingRequirements=[{text:'Do not publish.',briefId:input.briefs[0].id,status:'open'}];
    draft.nextActions=['Verify remaining work'];
    draft.blockers=diagnostic||mixed?['Recorded test failures remain unresolved']:[];
    draft.research=(input.evidence??[]).slice(0,1).map(e=>({text:'Inspected recorded observation',sources:[{messageId:e.messageId,stepId:e.stepId}]}));
    if(input.historicalSegments) draft.research=input.historicalSegments.flatMap(s=>s.state.research);
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]};
   }});
  const row={count,size,diagnostic,mixed,ok:result.ok,code:result.code??null,elapsedMs:performance.now()-started,
   diagnostics:result.diagnostics,requests:requests.map(r=>({characters:JSON.stringify(r).length,tokens:budget.approximateTokens(r),method:'approximate-full-request',payload:r})),
   represented:result.candidate?.evidence.length??0,retrievable:0,replayed:0};
  const retrieval=require('../src/main/workspaceEvidence');
  for(const step of steps) {
   let offset=0, text=''; do {const page=retrieval.retrieve(id,{source_message_id:messageId,source_step_id:step.id,offset,length:8000});text+=page.text;offset=page.nextOffset;}while(offset!==null);
   assert.deepEqual(JSON.parse(text).result,step.result);row.retrievable++;
  }
  captures.push(row);
  assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id)),before);
  assert.equal(require('../src/main/taskCheckpoints').getLatestCheckpoint(id),null);
  if(process.env.C7_BEFORE_SOURCE && result.code==='evidence-budget-exceeded') return;
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(row.represented,count);assert.equal(row.retrievable,count);
  if (diagnostic) {
    assert.equal(result.candidate.evidence[0].diagnostics.length, 800);
    const section = require('../src/main/taskCheckpoints').workspaceCompactSection(result.candidate);
    assert.match(section.content, /800 lines stored; retrieve full result/);
    assert.match(section.content, /case-799/);
    assert.ok(section.summaryTokens < 5000);
  }
  for(const segment of result.diagnostics.staged?.segments??[]) assert.ok(segment.evidenceCharacters<=48000);
  if(result.diagnostics.newEvidenceCharacters>48000) assert.ok(result.diagnostics.staged.segments.length>1);
 });
}
test('C7 screenshot occupancy, peak, compaction, isolation and idle restoration',async()=>{
 const {selectContextOccupancy,updateRequestTelemetry,buildContextLabel,buildContextTooltip}=await import('../src/lib/contextDisplay.mjs');
 const base={prepared:31247,limit:74112,sessionId:'chat',modelId:'model'};
 let live=updateRequestTelemetry(null,{sessionId:'chat',modelId:'model',runId:'run',round:1,promptTokens:66125,method:'server-template-tokenizer',dispatched:true,isEstimate:false});
 assert.equal(selectContextOccupancy({...base,live}).tokens,66125);
 assert.match(buildContextLabel({total:66125,limit:74112}).label,/66.1k \/ 74.1k/);
 assert.match(buildContextTooltip({total:66125,limit:74112,prepared:31247,live}),/31,247/);
 live=updateRequestTelemetry(live,{...live,round:2,promptTokens:20000});
 assert.equal(live.telemetry.peakPromptTokens,66125);
 assert.equal(selectContextOccupancy({...base,live}).tokens,20000);
 assert.equal(updateRequestTelemetry(live,{...live,round:1,promptTokens:70000}),live);
 assert.equal(selectContextOccupancy({...base,sessionId:'other',live}).tokens,31247);
 assert.equal(selectContextOccupancy({...base,modelId:'other',live}).tokens,31247);
 assert.equal(selectContextOccupancy({...base,live:null}).tokens,31247);
 assert.equal(selectContextOccupancy({...base,live:{...live,budgetContract:{usableInputTokens:123}}}).tokens,31247);
});
test('C7 final local guard publishes normalized dispatch measurements before inference',async()=>{
 const {backend}=require('./fixtures/contextBackend.cjs'); const measurements=[];
 const b=backend({context:80000,tokens:text=>{assert.match(text,/schema-marker/);assert.match(text,/system-marker/);return 66125;},
  infer:(_p,_n,options)=>{assert.equal(measurements.length,1);assert.equal(options.onRequestMeasurement,undefined);return Response.json({});}});
 await b.fetch('http://localhost/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'loaded',max_tokens:5760,
  messages:[{role:'system',content:'system-marker'},{role:'system',content:'second system'},{role:'user',content:'request'}],
  tools:[{type:'function',function:{name:'schema-marker',parameters:{type:'object'}}}]}),
  onRequestMeasurement:m=>measurements.push(m)});
 assert.equal(measurements[0].tokens,66125);assert.equal(measurements[0].method,'server-template-tokenizer');
 assert.equal(b.calls[0].messages.filter(m=>m.role==='system').length,1);
 assert.equal(measurements[0].budgetContract.reservedOutputTokens,5760);
 assert.equal(measurements[0].budgetContract.reservedSafetyTokens,128);
});
test('C7 tokenizer fallback dispatch remains an estimate and cancelled dispatch emits nothing',async()=>{
 const {backend}=require('./fixtures/contextBackend.cjs');const b=backend({available:false}),seen=[];
 const options={method:'POST',body:JSON.stringify({messages:[{role:'user',content:'hi'}]}),onRequestMeasurement:m=>seen.push(m)};
 await b.fetch('http://localhost/v1/chat/completions',options);
 assert.equal(seen[0].method,'approximate-full-request');
 const controller=new AbortController();controller.abort();
 await assert.rejects(b.fetch('http://localhost/v1/chat/completions',{...options,signal:controller.signal}));
 assert.equal(seen.length,1);
});
test('C7 unrepresentable exact command metadata uses degraded prefix without covering the command',async()=>{
 const id=`c7-${++serial}`;sessions.getOrCreateSession(id,'fixture',project.id);
 sessions.saveMessage(id,'user','Inspect oversized command metadata safely.');
 const message=sessions.saveMessage(id,'assistant','Diagnostic completed',[],null,null,null,null,null,[{
  id:'huge-command',type:'tool_call',toolName:'execute_command',status:'complete',args:{command:'echo '+'x'.repeat(50000)},result:{exitCode:0,stdout:'done'}}]);
 const before=JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id=?').all(id));
 const result=await candidate.generateWorkspaceCompactCandidate({sessionId:id,modelId:'fixture',capacityTokens:80000,persist:false,measure:require('./fixtures/c9SummaryTokenizer.cjs').withSummaryTokenizer(),generate:()=>assert.fail('Unrepresentable exact metadata must not dispatch')});
 if(process.env.C7_BEFORE_SOURCE){assert.equal(result.code,'evidence-budget-exceeded');return;}
 assert.equal(result.ok,true);
 assert.equal(result.candidate.checkpointOutcome,'degraded');
 assert.equal(result.diagnostics.fallbackReason,'evidence-item-budget-exceeded');
 assert.ok(!result.candidate.sourceCoverage.some(ref=>ref.messageId===message.id));
 assert.equal(result.diagnostics.evidenceFailure.source.messageId,message.id);
 assert.equal(result.diagnostics.evidenceFailure.budget,12000);
 assert.equal(result.diagnostics.checkpointActivated,false);
 assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM messages WHERE session_id=?').all(id)),before);
 assert.equal(require('../src/main/taskCheckpoints').getLatestCheckpoint(id),null);
});
for(const apiType of ['openai','anthropic']) test(`C7 ${apiType} dispatch estimate counts the actual native body`,async()=>{
 const cloud=require('../src/main/cloudProviders');
 const provider=`c7-cloud-${apiType}`;
 cloud.saveCloudProvider({id:provider,name:'C7 fixture',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-key',apiType,modelId:'fixture'});
 const seen=[];let wire;
 const adapter=cloud.createCloudFetch({type:'cloud',provider,model:'fixture'},{stream:false,fetchImpl:async(_url,options)=>{
  wire=JSON.parse(options.body);assert.equal(seen.length,1);
  return Response.json(apiType==='anthropic'?{stop_reason:'end_turn',content:[{type:'text',text:'Done'}],usage:{input_tokens:10,output_tokens:2}}:{choices:[{finish_reason:'stop',message:{content:'Done'}}]});
 }});
 await adapter('',{body:JSON.stringify({messages:[{role:'system',content:'system fixture'},{role:'user',content:'task'}],tools:[{type:'function',function:{name:'read_fixture',parameters:{type:'object'}}}],max_tokens:100}),onRequestMeasurement:m=>seen.push(m)});
 assert.equal(seen[0].tokens,budget.approximateTokens(wire));
 assert.equal(seen[0].method,'approximate-full-request');
 if(apiType==='anthropic'){assert.ok(wire.system);assert.ok(wire.tools[0].input_schema);}
});
