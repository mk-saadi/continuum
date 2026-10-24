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

test('U6 isolated real Playwright MCP Auto and Manual model-loop transport', async () => {
 const http=require('node:http');
 const {McpManager}=require('../src/main/mcpManager');
 const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
 const rows=[];
 for(const mode of ['auto','manual']) {
  require('../src/main/configManager').saveAppSettings({mcpMode:mode});
  const server=http.createServer((_req,res)=>res.end('<!doctype html><title>U6 disposable page</title><h1>U6 isolated fixture</h1><button>Fixture button</button>'));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+server.address().port;
  const outcomes=[];const f=fixture('full_access');let requests=0,preparations=0,executions=0;
  const m=new McpManager({configPath:path.join(directory,mode+'.json'),lazyByDefault:true,getMcpMode:()=>mode,getNativeServers:()=>({})});
  try {
   await m.saveConfig({mcpServers:{playwright:{command:process.execPath,args:[path.resolve('node_modules/@playwright/mcp/cli.js'),'--headless','--isolated','--sandbox','--executable-path','/opt/google/chrome/chrome','--output-dir',path.join(directory,mode+'-browser')],uiEnabled:mode==='manual'}}});
   m.beginRun(f.id,mode);
   if(mode==='manual') { await m.setServerEnabled('playwright',true); for(const t of m.servers.get('playwright').tools) if(!['browser_navigate','browser_snapshot'].includes(t.name)) await m.setToolEnabled(t.name,false,'playwright'); }
   const ops=[...(mode==='auto'?[['find_and_prepare_mcp_tools',{query:'playwright browser_navigate'}]]:[]),[m.toolName('playwright','browser_navigate'),{url}],...(mode==='auto'?[['find_and_prepare_mcp_tools',{query:'playwright browser_snapshot'}]]:[]),[m.toolName('playwright','browser_snapshot'),{}]];
   const tools=()=>builder.getToolContext(m.getTools(f.id),true,f.id,'full_access','fixture').tools;
   
   await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',messages:payload(f,'full_access','Navigate to the local fixture and inspect its button.').messages,chatTools:tools(),getChatTools:async()=>tools(),
    executeTool:async call=>{
     const args=JSON.parse(call.arguments);
     if(call.name==='find_and_prepare_mcp_tools'){preparations++;try {const result=await m.findAndPrepare(args,f.id);outcomes.push({preparation:result});return result;}catch(error){outcomes.push({preparationError:String(error),schema:m.servers.get('playwright')?.tools.find(t=>t.name==='browser_navigate')?.inputSchema});throw error;}}
     const t=m.resolveTool(call.name,f.id);executions++;
     let out;try {out=await m.callTool(t.serverName,t.toolName,args,{sessionId:f.id,permissionMode:'full_access'});}catch(error){outcomes.push({operation:t.toolName,error:String(error),schema:m.servers.get('playwright')?.tools.find(tool=>tool.name===t.toolName)?.inputSchema});throw error;}
     outcomes.push({operation:t.toolName,result:JSON.parse(out)});return out;
    },
    fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);const op=ops[requests++];if(op)assert.ok(body.tools.some(t=>t.function.name===op[0]));return Response.json({choices:[{message:op?{tool_calls:[{id:mode+'-'+requests,type:'function',function:{name:op[0],arguments:JSON.stringify(op[1])}}]}:{content:'Fixture complete. [TASK COMPLETE]'},finish_reason:op?'tool_calls':'stop'}]});}});
   const performed=outcomes.filter(o=>o.operation);const valid=performed.length===2&&performed.every(o=>o.result&&!o.result.isError)&&JSON.stringify(outcomes).includes('Fixture button');
   rows.push({mode,requests,preparations,executions,realBrowser:true,realModel:false,verified:valid,outcomes});
  } catch(error) {rows.push({mode,requests,preparations,executions,verified:false,error:String(error),outcomes:typeof outcomes==='undefined'?[]:outcomes});}
  finally {m.endRun(f.id,mode);await m.close();await new Promise(resolve=>server.close(resolve));}
 }
 fs.writeFileSync('/tmp/continuum-u6/browser.json',JSON.stringify(rows,null,2));
});
