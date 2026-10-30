import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';
const plan = { revision: 1, steps: Array.from({length: 8}, (_, i) => ({description: `Phase ${i+1}`, status: i ? 'pending' : 'in_progress'})) };
const messages = [{role:'system', content:'Original eight-phase requirements: inspect, implement, test, build.\n[WORKSPACE PLAN] 0/8 completed'}, {role:'user', content:'Complete all eight phases. '.repeat(2000)}];
const response = (content, finish_reason = 'stop', tool_calls = undefined) => new Response(JSON.stringify({choices:[{finish_reason, message:{content,tool_calls}}], usage:{prompt_tokens:50000,completion_tokens:20}}), {headers:{'content-type':'application/json'}});
async function run(options={}) {
 const requests=[], incomplete=[], executed=[]; let stats;
 const text=await runMemoryChat({baseUrl:'http://scripted.invalid', modelId:'fixture',projectId:'disposable',messages,
 chatTools:[{type:'function',function:{name:'inspect',parameters:{type:'object'}}}],
 getTaskState:async()=>({plan,userText:'Continue the engineering task'}),
 onTaskIncomplete:x=>incomplete.push(x),onStats:x=>stats=x,
 executeTool:async call=>{executed.push(call);return {success:true};},
 fetchImpl:async(_url,req)=>{requests.push(JSON.parse(req.body));return options.responses?.[requests.length-1] ?? response('Let me implement the remaining fixes.');},
 ...options});
 return {text,requests,incomplete,executed,stats};
}
test('rejected compaction safely rebuilds original requirements and plan; narration receives bounded continuation',async()=>{
 let attempts=0, validations=0;
 const r=await run({rebuildWorkspacePrefix:async()=>messages,
 workspaceCompaction:async({payload,tail,buildRequest})=>{attempts++;return {optionalContinued:true,tail,payload:await buildRequest(null,tail),validateDispatch:async()=>{validations++;}};},
 responses:[response('Let me implement the remaining fixes.'),response('Implemented and verified the requested changes.')]});
 assert.equal(r.requests.length,2);assert.equal(attempts,2);assert.equal(validations,2);
 for(const req of r.requests){assert.match(req.messages[0].content,/Original eight-phase/);assert.match(req.messages[0].content,/0\/8/);assert.ok(req.messages.some(m=>m.content?.includes('Complete all eight phases.')));}
 assert.equal(r.incomplete.length,0);assert.match(r.requests[1].messages.at(-1).content,/Do not replay/);
});
test('repeated non-progress is incomplete after two recovery requests',async()=>{const r=await run();assert.equal(r.requests.length,3);assert.equal(r.incomplete[0].attempts,2);assert.match(r.text,/Task incomplete/);});
test('reasoning-only response with unfinished plan is recovered',async()=>{const r=await run({responses:[response(''),response('Finished; all verification passed.')]});assert.equal(r.requests.length,2);});
for(const answer of ['42.','Implemented the fixes. All tests and build pass.','Cannot proceed without permission.','Which option should I use?']) test(`valid no-tool answer yields: ${answer}`,async()=>{const r=await run({responses:[response(answer)]});assert.equal(r.requests.length,1);assert.equal(r.incomplete.length,0);});
test('user stop overrides unfinished plan',async()=>{const r=await run({getTaskState:async()=>({plan,userText:'Stop now.'})});assert.equal(r.requests.length,1);assert.equal(r.incomplete.length,0);});
test('completed plan does not continue narration',async()=>{const r=await run({getTaskState:async()=>({plan:{steps:plan.steps.map(s=>({...s,status:'completed'}))}})});assert.equal(r.requests.length,1);});
test('permission change forbids recovery and reports incomplete',async()=>{const r=await run({getTaskState:async()=>({plan,canContinue:false})});assert.equal(r.requests.length,1);assert.equal(r.incomplete.length,1);assert.equal(r.incomplete[0].reason,'permission-changed');});
test('truncated text has bounded recovery and recorded finish metadata',async()=>{const r=await run({responses:[response('partial','length'),response('partial','length'),response('partial','length')]});assert.equal(r.requests.length,3);assert.equal(r.stats.raw.at(-1).finishReason,'length');assert.equal(r.incomplete[0].reason,'output-truncated');});
test('safety stop does not trigger recovery',async()=>{const r=await run({responses:[response('Unable to comply.','content_filter')]});assert.equal(r.requests.length,1);});
test('cancelled run does not recover',async()=>{const c=new AbortController();await assert.rejects(run({signal:c.signal,getTaskState:async()=>{c.abort();return {plan};}}),{name:'AbortError'});});
test('deleted session fails closed',async()=>{await assert.rejects(run({getTaskState:async()=>{throw Error('Task session deleted.');}}),/deleted/);});
test('completed tool operations are paired and never replayed',async()=>{const r=await run({responses:[response('', 'tool_calls',[{id:'one',type:'function',function:{name:'inspect',arguments:'{}'}}]),response('Let me implement the fixes.'),response('Verified and finished.')]});assert.equal(r.executed.length,1);assert.equal(r.requests.length,3);assert.equal(r.requests[2].messages.filter(m=>m.role==='tool').length,1);});
test('steering changes task scope and disables stale-plan recovery',async()=>{let reads=0;const r=await run({takeSteeringInstructions:async()=>++reads===1?[{id:'stop',content:'Stop engineering work. Just summarize.'}]:[]});assert.equal(r.requests.length,1);});
test('actual overflow propagates without premature-stop retry',async()=>{let n=0;await assert.rejects(run({workspaceCompaction:async()=>{n++;throw Error('prospective-context-overflow');}}),/overflow/);assert.equal(n,1);});
test('acknowledgments after recovery are non-progress, not successful completion',async()=>{const r=await run({responses:[response('Let me implement the fixes.'),response('Okay.'),response('Okay.')]});assert.equal(r.requests.length,3);assert.equal(r.incomplete[0].reason,'non-progress-response');});
