import test from 'node:test';
import assert from 'node:assert/strict';
import { finalAssistantResponse } from '../src/lib/assistantResponse.mjs';
const steps = [{type:'text',content:'Working.',startOffset:0,endOffset:8},{type:'tool_call',toolName:'shell'}];
test('only completed final text is available for copying', () => {
  assert.equal(finalAssistantResponse({content:'Working.Final answer',executionSteps:steps}),'Final answer');
  assert.equal(finalAssistantResponse({content:'Plain answer'}),'Plain answer');
  for (const status of ['in_progress','interrupted','cancelled','error'])
    assert.equal(finalAssistantResponse({status,content:'Working.Partial answer',executionSteps:steps}),'');
  assert.equal(finalAssistantResponse({streaming:true,content:'Working.Live',executionSteps:steps}),'');
  assert.equal(finalAssistantResponse({content:'Working.',executionSteps:steps}),'');
  assert.equal(finalAssistantResponse({content:'Working.\n\n',executionSteps:steps}),'');
  assert.equal(finalAssistantResponse({status:'interrupted',variants:[{content:'partial'}]}),'');
});
test('selected reply owns its text and progress boundaries', () => {
  const message={content:'Stale canonical text',active_variant_index:1,variants:[{content:'first'}, {content:'Working.Chosen final',executionSteps:steps}]};
  assert.equal(finalAssistantResponse(message),'Chosen final');
  assert.equal(finalAssistantResponse({...message,active_variant_index:0}),'first');
  assert.equal(finalAssistantResponse({content:'fallback',variants:['Legacy answer']}),'Legacy answer');
});
