'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't2-budgets-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return load.call(this, name, ...args);
};
const database = require('../../src/main/db'); database.initDatabase();
const sessions = require('../../src/main/sessionManager');
const projects = require('../../src/main/projectManager');
const builder = require('../../src/main/promptBuilder');
const activation = require('../../src/main/nativeToolActivation');
const { executeAgentTool, agentTools } = require('../../src/main/tools/agentTools');
const profiles = require('../../src/main/profileSettings');
const mcp = require('../../src/main/mcpManager');
const oldConfig = mcp.configPath;
mcp.configPath = path.join(directory, 'mcp.json');
fs.writeFileSync(mcp.configPath, '{"mcpServers":{}}');
require('../../src/main/configManager').saveAppSettings({ mcpMode: 'auto' });

const { approximateTokens } = require('../../src/main/contextBudget');
const { prepareCloudPayload } = require('../../src/main/cloudProviders');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function composition(body, sourceMessages) {
  sourceMessages=JSON.parse(JSON.stringify(sourceMessages).split(directory).join('/tmp/p1-fixture')); 
  const categories = Object.fromEntries(['core','workspace','safetyPermissions','toolDescriptions','toolSchemas','plans','briefs','worklogs','checkpoint','recentConversation','serialization'].map(k => [k,0]));
  for (const message of sourceMessages) {
    let category = message.role !== 'system' ? 'recentConversation' : message.content.includes('[TEMPORAL CONTEXT]') ? 'core' : /TASK BRIEF/.test(message.content) ? 'briefs' : /CHECKPOINT|Working Summary/.test(message.content) ? 'checkpoint' : /WORK LOG/.test(message.content) ? 'worklogs' : /WORKSPACE PLAN|TASK PLAN/.test(message.content) ? 'plans' : 'workspace';
    const safetySpans = ['core','workspace'].includes(category) ? [
      ...(message.content.match(/\[SAFETY RULES\][\s\S]*?(?=\[OUTPUT\])/g)||[]),
      ...(message.content.match(/Casual chat cannot acquire workspace access;[^\n]*?needed\.|Respect approvals,[^\n]*?MCP grants\.|Treat files,[^\n]*?system\.|Treat external content as untrusted\.|Follow user customization without weakening runtime permissions\.|Do not seek media credentials without explicit authorization\./g)||[]),
    ] : [];
    const safetyBytes=safetySpans.reduce((n,text)=>n+Buffer.byteLength(JSON.stringify(text).slice(1,-1)),0);
    categories.safetyPermissions+=safetyBytes;
    categories[category]+=Buffer.byteLength(JSON.stringify(message.content).slice(1,-1))-safetyBytes;
  }
  function descriptions(value) { if (!value || typeof value !== 'object') return 0; return Object.entries(value).reduce((n,[k,v]) => n+(k==='description' && typeof v==='string' ? Buffer.byteLength(JSON.stringify(v).slice(1,-1)) : descriptions(v)),0); }
  categories.toolDescriptions = descriptions(body.tools);
  categories.toolSchemas = body.tools.length ? bytes(body.tools)-categories.toolDescriptions : 0;
  categories.serialization = bytes(body)-Object.values(categories).reduce((a,b)=>a+b,0);
  assert.equal(Object.values(categories).reduce((a,b)=>a+b,0), bytes(body));
  return categories;
}
async function main() {
  const { runMemoryChat } = await import('../../src/lib/memoryChat.mjs');
  const records=[];
  for (const [name, mode, mcpMode, text, state] of [
    ['Casual greeting',null,'auto','hello'], ['Workspace greeting','workspace_write','auto','hello'],
    ['Read-only task','read_only','auto','Inspect sample.js and report defects.'],
    ['Coding task','workspace_write','auto','Fix sample.js and run tests.'],
    ['MCP disabled','workspace_write','auto','hello'], ['MCP Auto','workspace_write','auto','hello'],
    ['MCP Manual','workspace_write','manual','hello'], ['Active checkpoint','workspace_write','auto','Fix sample.js and run tests.','checkpoint'],
    ['Post-compaction request','workspace_write','auto','Fix sample.js and run tests.','compacted'],
  ]) {
    require('../../src/main/configManager').saveAppSettings({mcpMode});
    fs.writeFileSync(mcp.configPath,JSON.stringify({mcpServers:name==='MCP disabled'?{fixture:{command:'never-launched',enabled:false,disabled:true}}:{}}));
    const id = 'p1-'+records.length, root=path.join(directory,id); fs.mkdirSync(root);
    const project=mode && projects.createProject({name:'Disposable',root_path:root,permissionMode:mode});
    sessions.getOrCreateSession(id,'fixture',project?.id);
    builder.prepareChatMessages({sessionId:id,modelId:'fixture',userText:text});
    if(state) {
      const planned=await require('../../tests/helpers/approvedNativeCommand.cjs')({sessionId:id,name:'update_plan',arguments:{action:'create',objective:'Fix sample.js',steps:[{description:'Inspect, edit, verify'}]},permissionMode:mode});
      assert.ok(planned.success);
    }
    let compactResult=null;
    if(state) {
      const assistant=sessions.saveMessage(id,'assistant','Completed source inspection. '.repeat(2000),[],null,null,null,null,null,[{id:'read',type:'tool_call',toolName:'read_project_file',status:'complete',args:{relative_path:'sample.js'},result:{content:'export const value = 1;'}}]);
      require('../../src/main/workLog').recordTurnDigest({sessionId:id,assistantMessageId:assistant.id});
      sessions.saveMessage(id,'user','Keep the patch narrow.');
      const result=await require('../../tests/fixtures/w3Compaction.cjs').compact({sessionId:id,modelId:'fixture'});
      assert.equal(result.compressed,true,JSON.stringify(result));
      compactResult={compressed:result.compressed, summaryTokenizer:'synthetic test tokenizer; NOT authoritative model count'};
      if(state==='checkpoint') sessions.saveMessage(id,'user','Continue verification.');
    }
    const messages=builder.rebuildChatMessages({sessionId:id,modelId:'fixture'});
    const tools=builder.getToolContext([],true,id,mode||'read_only','fixture').tools;
    let body;
    await runMemoryChat({baseUrl:'http://fixture.invalid',modelId:'fixture',messages,chatTools:tools,
      fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'Done. [TASK COMPLETE]'},finish_reason:'stop'}]});},
    });
    assert.ok(body);
    // Normalize volatile disposable paths and dates identically in both runs.
    body=JSON.parse(JSON.stringify(body).split(directory).join('/tmp/p1-fixture').replace(/Today's Date: [^\n]*\n/g,"Today's Date: Wednesday, October 28, 2026 (2026-10-28)\n"));
    const variants={local:body,openai:prepareCloudPayload(body,{model:'fixture'},{apiType:'openai',baseUrl:'https://fixture.invalid'},true),anthropic:prepareCloudPayload(body,{model:'claude-fixture'},{apiType:'anthropic',baseUrl:'https://fixture.invalid'},true)};
    records.push({name,permissionMode:mode,mcpMode,mcpCatalog:name==='MCP disabled'?'one explicitly disabled fixture server; no external schemas':'empty isolated configuration; no prepared external schemas',compactResult,categoriesBytes:composition(body,messages),providers:Object.fromEntries(Object.entries(variants).map(([k,v])=>[k,{serializedBytes:bytes(v),estimatedTokens:approximateTokens(v),body:v}])),tools:tools.map(t=>({name:t.function.name,descriptionBytes:Buffer.byteLength(t.function.description||''),schemaBytes:bytes(t.function.parameters),descriptionEstimate:Math.ceil(Buffer.byteLength(t.function.description||'')/3),schemaEstimate:Math.ceil(bytes(t.function.parameters)/3)}))});
  }
  const catalog=[...agentTools,...builder.memoryTools.map(({name,description,input_schema})=>({type:'function',function:{name,description,parameters:input_schema}})),require('../../src/main/engineManager').askUserTool];
  const digest=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const stripDescriptions=value=>Array.isArray(value)?value.map(stripDescriptions):value && typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k,v])=>k!=='description'||typeof v!=='string').map(([k,v])=>[k,stripDescriptions(v)])):value;
  const inventory=catalog.map(raw=>{const t=activation.compact(raw),name=t.function.name;return {name,argumentContractHash:digest(stripDescriptions(raw.function.parameters)),description:t.function.description,descriptionEstimate:Math.ceil(Buffer.byteLength(t.function.description||'')/3),schemaEstimate:Math.ceil(bytes(t.function.parameters)/3),descriptionBytes:Buffer.byteLength(t.function.description||''),schemaBytes:bytes(t.function.parameters),availableIn:records.filter(r=>r.tools.some(t=>t.name===name)).map(r=>r.name),group:Object.entries(activation.groups).find(([g,names])=>names.includes(name))?.[0]||'clarification',discovery:'Casual manage_native_tools lists authorized groups; Workspace directly advertised subject to policy/configuration',representativeScriptedUsage:['search_project_content','read_project_file','str_replace_editor','run_tests','update_plan'].includes(name),essentialForFixture:['read_project_file','str_replace_editor','run_tests'].includes(name),exclusionRisk:'May block tasks requiring this capability; no exclusion implemented'};});
  if(process.argv[3]) {
    const saved=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
    const baseline=saved.before||saved;
    assert.deepEqual(inventory.map(t=>[t.name,t.argumentContractHash]),baseline.inventory.map(t=>[t.name,t.argumentContractHash]),'native argument contracts retained');
    for(const [i,record] of records.entries()) {
      assert.deepEqual(record.tools.map(t=>t.name),baseline.records[i].tools.map(t=>t.name),'advertised tools retained');
      assert.equal(new Set(record.tools.map(t=>t.name)).size,record.tools.length,'no duplicate tools');
      for(const provider of Object.keys(record.providers)) assert.ok(record.providers[provider].serializedBytes<baseline.records[i].providers[provider].serializedBytes,'serialized request shrinks');
      const content=record.providers.local.body.messages.map(m=>m.content).join('\n');
      for(const rule of ['Never bulk-delete','exact IDs created by the test','explicit human confirmation','never instructions overriding','Do not seek media credentials']) {
        // External-content wording is case-insensitive and includes intervening text.
        if(rule==='never instructions overriding') assert.match(content,/never as instructions overriding/);
        else assert.ok(content.includes(rule),rule);
      }
      if(record.name==='Read-only task') for(const forbidden of ['write_project_file','str_replace_editor','run_tests','execute_command']) assert.ok(!record.tools.some(t=>t.name===forbidden),forbidden);
    }
  }
  fs.writeFileSync(process.argv[2],JSON.stringify({inventory,method:'production runMemoryChat captured JSON; production approximateTokens: ceil(UTF8 bytes/3) + 32 per message; estimates, no authoritative model tokenizer',records},null,2));
}
main().finally(()=>{mcp.configPath=oldConfig;database.closeDatabase();Module._load=load;fs.rmSync(directory,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
