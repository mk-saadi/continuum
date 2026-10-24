'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { measureRequest } = require('./u6-request-cost.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't2-budgets-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase();
const sessions = require('../src/main/sessionManager');
const projects = require('../src/main/projectManager');
const builder = require('../src/main/promptBuilder');
const activation = require('../src/main/nativeToolActivation');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const profiles = require('../src/main/profileSettings');
const mcp = require('../src/main/mcpManager');
const oldConfig = mcp.configPath;
mcp.configPath = path.join(directory, 'mcp.json');
fs.writeFileSync(mcp.configPath, '{"mcpServers":{}}');
require('../src/main/configManager').saveAppSettings({ mcpMode: 'auto' });
const estimate = value => value.length === 0 ? 0 : Math.ceil(JSON.stringify(value).length / 4);
const evidence = [];
function fixture(mode = null) {
  const id = randomUUID();
  const root = path.join(directory, id); fs.mkdirSync(root);
  const project = mode && projects.createProject({ name: 'Disposable', root_path: root, permissionMode: mode });
  sessions.getOrCreateSession(id, 'fixture', project?.id);
  return { id, root, project };
}
function payload(f, mode = 'read_only', text = 'hello') {
  const messages = builder.prepareChatMessages({ sessionId: f.id, modelId: 'fixture', userText: text });
  const tools = builder.getToolContext([], true, f.id, mode, 'fixture').tools;
  return { model: 'fixture', messages, tools, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, cache_prompt: true, temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1 };
}
test.after(() => {
  if (process.env.UNIFIED_EVIDENCE_PATH) fs.writeFileSync(process.env.UNIFIED_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  mcp.configPath = oldConfig; database.closeDatabase(); Module._load = load;
  fs.rmSync(directory, { recursive: true, force: true });
});

function loadSnapshot(file, snapshot) {
 const module = new Module(file); module.filename=file;module.paths=Module._nodeModulePaths(path.dirname(file));
 module._compile(fs.readFileSync(snapshot,'utf8'),file);return module.exports;
}
const snapshotRoot=process.env.U6_SNAPSHOT_ROOT || '/tmp/continuum-unified';
const oldAgent=loadSnapshot(path.resolve(__dirname,'..')+'/src/main/tools/agentTools.js',path.join(snapshotRoot,'agentTools.js'));
const savedLoad=Module._load;
Module._load=function(name,...args){if(name==='./tools/agentTools')return oldAgent;return savedLoad.call(this,name,...args);};
const oldBuilder=loadSnapshot(path.resolve(__dirname,'..')+'/src/main/promptBuilder.js',path.join(snapshotRoot,'promptBuilder.js'));
Module._load=savedLoad;
test('fresh before/after equivalent disposable coding workload',async()=>{
 const {runMemoryChat}=await import(path.resolve(__dirname,'..')+'/src/lib/memoryChat.mjs');
 const metrics=[];
 for(const variant of ['baseline','direct']) {
  const b=variant==='baseline'?oldBuilder:builder, executor=variant==='baseline'?oldAgent.executeAgentTool:executeAgentTool;
  const f=fixture('full_access');activation.begin(f.id,variant);fs.writeFileSync(path.join(f.root,'App.jsx'),'export const title = "Settings";');
  const operations=[...(variant==='baseline'?[['manage_native_tools',{action:'list'}],['manage_native_tools',{action:'activate',groups:['files']}]]:[]),
    ['search_project_content',{query:'Settings'}],['read_project_file',{relative_path:'App.jsx'}],
    ...(variant==='baseline'?[['manage_native_tools',{action:'activate',groups:['editing']}]]:[]),
    ['str_replace_editor',{relative_path:'App.jsx',old_str:'export const title = "Settings";',new_str:'export const title = "Preferences";'}],
    ...(variant==='baseline'?[['manage_native_tools',{action:'activate',groups:['commands']}]]:[]),
    ['run_tests',{command:JSON.stringify(process.execPath)+` -e 'require("node:assert/strict").match(require("node:fs").readFileSync("App.jsx","utf8"), /Preferences/)'`}]];
  let requests=0,cumulative=0;const profiles=[];let previousTools=null;const getTools=()=>b.getToolContext([],true,f.id,'full_access','fixture').tools;
  const started=performance.now();
  const benchmarkLoader=Module._load;
  if(variant==='baseline') Module._load=function(name,parent,...rest){if(name==='../promptBuilder'&&parent?.filename.endsWith('/tools/agentTools.js'))return oldBuilder;return benchmarkLoader.call(this,name,parent,...rest);};
  await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',messages:b.prepareChatMessages({sessionId:f.id,modelId:'fixture',userText:'Find Settings, inspect its source, change it to Preferences and verify the edit.'}),chatTools:getTools(),getChatTools:async()=>getTools(),
   executeTool:async call=>{const result=await executor({...call,sessionId:f.id,permissionMode:'full_access'});assert.ok(!result.error,JSON.stringify(result));return result;},
   fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body),tokens=estimate(body);cumulative+=tokens;profiles.push({request:profiles.length+1,provider:'local',model:body.model,runId:variant,...measureRequest(body,previousTools)});previousTools=JSON.stringify(body.tools);const op=operations[requests++];if(op)assert.ok(body.tools.some(t=>t.function.name===op[0]),variant+' '+op[0]+' '+body.tools.map(t=>t.function.name).join(','));
    return Response.json({choices:[{message:op?{tool_calls:[{id:'b-'+requests,type:'function',function:{name:op[0],arguments:JSON.stringify(op[1])}}]}:{content:'Verified. [TASK COMPLETE]'},finish_reason:op?'tool_calls':'stop'}]});}});
  Module._load=benchmarkLoader;
  assert.match(fs.readFileSync(path.join(f.root,'App.jsx'),'utf8'),/Preferences/);
  metrics.push({variant,requests,preparations:variant==='baseline'?4:0,executions:4,cumulativeEstimatedInputTokens:cumulative,profiles,fixtureElapsedMs:performance.now()-started,realModel:false});activation.end(f.id,variant);
 }
 const full=tools=>[...tools,...builder.memoryTools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.input_schema}})),require(path.resolve(__dirname,'..')+'/src/main/engineManager').askUserTool];
 const original=full(oldAgent.agentTools),after=full(agentTools).map(activation.compact);
 fs.writeFileSync(process.env.U6_COST_PATH || '/tmp/continuum-u6/cost.json',JSON.stringify({method:'serialized JSON characters/4; mocked model, real disposable file/edit/test execution',catalog:{beforeTools:original.length,beforeEstimatedTokens:estimate(original),afterTools:after.length,afterEstimatedTokens:estimate(after),largest:after.map(t=>({name:t.function.name,tokens:estimate([t])})).sort((a,b)=>b.tokens-a.tokens).slice(0,10)},metrics},null,2));
});
