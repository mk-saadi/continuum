'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../src/main/compactionOperationalCheckpoint');
const digest = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
const captured = { version:'source-version', briefs:[{id:1,content_text:'Repair synthetic task; do not publish.'}], plan:{status:'in_progress',steps:[{text:'Verify patch',status:'pending'}]}, steering:[], messages:Array.from({length:20},(_,i)=>({id:i+1,role:'assistant',content:`Synthetic observation ${i}. `.repeat(20),status:'complete',execution_steps:JSON.stringify([{id:`op-${i}`,status:'complete',result:{exitCode:i%2,stdout:'not ok synthetic scoped verification'}}])})) };
const measure = async request => ({ tokens:Math.ceil(JSON.stringify(request).length/3), method:'server-template-tokenizer' });
test('degraded coverage is an exact older prefix; chained builds preserve prior state and never mutate originals', async () => {
  const original = JSON.stringify(captured);
  const first = await build({captured,modelId:'synthetic',measure,sourceDigest:digest,ensureCurrent:()=>{}});
  assert.ok(first.selectedMessageIds.length > 0);
  assert.deepEqual(first.selectedMessageIds,captured.messages.slice(0,first.selectedMessageIds.length).map(m=>m.id));
  assert.ok(first.summaryMeasurement.tokens < 5000);
  for (const source of first.operationalSources) assert.ok(first.savedWorkingState.includes(JSON.stringify(source)));
  const second = await build({captured,previous:first,modelId:'synthetic',measure,sourceDigest:digest,ensureCurrent:()=>{}});
  // Exact prior payload can fill the ceiling. Either a strictly advancing
  // checkpoint or explicit no progress is permitted; identical coverage is not.
  if (second) {
    assert.ok(second.sourceCoverage.length > first.sourceCoverage.length);
    assert.equal(new Set(second.sourceCoverage.map(r=>r.messageId)).size,second.sourceCoverage.length);
  }
  assert.equal(JSON.stringify(captured),original);
});
test('cancellation/owner changes and unavailable tokenization cannot authorize a degraded checkpoint', async () => {
  await assert.rejects(build({captured,modelId:'synthetic',measure,sourceDigest:digest,ensureCurrent:()=>{throw Object.assign(Error('owner changed'),{code:'concurrent-state-change'});}}),{code:'concurrent-state-change'});
  await assert.rejects(build({captured,modelId:'synthetic',measure:async()=>({tokens:1,method:'approximate-full-request'}),sourceDigest:digest,ensureCurrent:()=>{}}),{code:'compaction-summary-tokenizer-unavailable'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(build({captured,modelId:'synthetic',measure,signal:controller.signal,sourceDigest:digest,ensureCurrent:()=>{}}));
});
test('seeded prior coverage and protected tails remain contiguous and monotonic without source mutation', async () => {
 for(let seed=1;seed<=50;seed++) {
   let value=seed;const random=max=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value%max;};
   const count=3+random(25),covered=random(count-1);
   const fixture={...structuredClone(captured),messages:Array.from({length:count},(_,i)=>({id:i+1,role:'assistant',status:i===count-1?'in_progress':'complete',content:`Distinct source ${seed}:${i} `+'detail '.repeat(1+random(70)),execution_steps:'[]'}))};
   const previous={sourceCoverage:fixture.messages.slice(0,covered).map(m=>({messageId:m.id,digest:digest(m)})),savedWorkingState:'Prior exact operational state',evidence:[],operationalSources:[]};
   const before=JSON.stringify(fixture);
   const result=await build({captured:fixture,previous,modelId:'synthetic',measure,sourceDigest:digest,ensureCurrent:()=>{}});
   if(result) {
     assert.ok(result.sourceCoverage.length>covered,`seed=${seed}`);
     assert.deepEqual(result.sourceCoverage.map(r=>r.messageId),fixture.messages.slice(0,result.sourceCoverage.length).map(m=>m.id),`seed=${seed}`);
     assert.ok(!result.sourceCoverage.some(r=>r.messageId===count));
     assert.ok(result.summaryMeasurement.tokens<5000);
     assert.deepEqual(result.plan,fixture.plan);
   }
   assert.equal(JSON.stringify(fixture),before,`seed=${seed}`);
 }
});
