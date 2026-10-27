'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const checkpoints = require('../src/main/taskCheckpoints');
const { approximateTokens } = require('../src/main/contextBudget');
const evidence = [];
const { mergeSystemMessages } = require('../src/lib/systemMessages.cjs');
const wireTokens = payload => approximateTokens({...payload,messages:mergeSystemMessages(payload.messages)}) + 5;
const { requestComposition, measuredComposition } = require('../src/main/compactionPerformance');
function checkpoint(count = 60) {
 return { objective: 'Finish the authorized patch', outstandingRequirements: [{text:'Do not publish; preserve failing tests.',briefId:1,status:'open'}],
 research: Array.from({length:count},(_,i)=>({text:`Verified finding ${i}`,sources:[{messageId:2,stepId:`op-${i}`}]})),
 evidence: Array.from({length:count},(_,i)=>({messageId:2,stepId:`op-${i}`,toolName:'read_project_file',outcome:'success',observation:'source finding '.repeat(19),observationPartial:true,paths:[`src/f${i}.js`]})) };
}
const original = {exports:require('./fixtures/c8CheckpointBefore.cjs')};
function request(c, fixed, oldHistory=0) { return {model:'fixture',messages:[{role:'system',content:'s'.repeat(fixed)}, checkpoints.workspaceCompactSection(c),{role:'user',content:'Continue safely'},...(oldHistory?[{role:'assistant',content:'h'.repeat(oldHistory)}]:[])],tools:[],max_tokens:5760}; }
for(const [before,after] of [[33571,28341],[32968,27923]]) test(`C8 controlled reconstruction ${before} → ${after}`,async()=>{
 const c=checkpoint();const oldSection=original.exports.workspaceCompactSection(c);
 // Calibrate disposable JSON bodies using the existing full-request estimator.
 // Original production requests/tokenizer are unavailable: these are controlled fixtures.
 const old={...request(c,0),messages:[{role:'system',content:''},oldSection,{role:'user',content:'Continue safely'}]};
 old.messages[0].content='s'.repeat(Math.max(0,(after-wireTokens(old))*3));
 while(wireTokens(old)<after) old.messages[0].content+='s';
 const full=structuredClone(old); full.messages.push({role:'assistant',content:''});
 full.messages.at(-1).content='h'.repeat(Math.max(0,(before-wireTokens(full))*3));
 while(wireTokens(full)<before) full.messages.at(-1).content+='h';
 const compact={...old,messages:[old.messages[0],checkpoints.workspaceCompactSection({...c,evidencePresentation:'references'}),old.messages[2]]};
 const row={case:`${before}-${after}`,kind:'deterministic-estimator-reconstruction',before:wireTokens(full),legacyAfter:wireTokens(old),after:wireTokens(compact),checkpointTokens:approximateTokens({messages:[compact.messages[1]]})};
 const backend = require('./fixtures/contextBackend.cjs').backend({context:40064,tokens:text=>approximateTokens(JSON.parse(text))});
 const seen=[];
 for (const payload of [full, old, compact]) await backend.fetch('http://fixture.invalid/v1/chat/completions', {
   method:'POST',body:JSON.stringify(payload),onRequestMeasurement:result=>seen.push(result)
 });
 assert.equal(seen[0].tokens,row.before);assert.equal(seen[1].tokens,row.legacyAfter);assert.equal(seen[2].tokens,row.after);
 assert.equal(seen[0].budgetContract.usableInputTokens,34176);
 assert.equal(seen[0].budgetContract.autoCompactionTriggerTokens,30758);
 row.finalRequests = backend.calls.map((payload,i)=>requestComposition(payload,seen[i]));
 row.composition = await measuredComposition(backend.calls[2],async payload=>({tokens:wireTokens(payload),method:'deterministic-template-tokenizer-fixture'}),seen[2]);
 row.measurement='normalized-provider-wire-body; deterministic mock tokenizer, not Qwen';
 evidence.push(row);assert.equal(row.before,before);assert.equal(row.legacyAfter,after);
 if(process.env.C8_BASELINE) return;
 assert.ok(row.after<after); assert.match(compact.messages[1].content,/Verified finding 59/);assert.match(compact.messages[1].content,/Do not publish/);
});
test('C8 target-capable request retains constraints and sources',async()=>{
 const c=checkpoint(60); const old={...request(c,25000),messages:[request(c,25000).messages[0],original.exports.workspaceCompactSection(c)]};
 const next={...old,messages:[old.messages[0],checkpoints.workspaceCompactSection({...c,evidencePresentation:'references'})]};
 const backend = require('./fixtures/contextBackend.cjs').backend({context:40064,tokens:text=>approximateTokens(JSON.parse(text))});
 const seen=[];
 for(const payload of [old,next]) await backend.fetch('http://fixture.invalid/v1/chat/completions',{method:'POST',body:JSON.stringify(payload),onRequestMeasurement:result=>seen.push(result)});
 assert.equal(seen[1].tokens,wireTokens(next));
 evidence.push({case:'target-capable',before:seen[0].tokens,after:seen[1].tokens,finalRequests:backend.calls.map((payload,i)=>requestComposition(payload,seen[i]))});
 if(!process.env.C8_BASELINE){assert.ok(wireTokens(old)>17000); assert.ok(wireTokens(next)<17000);}
});
test.after(()=>{if(process.env.C8_OUTPUT)fs.writeFileSync(process.env.C8_OUTPUT,JSON.stringify(evidence,null,2));});

for (const mode of ['schemas','protected']) test(`C8 ${mode} dominated final request cannot reach target`,async()=>{
 const payload = request(checkpoint(2),0);
 if(mode==='schemas') payload.tools=[{type:'function',function:{name:'tool',description:'s'.repeat(60000),parameters:{type:'object'}}}];
 else payload.messages.push({role:'assistant',tool_calls:[{id:'protected',type:'function',function:{name:'read',arguments:'{}'}}]}, {role:'tool',tool_call_id:'protected',content:'r'.repeat(60000)});
 const measured=await measuredComposition(payload,async value=>({tokens:wireTokens(value),method:'deterministic-estimator'}),{tokens:wireTokens(payload),method:'deterministic-estimator'});
 assert.ok(wireTokens(payload)>17000);
 assert.ok(measured.entries[mode==='schemas'?'toolSchemas':'protectedToolRounds'].marginalTokens>19000);
 evidence.push({case:mode+'-dominated',tokens:wireTokens(payload),composition:measured});
});
