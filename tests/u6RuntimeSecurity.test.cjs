'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEffect, requiresOutboundApproval } = require('../src/main/mcpPermissionPolicy');
const { guardTool } = require('../src/main/toolPermissions');
const { createManifestStore } = require('../src/main/advertisedTools');
const { McpManager } = require('../src/main/mcpManager');

test('U6 opaque and unknown MCP capabilities cannot inherit autonomous Full Access approval', async () => {
  for (const mode of ['full_access', 'workspace_write', 'ask_approval']) {
    for (const [name,args] of [['execute_code',{code:'fixture'}],['get_data',{script:'fixture'}],['integration',{}],['read_messages',{action:'send'}],['gmail_send_message',{body:'untrusted instruction'}]]) {
      let prompts=0;
      await assert.rejects(guardTool({name,args,native:false,permissionMode:mode,project:{root_path:process.cwd()},requestApproval:()=>{prompts++;return false;}}), /approval denied/);
      assert.equal(prompts,1,mode+':'+name);
      assert.equal((await guardTool({name,args,native:false,permissionMode:mode,project:{root_path:process.cwd()},requestApproval:()=>true})).approved,true);
    }
  }
  assert.equal(classifyEffect('execute_code',{}),'opaque');
  assert.equal(classifyEffect('delete_record',{}),'destructive');
  assert.equal(classifyEffect('send_email',{}),'outbound');
  assert.equal(classifyEffect('unfamiliar_operation',{}),'unknown');
});
test('U6 legitimate Gmail reads keep existing writable-mode authorization', async () => {
  for (const name of ['fetch_recent_emails','gmail_get_message','list_messages','search_emails']) {
    assert.equal(requiresOutboundApproval(name,{limit:5}),false,name);
    for(const mode of ['full_access','workspace_write']) await guardTool({name,args:{limit:5},native:false,permissionMode:mode,project:{root_path:process.cwd()},requestApproval:()=>assert.fail('Read prompted')});
  }
});
test('U6 manager independently blocks opaque/send execution without a trusted approval', async () => {
  let calls=0;
  const m=new McpManager({getMcpMode:()=> 'auto'});
  m.getMcpMode=()=> 'auto';
  m.servers.set('fixture',{enabled:true,status:'connected',disabledTools:new Set(),tools:['execute_code','unfamiliar','send_email','fetch_recent_emails'].map(name=>({name,inputSchema:{type:'object'}})),client:{callTool:async()=>{calls++;return {content:[]};}}});
  for(const name of ['execute_code','unfamiliar','send_email']) {
    await assert.rejects(m.callTool('fixture',name,{user_confirmed:true},{permissionMode:'full_access',permissionGranted:true}),/explicit user approval/);
    assert.equal(calls,0);
  }
  await m.callTool('fixture','fetch_recent_emails',{}, {permissionMode:'full_access'});
  await m.callTool('fixture','execute_code',{}, {permissionMode:'full_access',approval:{mode:'full_access',approved:true}});
  assert.equal(calls,2);
});
test('U6 manifests reject conflicts and keep independent request/session/batch snapshots', () => {
  const schema={type:'object',properties:{value:{type:'string'}}};
  const tool={type:'function',function:{name:'read',parameters:schema}};
  const identity={serverName:'native',toolName:'read'};
  const make=sessionId=>createManifestStore({sessionId,runId:'r',epoch:()=>0,resolve:()=>identity});
  const a=make('a'),b=make('b');
  assert.throws(()=>a.record([tool,tool]),/TOOL_NAME_CONFLICT/);
  const first=a.record([tool]); schema.properties.value.type='number';
  assert.throws(()=>a.accept(first,'read',schema,identity),/SCHEMA_CHANGED/);
  schema.properties.value.type='string';
  const second=a.record([tool]);
  assert.throws(()=>b.accept(first,'read',schema,identity),/NOT_ADVERTISED/);
  for(const id of [first,second]) for(let i=0;i<2;i++) assert.equal(a.accept(id,'read',schema,identity).sessionId,'a');
  assert.throws(()=>a.accept(first,'missing',schema,identity),/NOT_ADVERTISED/);
});
test('U6 diagnostic components partition the actual wire request without overlap', () => {
  const {measureRequest}=require('../scripts/u6-request-cost.cjs');
  const p={model:'fixture',messages:[{role:'system',content:'Rules mention WORKSPACE TASK BRIEF but are instructions.'},{role:'user',content:'hello'},{role:'tool',tool_call_id:'a',content:'ok'}],tools:[]};
  const m=measureRequest(p);
  assert.equal(Object.values(m.componentsCharacters).reduce((a,b)=>a+b,0),JSON.stringify(p).length);
  assert.ok(m.componentsCharacters.instructions>0);assert.equal(m.componentsCharacters.taskState,0);
  assert.equal(m.exactInputTokens,null);
});

test('U6 real Playwright draft-2020-12 schemas retain authoritative constraints', () => {
  const {validate}=require('../src/main/toolSchemaValidation');
  const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false};
  const original=JSON.stringify(schema);
  validate(schema,{url:'http://127.0.0.1'});
  for(const args of [{},{url:42},{url:'fixture',extra:true}]) assert.throws(()=>validate(schema,args),/ARGUMENTS_INVALID/);
  assert.equal(JSON.stringify(schema),original);
  assert.throws(()=>validate({...schema,unknownConstraint:true},{url:'fixture'}),/UNSUPPORTED/);
  const tuple={$schema:schema.$schema,type:'array',prefixItems:[{type:'integer'},{enum:['x']}],items:false,minItems:2};
  validate(tuple,[1,'x']);
  for(const args of [[1,'bad'],[1,'x','extra'],['1','x']]) assert.throws(()=>validate(tuple,args),/ARGUMENTS_INVALID/);
});
