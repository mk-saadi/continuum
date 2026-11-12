import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentMessages } from '../src/lib/subagentTranscript.mjs';
const text = text => ({ text, truncated: false });
test('child transcript maps to task and chronological workspace operations with one final answer', () => {
 const messages = subagentMessages({status:'completed',model:'model',activity:[{type:'thought',turn:1,text:'Inspect the source'}],turns:[
 {role:'user',text:text('Task')},
 {role:'assistant',text:text('Searching now'),toolCalls:[{name:'web_search',arguments:text('{"query":"docs"}')}]},
 {role:'tool',text:text('{"results":["source"]}')},
 {role:'assistant',text:text('**Answer**')},
 ],result:text('**Answer**')}, 'Task', 'child');
 assert.equal(messages[0].content,'Task');
 const run=messages[1];
 assert.deepEqual(run.executionSteps.map(step=>step.type),['thought','text','tool_call']);
 assert.equal(run.executionSteps[2].args.query,'docs');
 assert.equal(run.executionSteps[2].status,'complete');
 assert.equal(run.content,'**Answer**');
});
test('one-shot children display fetched source, thinking, and markdown without committed turns',()=>{
 const run=subagentMessages({status:'completed',activity:[{type:'fetch',url:'https://example.com',chars:100},{type:'thought',text:'Analyze'}],result:text('## Findings')},'Analyze','child')[1];
 assert.deepEqual(run.executionSteps.map(step=>step.type),['tool_call','thought']);
 assert.equal(run.content,'## Findings');
});
test('live output replaces previews at completion and marks shortened display text',()=>{
 const run=subagentMessages({status:'completed',liveProgress:{type:'responding',text:'old'},result:{text:'new',truncated:true}},'Task','child')[1];
 assert.match(run.content,/new\n\[Preview shortened/);
 assert.ok(!run.content.includes('old'));
 assert.equal(run.streaming,false);
});
test('unfinished calls and explicit tool errors stay visible as failures',()=>{
 const run=subagentMessages({status:'failed',turns:[{role:'assistant',toolCalls:[{name:'read_project_file',arguments:text('{}')},{name:'web_search',arguments:text('{}')}]},{role:'tool',text:text('{"error":"Blocked"}')} ]},'Task','child')[1];
 assert.deepEqual(run.executionSteps.map(step=>step.status),['error','error']);
});

test('skipped calls are deferred and plain tool errors are failures rather than green successes', () => {
 const run=subagentMessages({status:'partial',turns:[
  {role:'assistant',toolCalls:[{name:'get_single_web_page_content',arguments:text('{}')},{name:'web_search',arguments:text('{}')}]},
  {role:'tool',text:text('[Tool skipped: no_progress] This requested tool was not executed.')},
  {role:'tool',text:text('Error: Search provider unavailable.')}
 ]},'Task','child')[1];
 assert.deepEqual(run.executionSteps.map(step=>step.status),['deferred','error']);
});
