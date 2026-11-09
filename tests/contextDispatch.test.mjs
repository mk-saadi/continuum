import test from 'node:test';
import {createRequire} from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const require = createRequire(import.meta.url), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'context-dispatch-'));
const originalLoad = Module._load;
Module._load = function(name,...args){if(name==='electron')return {app:{isReady:()=>true,getPath:()=>directory}};return originalLoad.call(this,name,...args);};
const storage = require('../src/main/db'); storage.initDatabase(directory);
test.after(()=>{storage.closeDatabase();Module._load=originalLoad;fs.rmSync(directory,{recursive:true,force:true});});
const core = require('../src/main/conversationCompaction'), budgets = require('../src/main/contextBudget');
// In-memory test adapter: production persistence/transport is covered by the main suites.
function boundaryAdapter(b,onForced=()=>{}) {
 const owner={}, measure=budgets.createPromptMeasurer(b.fetch); let summary='';
 return async boundary=>{
  if(!boundary.force)return {compressed:false};
  onForced();
  const result=await core.compact({owner,payload:{...boundary.payload,messages:boundary.conversationMessages},oldSummary:summary,force:true,
   measure:payload=>measure('http://localhost/v1/chat/completions',payload,{contextWindowLimit:8192}),
   generate:async()=>({choices:[{finish_reason:'stop',message:{content:'updated summary and skill; keep the task objective'}}]}),save:async candidate=>{summary=candidate.summary;}});
  if(result.compressed){result.history=result.payload.messages;result.payload=boundary.preparePayload(result.payload);}return result;
 };
}
const older=()=>Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:'Earlier history '+i+' '+'.'.repeat(1000)}));

import assert from 'node:assert/strict';
import { runMemoryChat } from '../src/lib/memoryChat.mjs';
import fixture from './fixtures/contextBackend.cjs';
import child from '../src/main/subagents/agentLoop.js';
import local from '../src/main/subagents/providers/localProvider.js';
const { backend, overflow } = fixture;
const reply = content => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const toolReply = () => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
const tool = description => [{ type: 'function', function: { name: 'read', description, parameters: { type: 'object' } } }];
const base = { baseUrl: 'http://localhost', modelId: 'loaded', loadedContextSize: 8192,
  messages: [{ role: 'system', content: 'old instructions' }, { role: 'user', content: 'current attached text' }], chatTools: tool('read') };

test('tool-loop additions and refreshed schemas are guarded before the second completion', async () => {
  let schemas = 0, recovery = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: toolReply });
  await assert.rejects(runMemoryChat({ ...base, fetchImpl: b.fetch,
    getChatTools: () => tool(++schemas === 1 ? 'read' : 'x'.repeat(30000)),
    executeTool: async () => 'y'.repeat(18000),
    compactContext: async boundary => { if(boundary.force)recovery++; return {compressed:false}; },
  }), /cannot fit/);
  assert.equal(b.calls.length, 1); assert.equal(recovery, 1);
});
test('recovery refreshes RAG/settings/tools and preserves live tool pairs without re-executing tools', async () => {
  let executions = 0, retrievals = 0, schemaReads = 0;
  const b = backend({ tokens:text=>Math.ceil(text.length/4), infer: (_payload, n) => n === 1 ? toolReply() : n === 2 ? overflow() : reply('Done [TASK COMPLETE]') });
  const result = await runMemoryChat({ ...base, messages:[base.messages[0],...older(),base.messages[1]], fetchImpl: b.fetch,
    getChatTools: () => tool(`fresh schema ${++schemaReads}`),
    getSamplingParams: () => ({ temperature: schemaReads > 2 ? 0.2 : 0.7 }),
    retrieveDocuments: async () => [{ file_name: 'notes', chunk_index: 0, chunk_text: `retrieved ${++retrievals}` }],
    executeTool: async () => { executions++; return 'tool result retained'; },
    compactContext: boundaryAdapter(b),
  });
  assert.equal(result, 'Done [TASK COMPLETE]'); assert.equal(executions, 1); assert.equal(b.calls.length, 3);
  const retried = b.calls[2]; assert.match(retried.messages[0].content, /updated summary and skill/); assert.match(retried.messages[0].content, /retrieved 1/);
  assert.equal(retried.temperature, 0.2); assert.match(retried.tools[0].function.description, /fresh schema 3/);
  const call = retried.messages.find(m => m.tool_calls)?.tool_calls[0];
  const resultMessage = retried.messages.find(m => m.role === 'tool');
  assert.equal(call.id, resultMessage.tool_call_id); assert.equal(resultMessage.content, 'tool result retained');
});
let childSerial=0;
function childSession() {
  const context = [{ role: 'system', content: 'Child instructions' }, { role: 'user', content: 'Original task' }];
  for (let i = 0; i < 8; i++) context.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_project_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: `Original result ${i} ${'.'.repeat(1800)}` }, { role: 'user', content: `Continue ${i}` });
  return { id:'context-dispatch-child-'+(++childSerial), context, inputSummary:{task:'Original task'}, activity:[] };
}
test('child investigation compacts under pressure, preserves raw originals and paired protected rounds', async () => {
  const session = childSession(); const originals = structuredClone(session.context); let attempts = 0, summaries = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: payload => {
    if (payload.messages[0].content.startsWith(core.PROMPT)) { summaries++; return reply('faithful child summary'); }
    attempts++; return reply('Child final answer');
  } });
  const result = await child.runInvestigationExecution({ session, engine: { provider: 'local', port: 9999, modelId: 'loaded', contextLength: 8192 }, fetchImpl: b.fetch });
  assert.equal(result.output, 'Child final answer'); assert.equal(attempts, 1); assert.equal(summaries, 1);
  assert.equal(session.compactionState.version, 1);
  assert.deepEqual(session.rawContext.slice(0, originals.length).map(({id, ...message}) => message), originals);
  const retainedCalls = session.context.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id));
  assert.deepEqual(session.context.filter(m => m.role === 'tool').map(m => m.tool_call_id), retainedCalls);
});
test('child overflow with only protected rounds stops; one-shot task has no recovery retry', async () => {
  const session = childSession(); let attempts = 0, summaries = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: payload => {
    if (payload.messages[0].content.startsWith(core.PROMPT)) { summaries++; return reply('child summary'); }
    attempts++; return overflow();
  } });
  const result = await child.runInvestigationExecution({ session, engine: { port: 9999, modelId: 'loaded', contextLength: 8192 }, fetchImpl: b.fetch });
  assert.equal(result.stopReason, 'context_exhausted'); assert.equal(result.outcome, 'partial');
  assert.ok(attempts >= 1 && attempts <= 2); assert.ok(summaries >= 1);
  const one = backend({ infer: overflow });
  await assert.rejects(local.chatCompletion({ engine: { port: 9999, modelId: 'loaded', contextLength: 8192 }, payload: { model: 'loaded', messages: [{ role: 'system', content: 'required instructions' }, { role: 'user', content: 'required file/task' }], max_tokens: 1024 }, fetchImpl: one.fetch }), /cannot fit/);
  assert.equal(one.calls.length, 1);
});

test('high-context steering is counted, retained once through guarded recovery, and delivered at the checkpoint', async () => {
  let claimed = false, recoveries = 0, delivered = 0, executions = 0;
  const b = backend({ tokens: text => Math.ceil(text.length / 4), infer: (_payload, n) => n === 1 ? toolReply() : reply('Done [TASK COMPLETE]') });
  const result = await runMemoryChat({ ...base,
    messages: [{role:'system',content:'Current rules'}, ...older().map(m=>({...m,content:m.content+'x'.repeat(1200)})), {role:'user',content:'Keep the task objective.'}],
    fetchImpl: b.fetch,
    takeSteeringInstructions: async () => {
      if (!executions || claimed) return [];
      claimed = true;
      return [{ id: 'steer-high', deliveryRequestId: 'checkpoint-high', content: 'Use these latest constraints. ' + 's'.repeat(12000) }];
    },
    markSteeringDelivered: async ids => { assert.deepEqual(ids, ['steer-high']); delivered++; },
    executeTool: async () => { executions++; return 'Successful operation already completed'; },
    compactContext: boundaryAdapter(b,()=>{recoveries++;}),
  });
  assert.equal(result, 'Done [TASK COMPLETE]');
  assert.equal(recoveries, 1); assert.equal(executions, 1); assert.equal(delivered, 1);
  assert.equal(b.calls.length, 2);
  assert.equal(b.calls[1].messages.filter(m => String(m.content).includes('Use these latest constraints.')).length, 1);
  assert.equal(b.calls[1].messages.find(m => m.role === 'tool').tool_call_id, 'read-1');
});
