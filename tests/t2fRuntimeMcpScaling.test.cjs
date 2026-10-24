'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't2-budgets-'));
const load = Module._load, originalHome = os.homedir;
os.homedir = () => directory;
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
const { McpManager } = require('../src/main/mcpManager');
const { createHash } = require('node:crypto');
const { approximateTokens, createRuntimeBudget } = require('../src/main/contextBudget');
const results = { method: 'actual transport JSON characters / 4; estimate, not tokenizer count', scaling: [], loops: [], largeServer: {}, exactTokenizerTokens: null };
const bytes = v => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
results.discoveryInterface = { initial: 'manage_native_tools mcp group', deferredSchemaBytes: bytes(agentTools.find(t => t.function.name === 'manage_mcp_servers')), schemasInitiallyExposed: 0 };
const tool = i => ({name:'read_issue_'+i,description:'Read mock issue details '+i,inputSchema:{type:'object',properties:{issue:{type:'string'}}}});
test.after(()=>{
  if(process.env.T2F_EVIDENCE_PATH)fs.writeFileSync(process.env.T2F_EVIDENCE_PATH,JSON.stringify(results,null,2));
  mcp.configPath=oldConfig;database.closeDatabase();Module._load=load;os.homedir=originalHome;fs.rmSync(directory,{recursive:true,force:true});
});
async function managerFixture(count, per, makeTool = tool) {
  let launches=0, calls=[];
  const manager=new McpManager({configPath:path.join(directory,randomUUID()+'.json'),lazyByDefault:true,createConnection:async()=>{
    launches++;return {setNotificationHandler(){},listTools:async()=>({tools:Array.from({length:per},(_,i)=>makeTool(i))}),
      close:async()=>{},callTool:async call=>{calls.push(call.name);return {content:[{type:'text',text:'Mock issue: component returns null; render its title.'}]};}};
  }});
  await manager.saveConfig({mcpServers:Object.fromEntries(Array.from({length:count},(_,i)=>['server-'+String(i).padStart(3,'0'),{command:'never-launched',description:i===count-1?'GitHub project issues':'Calendar integration'}]))});
  for(const server of manager.servers.values())server.tools=Array.from({length:per},(_,i)=>makeTool(i));
  return {manager,launches:()=>launches,calls};
}
async function providerTransport(provider, respond) {
  if(provider==='local')return respond;
  const cp=require('../src/main/cloudProviders');
  cp.saveCloudProvider({id:provider,name:provider,apiType:provider==='anthropic'?'anthropic':'openai',baseUrl:provider==='anthropic'?'https://api.anthropic.com/v1':'https://openrouter.ai/api/v1',apiKey:'disposable-fake-key'});
  return cp.createCloudFetch({type:'cloud',provider,model:provider==='anthropic'?'claude-fixture':'fixture'},{stream:false,fetchImpl:respond});
}
async function capture(p,provider='local') {
  let body;const fetchImpl=await providerTransport(provider,async(_url,o)=>{
    body=JSON.parse(o.body);return provider==='anthropic'?Response.json({content:[{type:'text',text:'hello'}],stop_reason:'end_turn'}):Response.json({choices:[{message:{content:'hello [TASK COMPLETE]'},finish_reason:'stop'}]});});
  const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
  await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',cloud:provider!=='local',messages:p.messages,chatTools:p.tools,fetchImpl});return body;
}
function measure(body) {
  const schemas=body.tools||[],mcpSchemas=schemas.filter(t=>(t.function?.name||t.name).startsWith('mcp_'));
  return {requestBytes:bytes(body),requestCharacters:JSON.stringify(body).length,estimatedInputTokens:estimate(body),
    c1ApproximateInputTokens:approximateTokens(body),exactTokenizerTokens:null,requestFingerprint:hash(body),
    nativeSchemaBytes:bytes(schemas.filter(t=>!(t.function?.name||t.name).startsWith('mcp_'))),
    activatedSchemaBytes:bytes(mcpSchemas),activatedSchemaCount:mcpSchemas.length,
    discoverySchemaBytes:bytes(schemas.filter(t=>(t.function?.name||t.name)==='manage_mcp_servers')),
    injectedServerMetadataBytes:0};
}
test('Gate D: actual fresh requests stay constant for 0–100 servers / 0–10,000 tools',async()=>{
  for(const [count,per] of [[0,0],[5,10],[20,20],[50,20],[100,20],[100,100]]) {
    const heap=process.memoryUsage().heapUsed,start=performance.now(),f=await managerFixture(count,per),manager=f.manager;
    const original=mcp.configPath;mcp.configPath=manager.configPath;
    try {
      const row={serverCount:count,toolsPerServer:per,totalTools:count*per,registryMetadataBytes:bytes([...manager.servers.values()].map(s=>({name:s.name,description:s.definition.description,tools:s.tools}))),initial:[]};
      const searchStart=performance.now(),found=manager.searchCapabilities({query:'GitHub',limit:5});
      row.searchLatencyMs=performance.now()-searchStart;row.searchResultCount=found.results.length;row.searchResultBytes=bytes(found);
      if(count)assert.equal(found.results[0].serverId,'server-'+String(count-1).padStart(3,'0'));
      assert.equal(f.launches(),0);
      for(const mode of [null,'full_access']) {
        const session=fixture(mode),p=payload(session,mode||'read_only');
        for(const provider of ['local','anthropic','openrouter']) {
          const body=await capture(p,provider),measured=measure(body);
          assert.ok(measured.estimatedInputTokens<=(mode?11000:2000));
          assert.ok(!JSON.stringify(body).includes('Calendar integration'));assert.ok(!JSON.stringify(body).includes('server-099'));
          assert.equal(measured.activatedSchemaCount,0);row.initial.push({chatMode:mode?'workspace':'casual',provider,...measured});
        }
        if(mode&&count){manager.beginRun(session.id,'scaling');const t=performance.now();
          await manager.activateTools('server-'+String(count-1).padStart(3,'0'),['read_issue_0','read_issue_1'],session.id);
          row.activationLatencyMs=performance.now()-t;
          const tools=builder.getToolContext(manager.getTools(session.id),true,session.id,'full_access','fixture').tools;
          row.postActivation=measure(await capture({...p,tools}));assert.equal(row.postActivation.activatedSchemaCount,2);manager.endRun(session.id,'scaling');}
      }
      row.heapDeltaBytes=process.memoryUsage().heapUsed-heap;row.fixtureElapsedMs=performance.now()-start;results.scaling.push(row);
    } finally {mcp.configPath=original;await manager.close();}
  }
  for(const mode of ['casual','workspace'])for(const provider of ['local','anthropic','openrouter']){
    const samples=results.scaling.map(r=>r.initial.find(v=>v.chatMode===mode&&v.provider===provider).estimatedInputTokens);
    assert.equal(new Set(samples).size,1,mode+' '+provider);
  }
});
test('150 tools: legacy activation retained, selective schemas cost only two tools',async()=>{
  const f=await managerFixture(1,150,i=>({name:'read_record_'+i,description:'Inspect a disposable mock record',inputSchema:{type:'object',properties:{id:{type:'string'}}}})),m=f.manager,s=fixture('full_access');
  try {
    await m.manageServers('enable',['server-000'],'legacy');const legacy=m.getTools('legacy');assert.equal(legacy.length,150);
    m.beginRun(s.id,'large');await m.activateTools('server-000',['read_record_2','read_record_149'],s.id);
    const selected=m.getTools(s.id);assert.equal(selected.length,2);
    const p=payload(s,'full_access');results.largeServer={availableTools:150,legacy:measure(await capture({...p,tools:builder.getToolContext(legacy,true,s.id,'full_access','fixture').tools})),selected:measure(await capture({...p,tools:builder.getToolContext(selected,true,s.id,'full_access','fixture').tools}))};
    assert.ok(results.largeServer.selected.activatedSchemaBytes<results.largeServer.legacy.activatedSchemaBytes/30);
  } finally {await m.close();}
});
test('Gate C: real loop discovers, selects and dispatches with native tools across all adapters and recovery',async()=>{
  const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
  for(const provider of ['local','anthropic','openrouter']) {
    const f=await managerFixture(100,150),m=f.manager,s=fixture('full_access'),runId=randomUUID();
    const original=mcp.configPath,methods=['searchCapabilities','activateTools','manageServers','findAndPrepare'],saved=Object.fromEntries(methods.map(k=>[k,mcp[k]]));
    mcp.configPath=m.configPath;for(const k of methods)mcp[k]=m[k].bind(m);
    activation.begin(s.id,runId);m.beginRun(s.id,runId);
    const context=require('../src/main/lspExecutionContext').createContext(s.id,'full_access',runId);
    fs.writeFileSync(path.join(s.root,'App.jsx'),'export default () => null;');
    const selected=['read_issue_1','read_issue_149'];const name=i=>m.toolName('server-099','read_issue_'+i);
    const ops=[
      [['find_and_prepare_mcp_tools',{query:'server-099 read_issue_149'}]],
      [[name(149),{}]],
      [['search_project_content',{query:'null'}]],
      [['read_project_file',{relative_path:'App.jsx'}]],
      [['find_and_prepare_mcp_tools',{query:'server-099 read_issue_3'}]],
      [[name(3),{}]],
    ];
    let requests=0,executed=0,recovered=0,steered=0;const measurements=[],outcomes=[];
    const getTools=()=>builder.getToolContext(m.getTools(s.id),true,s.id,'full_access','fixture').tools;
    const respond=async(_url,o)=>{
      const body=JSON.parse(o.body),index=requests++,names=body.tools.map(t=>t.function?.name||t.name);
      measurements.push(measure(body));assert.equal(new Set(names).size,names.length);
      const prior=ops.slice(0,index).flatMap((batch,i)=>batch.map((_,j)=>'call-'+i+'-'+j));
      const actual=provider==='anthropic'?body.messages.flatMap(msg=>Array.isArray(msg.content)?msg.content.filter(c=>c.type==='tool_result').map(c=>c.tool_use_id):[]):body.messages.filter(msg=>msg.role==='tool').map(msg=>msg.tool_call_id);
      assert.deepEqual(actual,prior);
      if(index===0)assert.equal(names.filter(n=>n.startsWith('mcp_')).length,0);
      if(index>=1&&index<=4)assert.equal(names.filter(n=>n.startsWith('mcp_')).length,1);
      if(index>=5)assert.equal(names.filter(n=>n.startsWith('mcp_')).length,2);
      const batch=ops[index];if(batch)for(const [n]of batch)assert.ok(names.includes(n),n);
      if(provider==='anthropic')return Response.json({content:batch?batch.map(([name,input],j)=>({type:'tool_use',id:'call-'+index+'-'+j,name,input})):[{type:'text',text:'Render the component title. No files modified. [TASK COMPLETE]'}],stop_reason:batch?'tool_use':'end_turn'});
      return Response.json({choices:[{message:batch?{tool_calls:batch.map(([name,args],j)=>({id:'call-'+index+'-'+j,type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{content:'Render the component title. No files modified. [TASK COMPLETE]'},finish_reason:batch?'tool_calls':'stop'}]});
    };
    const transport=await providerTransport(provider,respond);
    const fetchImpl=async(url,options)=>{
      if(provider==='local'&&requests===3&&!recovered){const rebuilt=await options.contextRecovery({contextWindowLimit:32768});assert.ok(rebuilt);recovered++;}
      return transport(url,options);
    };
    try {
      await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',cloud:provider!=='local',messages:payload(s,'full_access','Find an issue related to this project, inspect the relevant source files, and explain the likely fix. Do not modify files.').messages,
        chatTools:getTools(),getChatTools:async()=>getTools(),fetchImpl,
        takeSteeringInstructions:async()=>requests===2?[{id:'steer',content:'Keep this read only.'}]:[],markSteeringDelivered:async()=>{steered++;},
        recoverContext:async()=>({messages:builder.rebuildChatMessages({sessionId:s.id,modelId:'fixture'})}),
        resolveTool:n=>n.startsWith('mcp_')?m.resolveTool(n,s.id):{serverName:'native',toolName:n},
        executeTool:async(call,request)=>{
          executed++;assert.equal(context.runId,runId);let result;
          if(call.name.startsWith('mcp_')){const t=m.resolveTool(call.name,s.id);result=await m.callTool(t.serverName,t.toolName,JSON.parse(call.arguments),{sessionId:s.id,permissionMode:'full_access'});}
          else result=await executeAgentTool({...call,sessionId:s.id,permissionMode:'full_access',executionContext:context,
            validateMcpActivation:async schemas=>{const p={...request,tools:builder.getToolContext(schemas,true,s.id,'full_access','fixture').tools},tokens=approximateTokens(p),budgetContract=createRuntimeBudget({runtimeContextTokens:32768,payload:p,currentInputTokens:tokens});return {tokens,budget:budgetContract.usableInputTokens,budgetContract,method:'approximate-full-request'};}});
          assert.ok(!result?.error,JSON.stringify(result));outcomes.push(call.name);return result;
        }});
      assert.equal(executed,6);assert.equal(requests,7);assert.equal(f.calls.length,2);assert.equal(steered,1);
      assert.equal(fs.readFileSync(path.join(s.root,'App.jsx'),'utf8'),'export default () => null;');assert.equal(m.getTools('other').length,0);
      // A grant is never execution authorization; live downgrade blocks dispatch.
      await require('../src/main/lspExecutionContext').setMode(s.id,'read_only');
      assert.ok(!getTools().some(t=>t.function.name.startsWith('mcp_')));
      await assert.rejects(m.callTool('server-099','read_issue_149',{}, {sessionId:s.id,permissionMode:'read_only'}),/blocked|denied/i);
      assert.ok(!require('../src/main/subagents/agentLoop').CHILD_TOOL_NAMES.includes('manage_mcp_servers'));
      results.loops.push({provider,runIdStable:true,requests,executed,mcpCalls:f.calls.length,steeringDelivered:steered,recoveryCallbacks:recovered,toolResultOrderVerified:true,isolated:true,measurements,totalEstimatedInputTokens:measurements.reduce((n,r)=>n+r.estimatedInputTokens,0)});
    } finally {for(const k of methods)mcp[k]=saved[k];mcp.configPath=original;activation.end(s.id,runId);m.endRun(s.id,runId);await m.close();}
  }
});
