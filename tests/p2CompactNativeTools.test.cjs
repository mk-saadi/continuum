'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-native-'));
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
const { agentTools, executeAgentTool } = require('../src/main/tools/agentTools');
const schema = require('../src/main/toolSchemaValidation');
const config = require('../src/main/configManager');
const oldProfile = process.env.CONTINUUM_NATIVE_TOOL_PROFILE;
const completedTests = [];
test.afterEach(context => completedTests.push(context.name));
function fixture(mode = 'workspace_write') {
  const id = require('node:crypto').randomUUID(), root = path.join(directory,id); fs.mkdirSync(root);
  const project = mode && projects.createProject({name:'Disposable', root_path:root,permissionMode:mode});
  sessions.getOrCreateSession(id,'fixture',project?.id);
  activation.begin(id,'owner');
  return { id, root, mode: mode || 'read_only' };
}
const tools = f => builder.getToolContext([],true,f.id,f.mode,'fixture').tools;
const names = f => tools(f).map(t => t.function.name);
const available = f => builder.getToolContext([],true,f.id,f.mode,'fixture',{fullCatalog:true}).tools;
const manage = (f,args) => activation.manage(args,f.id,available(f),'owner');
const call = (f,name,args) => executeAgentTool({name,arguments:args,sessionId:f.id,permissionMode:f.mode,rootPath:f.root});
test.before(() => { process.env.CONTINUUM_NATIVE_TOOL_PROFILE='compact'; config.saveAppSettings({mcpMode:'auto'}); });
test.after(() => {
  if (process.env.COMPACT_SUITE_EVIDENCE) fs.writeFileSync(process.env.COMPACT_SUITE_EVIDENCE, JSON.stringify({ completedTests }));
  if (oldProfile === undefined) delete process.env.CONTINUUM_NATIVE_TOOL_PROFILE; else process.env.CONTINUUM_NATIVE_TOOL_PROFILE=oldProfile;
  database.closeDatabase(); Module._load=load; fs.rmSync(directory,{recursive:true,force:true});
});
test('production default is held at full pending real-model acceptance; explicit selection is shared by launch paths', () => {
  const { configuredProfile } = require('../src/main/compactNativeTools');
  const priorNodeEnv = process.env.NODE_ENV;
  try {
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV = mode;
      delete process.env.CONTINUUM_NATIVE_TOOL_PROFILE;
      assert.equal(configuredProfile(), 'full');
      process.env.CONTINUUM_NATIVE_TOOL_PROFILE = 'full'; assert.equal(configuredProfile(), 'full');
      process.env.CONTINUUM_NATIVE_TOOL_PROFILE = 'compact'; assert.equal(configuredProfile(), 'compact');
    }
    const { scripts, build } = require('../package.json');
    for (const entry of ['dev', 'dev:electron', 'start', 'start:local']) assert.ok(!scripts[entry].includes('CONTINUUM_NATIVE_TOOL_PROFILE='));
    for (const mode of ['compact', 'full']) for (const entry of ['dev', 'start']) assert.ok(scripts[`${entry}:${mode}`].includes(`CONTINUUM_NATIVE_TOOL_PROFILE=${mode}`));
    assert.ok(build.files.includes('src/main/**/*.js'));
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    process.env.CONTINUUM_NATIVE_TOOL_PROFILE = 'compact';
  }
});
test('all authorized schemas compile strictly; read union preserves exactly-one and field constraints', () => {
  const f = fixture();
  for (const t of available(f)) assert.doesNotThrow(() => schema.compile(t.function.parameters), t.function.name);
  const read = available(f).find(t => t.function.name === 'read_project_file').function.parameters;
  // The former valid JSON Schema semantics, with only Ajv's lint disabled in
  // this reference validator. Production remains fully strict.
  assert.equal(read.oneOf, undefined);
  assert.equal(read.allOf[0].oneOf.length, 2);
  const { allOf, ...rootRead } = read;
  const previous = { ...rootRead, oneOf: [{ required: ['relative_path'] }, { required: ['attachment_id'] }] };
  const reference = new (require('ajv'))({ strict: true, strictRequired: false }).compile(previous);
  const current = schema.compile(read);
  for (const relative of [undefined, 'file.txt', 42, null]) for (const attachment of [undefined, 'upload-id', 42, null]) {
    const args = { ...(relative !== undefined ? { relative_path: relative } : {}), ...(attachment !== undefined ? { attachment_id: attachment } : {}) };
    assert.equal(current(args), reference(args), JSON.stringify(args));
  }
  assert.equal(current({ relative_path: 'file.txt', unexpected: true }), false);
  assert.equal(current({ relative_path: 'file.txt', start_line: 0 }), false);
  assert.equal(current({ attachment_id: 'upload-id', expected_content_hash: 'invalid' }), false);
});
test('activation is isolated between sessions, stale owners, termination and new runs', () => {
  const f = fixture(), other = fixture();
  manage(f, { action: 'activate', groups: ['editing', 'git_read'] });
  assert.ok(names(f).includes('git_log'));
  assert.ok(!names(other).includes('git_log'));
  activation.begin(f.id, 'replacement');
  assert.ok(!names(f).includes('git_log'));
  assert.throws(() => manage(f, { action: 'activate', groups: ['editing'] }), /owning run/);
  activation.manage({ action: 'activate', groups: ['editing'] }, f.id, available(f), 'replacement');
  activation.end(f.id, 'owner'); // A stale finalizer cannot clear the new run.
  assert.ok(names(f).includes('edit_project_files'));
  activation.end(f.id, 'replacement');
  assert.deepEqual(activation.snapshot(f.id).activatedToolGroups, []);
  assert.throws(() => manage(f, { action: 'activate', groups: ['editing'] }), /owning run/);
  activation.begin(f.id, 'new-run');
  assert.ok(!names(f).includes('edit_project_files'));
  assert.equal(activation.profile(f.id), 'compact');
});
test('19-tool default preserves exact schemas and stable run profile, full fallback and Casual', () => {
  // 16 profile defaults + the three always-advertised native web tools.
  const f=fixture(); assert.equal(names(f).length,19);
  for (const t of tools(f)) {
    const original=available(f).find(v=>v.function.name===t.function.name); assert.deepEqual(t,original);
    schema.compile(t.function.parameters);
  }
  process.env.CONTINUUM_NATIVE_TOOL_PROFILE='full'; assert.equal(names(f).length,19);
  const full=fixture(); assert.ok(names(full).length>40); assert.ok(!names(full).includes('manage_native_tools'));
  process.env.CONTINUUM_NATIVE_TOOL_PROFILE='compact';
  assert.deepEqual(names(fixture(null)),['extract_web_page_data','find_and_prepare_mcp_tools','get_single_web_page_content','manage_native_tools','web_search']);
});
test('search discovers without exact names; activation is idempotent, owner scoped and finite', () => {
  const f=fixture(); const listed=manage(f,{action:'list',query:'definition'});
  assert.ok(listed.groups.some(g=>g.group==='lsp'));
  assert.throws(()=>activation.manage({action:'activate',groups:['lsp']},f.id,available(f),'other'),/owning/);
  const first=manage(f,{action:'activate',groups:['lsp','editing']});
  assert.equal(first.dynamicToolActivationCount,2); assert.ok(first.groups.every(g=>g.active));
  manage(f,{action:'activate',groups:['lsp','editing']}); assert.equal(activation.snapshot(f.id).dynamicToolActivationCount,2);
  assert.ok(names(f).includes('edit_project_files')); assert.ok(names(f).includes('lsp_hover'));
  assert.throws(()=>manage(f,{action:'activate',groups:['unknown']}),/Invalid/);
  schema.validate(tools(f).find(t=>t.function.name==='manage_native_tools').function.parameters,{action:'list',query:'symbols'});
});
test('discovery via guarded handler; read-only denies activation and forged writes', async () => {
  const f=fixture('read_only'); const r=await call(f,'manage_native_tools',{action:'list',query:'commit'});
  assert.ok(r.success,JSON.stringify(r)); assert.equal(r.groups.find(g=>g.group==='git_write').status,'unauthorized');
  assert.throws(()=>manage(f,{action:'activate',groups:['git_write']}),/No authorized/);
  const denied=await call(f,'write_project_file',{relative_path:'forbidden',content:'no'});
  assert.ok(denied.error); assert.ok(!fs.existsSync(path.join(f.root,'forbidden')));
});
test('activated editing retains traversal/symlink boundaries and live permission downgrade', async () => {
  const f = fixture('workspace_write');
  const contexts = require('../src/main/lspExecutionContext');
  const context = contexts.createContext(f.id, f.mode, 'owner');
  manage(f, { action: 'activate', groups: ['editing'] });
  const outside = path.join(directory, `outside-${f.id}.txt`); fs.writeFileSync(outside, 'Keep');
  fs.symlinkSync(outside, path.join(f.root, 'escape.txt'));
  for (const relative_path of [`../${path.basename(outside)}`, 'escape.txt']) {
    const rejected = await call(f, 'edit_project_files', { edits: [{ relative_path, old_str: 'Keep', new_str: 'Changed' }] });
    assert.ok(rejected.error, JSON.stringify(rejected));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'Keep');
  }
  fs.writeFileSync(path.join(f.root, 'inside.txt'), 'Keep');
  await contexts.setMode(f.id, 'read_only');
  assert.ok(!names(f).includes('edit_project_files'));
  assert.ok(activation.snapshot(f.id).activatedToolGroups.includes('editing'));
  const denied = await executeAgentTool({ name: 'edit_project_files', arguments: { edits: [{ relative_path: 'inside.txt', old_str: 'Keep', new_str: 'Changed' }] },
    sessionId: f.id, permissionMode: context.permissionMode, executionContext: context });
  assert.ok(denied.error, JSON.stringify(denied));
  assert.equal(fs.readFileSync(path.join(f.root, 'inside.txt'), 'utf8'), 'Keep');
  assert.throws(() => manage(f, { action: 'activate', groups: ['git_write'] }), /No authorized/);
});
test('discovered Git schemas execute in a disposable repository; activation cannot bypass approval', async () => {
  const cp = require('node:child_process');
  const f = fixture('full_access');
  const git = (...args) => cp.execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'Before\n');
  git('add', 'file.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Initial');
  assert.ok(!names(f).includes('git_log')); assert.ok(!names(f).includes('git_stage'));
  assert.ok(manage(f, { action: 'list', query: 'history stage commit' }).groups.some(g => g.group === 'git_write'));
  manage(f, { action: 'activate', groups: ['git_read', 'git_write'] });
  for (const name of ['git_status', 'git_log']) {
    const t = tools(f).find(t => t.function.name === name); schema.validate(t.function.parameters, {});
    const result = await call(f, name, {}); assert.ok(!result.error, JSON.stringify(result));
  }
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'After\n');
  let approvals = 0;
  await assert.rejects(require('../src/main/toolPermissions').guardTool({ name: 'git_stage', args: { paths: ['file.txt'] },
    sessionId: f.id, project: require('../src/main/toolPermissions').sessionProject(f.id), permissionMode: 'ask_approval',
    requestApproval: async () => { approvals++; return false; } }), error => error.code === 'APPROVAL_DENIED');
  assert.equal(approvals, 1); assert.equal(git('diff', '--cached'), '');
  const staged = await require('./helpers/approvedNativeCommand.cjs')({ name: 'git_stage', arguments: { paths: ['file.txt'] }, sessionId: f.id, permissionMode: 'full_access' });
  assert.ok(!staged.error, JSON.stringify(staged)); assert.match(git('diff', '--cached'), /After/);
});
test('real surgical JSX/CSS, batch editing, write, history and plan routes retain results', async () => {
  const f=fixture('full_access');
  for (const [file,content] of [['A.jsx','export const A = <div>Old</div>;\n'],['a.css','.a { color: red; }\n']]) {
    assert.ok((await call(f,'write_project_file',{relative_path:file,content})).success);
  }
  for (const [file,old_str,new_str] of [['A.jsx','Old','New'],['a.css','red','blue']]) {
    const result=await call(f,'str_replace_editor',{relative_path:file,old_str,new_str}); assert.ok(result.success,JSON.stringify(result));
  }
  manage(f,{action:'activate',groups:['editing']});
  const rejected=await call(f,'edit_project_files',{edits:[{relative_path:'A.jsx',old_str:'New',new_str:'Later'},{relative_path:'a.css',old_str:'absent',new_str:'x'}]});
  assert.ok(rejected.error); assert.match(fs.readFileSync(path.join(f.root,'A.jsx'),'utf8'),/New/);
  const batch=await call(f,'edit_project_files',{edits:[{relative_path:'A.jsx',old_str:'New',new_str:'Later'},{relative_path:'a.css',old_str:'blue',new_str:'green'}]});
  assert.ok(batch.success,JSON.stringify(batch));
  const plan=await call(f,'update_plan',{action:'create',objective:'P2 fixture',steps:[{description:'Verify'}]}); assert.ok(plan.success,JSON.stringify(plan));
  assert.ok((await call(f,'get_project_plans',{action:'list'})).success);
  const history=await call(f,'get_recent_chat_history',{limit:5}); assert.ok(!history.error,JSON.stringify(history));
});
test('activated interfaces survive real C9 checkpoint rebuild; permission downgrade hides mutations', async () => {
  const f=fixture('full_access'); manage(f,{action:'activate',groups:['editing','git_write']});
  builder.prepareChatMessages({sessionId:f.id,modelId:'fixture',userText:'Inspect and fix source.'});
  sessions.saveMessage(f.id,'assistant','Source evidence. '.repeat(3000)); sessions.saveMessage(f.id,'user','Continue.');
  const result=await require('./fixtures/w3Compaction.cjs').compact({sessionId:f.id,modelId:'fixture'});
  assert.equal(result.compressed,true,JSON.stringify(result));
  builder.rebuildChatMessages({sessionId:f.id,modelId:'fixture'});
  assert.ok(names(f).includes('edit_project_files')); assert.ok(names(f).includes('git_commit'));
  const downgraded=builder.getToolContext([],true,f.id,'read_only','fixture').tools.map(t=>t.function.name);
  assert.ok(!downgraded.includes('git_commit')); assert.ok(!downgraded.includes('str_replace_editor'));
});
test('MCP external schemas stay external; Manual mode suppresses native preparation', () => {
  const f=fixture(); const external={type:'function',function:{name:'fixture__read',description:'External',parameters:{type:'object',properties:{},required:[]}}};
  assert.ok(builder.getToolContext([external],true,f.id,f.mode,'fixture').tools.some(t=>t.function.name===external.function.name));
  manage(f,{action:'activate',groups:['mcp']}); assert.ok(names(f).includes('manage_mcp_servers'));
  config.saveAppSettings({mcpMode:'manual'}); assert.ok(!names(f).includes('manage_mcp_servers')); assert.ok(!names(f).includes('find_and_prepare_mcp_tools'));
  config.saveAppSettings({mcpMode:'auto'});
});
test('disabled external and native Playwright schemas never reach prepared requests', () => {
  const { McpManager } = require('../src/main/mcpManager');
  const manager = new McpManager();
  const f = fixture();
  for (const server of ['external-fixture', 'playwright-native']) manager.servers.set(server, {
    enabled: false, uiEnabled: false, status: 'connected', disabledTools: new Set(),
    tools: [{ name: 'browser_navigate', inputSchema: { type: 'object', properties: {} } }],
  });
  for (const mode of ['manual', 'auto']) {
    manager.getMcpMode = () => mode;
    assert.deepEqual(manager.getTools(f.id), []);
    const prepared = builder.getToolContext(manager.getTools(f.id), true, f.id, f.mode, 'fixture').tools;
    assert.ok(!prepared.some(t => /browser_navigate/.test(t.function.name)));
    assert.throws(() => manager.resolveTool('browser_navigate', f.id), /unavailable|disabled/);
  }
});
test('all 51 legacy contracts have a direct or discoverable path; memory-off remains enforced', () => {
  const f=fixture(); const all=[...agentTools.map(t=>t.function.name),...builder.memoryTools.map(t=>t.name),'ask_user'];
  assert.equal(all.length,51);
  for(const name of all) assert.ok(names(f).includes(name)||Object.values(activation.groups).some(group=>group.includes(name)),name);
  manage(f,{action:'activate',groups:['memory']});
  const off=builder.getToolContext([],false,f.id,f.mode,'fixture').tools.map(t=>t.function.name);
  assert.ok(!off.includes('search_memory')); assert.ok(!off.includes('save_memory')); assert.ok(off.includes('get_recent_chat_history'));
});
test('production loop pairs tool results and measures common coding and discovery overhead', async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const rows=[];
  for (const specialized of [false,true]) for (const profile of ['full','compact']) {
    process.env.CONTINUUM_NATIVE_TOOL_PROFILE=profile;
    const f=fixture('full_access'); fs.writeFileSync(path.join(f.root,'A.jsx'),'export const title = "Old";\n');
    const operations=[
      ['search_project_content',{query:'Old'}], ['read_project_file',{relative_path:'A.jsx'}],
      ['str_replace_editor',{relative_path:'A.jsx',old_str:'Old',new_str:'New'}],
      ['write_project_file',{relative_path:'check.cjs',content:'require("node:assert/strict").match(require("node:fs").readFileSync("A.jsx","utf8"),/New/);'}],
      ['execute_command',{command:'node check.cjs'}],
    ];
    if(specialized) {
      if(profile==='compact') operations.push(['manage_native_tools',{action:'list',query:'batch edits'}],['manage_native_tools',{action:'activate',groups:['editing']}]);
      operations.push(['edit_project_files',{edits:[{relative_path:'A.jsx',old_str:'New',new_str:'Verified'}]}]);
    }
    const messages=builder.prepareChatMessages({sessionId:f.id,modelId:'fixture',userText:'Fix the title and verify it.'});
    let requests=0, failures=0; const sizes=[]; const resultBytes=[];
    await runMemoryChat({baseUrl:'http://fixture.invalid',modelId:'fixture',messages,chatTools:tools(f),getChatTools:async()=>tools(f),
      executeTool:async c=>{
        const t=tools(f).find(t=>t.function.name===c.name); schema.validate(t.function.parameters,JSON.parse(c.arguments));
        const r=await require('./helpers/approvedNativeCommand.cjs')({...c,sessionId:f.id,permissionMode:f.mode});
        if(r.error) failures++; assert.ok(!r.error,JSON.stringify(r)); resultBytes.push(Buffer.byteLength(JSON.stringify(r))); return r;
      },
      fetchImpl:async(_url,options)=>{
        const body=JSON.parse(options.body); sizes.push({bytes:Buffer.byteLength(options.body),estimatedTokens:require('../src/main/contextBudget').approximateTokens(body),tools:body.tools.length});
        if(requests) assert.ok(body.messages.some(m=>m.role==='tool'&&m.tool_call_id===`p2-${requests}`));
        const anthropic=require('../src/main/cloudProviders').anthropicPayload(body,'claude-fixture'); assert.equal(anthropic.tools.length,body.tools.length);
        const op=operations[requests++];
        if(!op)return Response.json({choices:[{message:{content:'Verified. [TASK COMPLETE]'},finish_reason:'stop'}]});
        assert.ok(body.tools.some(t=>t.function.name===op[0]),op[0]);
        return Response.json({choices:[{message:{tool_calls:[{id:`p2-${requests}`,type:'function',function:{name:op[0],arguments:JSON.stringify(op[1])}}]},finish_reason:'tool_calls'}]});
      }});
    rows.push({profile,specialized,requests,operations:operations.length,discoveryCalls:operations.filter(o=>o[0]==='manage_native_tools').length,failedCalls:failures,resultBytes,requestsMeasured:sizes,totalEstimatedInputTokens:sizes.reduce((n,s)=>n+s.estimatedTokens,0)});
    activation.end(f.id,'owner');
  }
  process.env.CONTINUUM_NATIVE_TOOL_PROFILE='compact';
  assert.ok(rows[1].totalEstimatedInputTokens<rows[0].totalEstimatedInputTokens);
  if(process.env.P2_LOOP_EVIDENCE)fs.writeFileSync(process.env.P2_LOOP_EVIDENCE,JSON.stringify(rows,null,2));
});
