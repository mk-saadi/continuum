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

test('U6 serialized request scenarios A through G (not token-prefix/cache proof)',async()=>{
 const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
 const {createHash}=require('node:crypto');const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const f=fixture('full_access'),other=fixture('full_access');
 const initial=payload(f,'full_access','Inspect fixture.');
 const external={type:'function',function:{name:'mcp_fixture_read',description:'Read fixture',parameters:{type:'object',properties:{}}}};
 const continuation=[...initial.messages,{role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'read_project_file',arguments:'{"relative_path":"fixture.txt"}'}}]},{role:'tool',tool_call_id:'fixture-call',content:'fixture result'}];
 const rows=[];let previous=null;
 for(const [scenario,messages,tools] of [
  ['A1 repeated native',initial.messages,initial.tools],['A2 repeated native',initial.messages,initial.tools],
  ['B native continuation',continuation,initial.tools],['C MCP added',continuation,[...initial.tools,external]],
  ['D repeated MCP',continuation,[...initial.tools,external]],
  ['E permission downgrade',initial.messages,builder.getToolContext([],true,f.id,'read_only','fixture').tools],
  ['F session switch',payload(other,'full_access','Independent request.').messages,initial.tools],
  ['G recovery reconstruction',builder.rebuildChatMessages({sessionId:f.id,modelId:'fixture'}),initial.tools]]) {
  await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',messages,chatTools:tools,fetchImpl:async(_url,options)=>{
   const body=JSON.parse(options.body),serialized=JSON.stringify(body);let prefix=0;
   if(previous)while(prefix<previous.length&&prefix<serialized.length&&previous[prefix]===serialized[prefix])prefix++;
   rows.push({scenario,...measureRequest(body,previous?JSON.stringify(JSON.parse(previous).tools):null),bodyHash:digest(body),toolsHash:digest(body.tools),systemHash:digest(body.messages.filter(m=>m.role==='system')),commonSerializedPrefixCharacters:previous===null?null:prefix,formattedTokenPrefix:null,kvMetrics:null});previous=serialized;
   return Response.json({choices:[{message:{content:'Done. [TASK COMPLETE]'},finish_reason:'stop'}]});}});
 }
 assert.equal(rows[0].bodyHash,rows[1].bodyHash);assert.equal(rows[3].bodyHash,rows[4].bodyHash);
 fs.writeFileSync('/tmp/continuum-u6/prefix.json',JSON.stringify(rows,null,2));
});
