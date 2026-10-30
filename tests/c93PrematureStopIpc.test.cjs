'use strict';

// Phase 2.1 — steering IPC ownership and run lifecycle.
//
// Starts a real `engine:chat` run against a deterministic fetch mock, then
// exercises the registered steering handlers. No inference call is made. The
// first model request is held open so an instruction can be submitted while the
// run is genuinely executing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c93-ipc-'));
const originalLoad = Module._load;
const handlers = new Map();
let fetchMock;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      app: { isReady: () => true, getPath: () => directory },
      Notification: { isSupported: () => false },
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
    };
  }
  if (name === './localEngineFetch') {
    return { localEngineFetch: (...params) => fetchMock(...params) };
  }
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');

function response(content) {
  return Response.json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}
function senderFixture() {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, value) => sender.sent.push({ channel, value });
  return sender;
}
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
};

let dispose;
test.before(() => {
  initDatabase(directory);
  sessions.getOrCreateSession('steering-ipc', 'model');
});
test.after(() => {
  dispose?.();
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});


test('C9.3 IPC persists incomplete status and emits interrupted outcome, while valid finals complete', async () => {
 const mcp = require('../src/main/mcpManager');
 mcp.init = mcp.reload = mcp.load = async () => {}; mcp.getTools = () => [];
 const compaction = require('../src/main/workspaceCompaction');
 const original = compaction.compactAtBoundary; compaction.compactAtBoundary = async () => ({compressed:false});
 dispose = require('../src/main/ipcHandlers').registerIpcHandlers({isTrustedSender:()=>true,
 getEngineConfig:()=>({port:12345,modelPath:'model',activeModelConfig:{contextLength:65536}}),beginEngineRequest:()=>()=>{}});
 try {
 const project=require('../src/main/projectManager').createProject({name:'C93 disposable',root_path:directory});
 for (const mode of ['progress','final','new-question']) {
 const final=mode==='final', shouldRecover=mode==='progress';
 const id='c93-'+mode; sessions.getOrCreateSession(id,'model',project.id);
 require('../src/main/workspacePlan').updatePlan(id,{action:'create',objective:'Implement and verify eight phases',steps:Array.from({length:8},(_,i)=>({description:'Phase '+i}))});
 let count=0; fetchMock=async()=>{count++;return response(final?'Implemented and verified.':'Let me implement the remaining fixes.');};
 const owner=senderFixture();
 const result=await handlers.get('engine:chat')({sender:owner},{requestId:id,modelId:'model',sessionId:id,permissionMode:'read_only',messages:[{role:'user',content:mode==='new-question'?'What is this project?':'Continue all eight phases.'}]});
 assert.equal(count,shouldRecover?3:1);
 assert.equal(result.message.status,shouldRecover?'interrupted':'completed');
 assert.equal(sessions.loadSession(id).messages.at(-1).status,shouldRecover?'interrupted':'completed');
 const event=owner.sent.find(x=>x.value.type==='task-outcome').value;
 assert.equal(event.outcome,shouldRecover?'interrupted':'completed');
 if(shouldRecover) {assert.equal(event.incompleteTask.attempts,2);assert.match(result.text,/Task incomplete/);}
 }
 } finally {compaction.compactAtBoundary=original;}
});
