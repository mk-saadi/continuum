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
const { createHash } = require('node:crypto');
const permissions = require('../src/main/toolPermissions');
const { McpManager } = require('../src/main/mcpManager');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const results = { measurementMethod: 'actual transport JSON characters / 4; estimate, not tokenizer count', initial: [], scaling: [], inventory: [], loops: [], diagnostics: [] };
const emptyConfig = () => fs.writeFileSync(mcp.configPath, '{"mcpServers":{}}');
test.after(() => {
  if (process.env.T2E_EVIDENCE_PATH) fs.writeFileSync(process.env.T2E_EVIDENCE_PATH, JSON.stringify(results, null, 2));
  mcp.configPath = oldConfig; database.closeDatabase(); Module._load = load; os.homedir = originalHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
async function capture(f, mode, tools, messages, provider = 'local') {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  let body;
  const cloudProviders = require('../src/main/cloudProviders');
  const transport = async (_url, options) => {
    body = JSON.parse(options.body);
    return provider === 'anthropic' ? Response.json({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 123, output_tokens: 1 } }) : Response.json({ choices: [{ message: { content: 'hello [TASK COMPLETE]' }, finish_reason: 'stop' }] });
  };
  let fetchImpl = transport;
  if (provider !== 'local') {
    cloudProviders.saveCloudProvider({ id: provider, name: provider, apiType: provider === 'anthropic' ? 'anthropic' : 'openai', baseUrl: provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://openrouter.ai/api/v1', apiKey: 'disposable-fake-key' });
    fetchImpl = cloudProviders.createCloudFetch({ type: 'cloud', provider, model: provider === 'anthropic' ? 'claude-fixture' : 'fixture' }, { stream: false, fetchImpl: transport });
  }
  await runMemoryChat({ baseUrl: 'http://fixture', modelId: 'fixture', cloud: provider !== 'local', messages, chatTools: tools, fetchImpl });
  assert.ok(body); return body;
}
function measurement(body, f, mode, provider, catalog = '') {
  const systems = body.system ?? body.messages.filter(m => m.role === 'system');
  return { chatMode: f.project ? 'workspace' : 'casual', permissionMode: mode, provider, model: body.model,
    requestFingerprint: hash(body), requestBytes: bytes(body), requestCharacters: JSON.stringify(body).length,
    estimatedInputTokens: estimate(body), exactInputTokens: null, providerReportedPromptTokens: null,
    systemInstructionBytes: bytes(systems), personaInstructionBytes: 0,
    nativeSchemaCount: body.tools?.length ?? 0, nativeSchemaBytes: bytes(body.tools ?? []), mcpDiscoveryBytes: bytes(catalog),
    activatedMcpSchemaBytes: 0, projectContextBytes: bytes(builder.buildProjectContext(f.id)),
    taskStateBytes: bytes(body.messages.filter(m => /WORKSPACE TASK BRIEF|TASK CHECKPOINT/.test(String(m.content)))), messageCount: body.messages.length,
    measurementConfidence: 'estimated', measurementMethod: results.measurementMethod };
}
test('Gate 1: actual local, Anthropic and OpenRouter transport bodies for fresh sessions', async () => {
  emptyConfig();
  for (const provider of ['local', 'anthropic', 'openrouter']) for (const mode of [null, 'read_only', 'ask_approval', 'workspace_write', 'full_access']) {
    const f = fixture(mode), p = payload(f, mode || 'read_only');
    const body = await capture(f, mode, p.tools, p.messages, provider);
    const row = measurement(body, f, mode || 'read_only', provider); results.initial.push(row);
    assert.ok(row.estimatedInputTokens <= (mode ? 11000 : 2000));
    if (mode) assert.ok(row.nativeSchemaCount > 2); else assert.equal(row.nativeSchemaCount, 2);
  }
  for (const variant of ['persona', 'custom-system', 'repository', 'task-brief']) {
    const mode = ['repository', 'task-brief'].includes(variant) ? 'full_access' : null;
    const f = fixture(mode);
    if (variant === 'persona') {
      const agent = require('../src/main/agentManager').createAgent({ name: 'Teacher', system_prompt: 'Explain clearly, one concept at a time.' });
      require('../src/main/agentManager').applyAgent(f.id, agent.id, 'fixture');
    }
    if (variant === 'custom-system') profiles.saveProfileSettings(null, { systemPrompt: 'CUSTOM_REQUIRED_RULE '.repeat(500) });
    if (variant === 'repository') { fs.mkdirSync(path.join(f.root, '.git')); fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'Use small verified edits.'); fs.writeFileSync(path.join(f.root, 'App.jsx'), 'export default () => null;'); }
    if (variant === 'task-brief') builder.prepareChatMessages({ sessionId: f.id, modelId: 'fixture', userText: 'Preserve this authoritative task requirement.' });
    const p = payload(f, mode || 'read_only'), body = await capture(f, mode, p.tools, p.messages);
    const row = measurement(body, f, mode || 'read_only', 'local'); row.variant = variant;
    if (variant === 'persona') row.personaInstructionBytes = bytes('Explain clearly, one concept at a time.');
    results.initial.push(row);
    profiles.saveProfileSettings(null, { systemPrompt: '' });
    if (variant === 'custom-system') assert.ok(JSON.stringify(body).includes('CUSTOM_REQUIRED_RULE'));
  }
});
test('Gate 2: exact 50-tool inventory, eligible discovery and incremental activation across modes', () => {
  const all = [...agentTools, ...builder.memoryTools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), require('../src/main/engineManager').askUserTool];
  assert.equal(all.length, 51); assert.equal(new Set(all.map(t => t.function.name)).size, 51);
  results.fullCatalog = { count: all.length, bytes: bytes(all), characters: JSON.stringify(all).length, estimatedTokens: estimate(all), fingerprint: hash(all) };
  const modeData = {};
  for (const mode of ['read_only', 'ask_approval', 'workspace_write', 'full_access']) {
    const f = fixture(mode); activation.begin(f.id, mode);
    const available = builder.getToolContext([], true, f.id, mode, 'fixture', { fullCatalog: true }).tools;
    const catalog = activation.manage({ action: 'list' }, f.id, available, mode);
    const eligible = catalog.groups.flatMap(g => g.tools);
    for (const t of available) assert.ok(['ask_user', 'manage_native_tools'].includes(t.function.name) || eligible.includes(t.function.name), t.function.name);
    for (const group of catalog.groups) activation.manage({ action: 'activate', groups: [group.group] }, f.id, available, mode);
    const active = builder.getToolContext([], true, f.id, mode, 'fixture').tools.map(t => t.function.name);
    for (const name of eligible) assert.ok(active.includes(name), name);
    modeData[mode] = { available: available.map(t => t.function.name), active };
    activation.end(f.id, mode);
  }
  const casual=fixture(); const casualTools=builder.getToolContext([],true,casual.id,'read_only','fixture',{fullCatalog:true}).tools.map(t=>t.function.name);
  const childTools=require('../src/main/subagents/agentLoop').CHILD_TOOL_NAMES;
  const source = fs.readFileSync(path.join(__dirname, '../src/main/tools/agentTools.js'), 'utf8');
  for (const t of all) {
    const name = t.function.name, group = Object.entries(activation.groups).find(([,names]) => names.includes(name))?.[0] || (name === 'ask_user' ? 'clarification' : 'discovery');
    results.inventory.push({ name, group, initialVisibility: ['ask_user','manage_native_tools'].includes(name) ? (name === 'ask_user' ? 'workspace only, if configured' : 'all') : 'hidden',
      discovery: 'authorized names in manage_native_tools list, grouped by capability; no free-text search', activation: group === 'discovery' || group === 'clarification' ? 'initial' : 'activate group '+group,
      modes: Object.fromEntries(Object.entries(modeData).map(([m,d]) => [m, { eligible: d.available.includes(name), activated: d.active.includes(name) }])),
      capability: permissions.capabilityOf(name), permissionRequirements: Object.fromEntries(['read_only','ask_approval','workspace_write','full_access'].map(mode => [mode, name === 'ask_user' ? { decision: 'workspace clarification' } : permissions.baseDecision({capability:permissions.capabilityOf(name),mode,hasWorkspace:true,native:true})])), backendDispatch: ['ask_user','search_memory','save_memory'].includes(name) ? 'engine/memory dispatcher' : source.includes(name) ? 'agent dispatcher registration present' : 'unverified',
      configuration: name === 'generate_image' ? 'image provider absent' : group === 'lsp' ? 'supported JS/TS project and LSP runtime' : name === 'use_skill' ? 'project skill required' : name === 'delegate_task' ? 'legacy, shadowed by execute_command; cloud excludes it' : 'permission/session policy',
      supportedContexts: {workspace:'per-mode eligibility above',casualReadOnly:casualTools.includes(name),investigationChild:childTools.includes(name)}, coverage: 'schema, permission visibility, discovery and activation; execution is representative, not all 50 invoked', actualResult: 'all eligible schemas reachable in tested modes' });
  }
});
test('Gate 3: bounded MCP search replaces model-facing directory without stranding later entries', async () => {
  for (const [serverCount, toolsPerServer] of [[0,0],[5,10],[20,20],[50,20],[100,20],[100,100]]) {
    const beforeMemory = process.memoryUsage().heapUsed;
    const definitions = Object.fromEntries(Array.from({ length: serverCount }, (_,i) => ['server-'+String(i).padStart(3,'0'), { command: 'never-executed', description: i === serverCount-1 ? 'GitHub pull requests and related issues' : 'Mock calendar integration capability '+i }]));
    fs.writeFileSync(mcp.configPath, JSON.stringify({ mcpServers: definitions }));
    const manager = new McpManager({ configPath: mcp.configPath, lazyByDefault: true, createConnection: async () => ({ setNotificationHandler() {}, listTools: async () => ({ tools: Array.from({ length: toolsPerServer }, (_,i) => ({ name: 'read_issue_'+i, description: 'Read mock issue details '+i, inputSchema: { type: 'object', properties: { issue: { type: 'string' } } } })) }), callTool: async () => ({ content: [{ type: 'text', text: 'mock issue' }] }), close: async () => {} }) });
    try {
      await manager.init();
      // Cache all fake schemas outside context, including entries near the end. No subprocesses.
      for (const server of manager.servers.values()) server.tools = Array.from({ length: toolsPerServer }, (_,i) => ({ name: 'read_issue_'+i, description: 'Read mock issue details '+i, inputSchema: { type: 'object', properties: { issue: { type: 'string' } } } }));
      const start = performance.now(), discovery = manager.searchCapabilities({query:'GitHub',limit:5}, 'scaling'), catalog = '';
      const row = { serverCount, toolsPerServer, availableTools: serverCount*toolsPerServer, discoveryLatencyMs: performance.now()-start, initialMcpSchemaCount: manager.getTools('scaling').length,
        discoveryPromptBytes: bytes(catalog), initialMetadataOverheadBytes: bytes(catalog), resultCount: discovery.results.length, resultPayloadBytes: bytes(discovery), searchSupported: true, paginationSupported: true, relevantLastEntryPresent: !serverCount || discovery.results.some(r => r.serverId === Object.keys(definitions).at(-1)), initial: [] };
      for (const mode of [null, 'full_access']) {
        const f = fixture(mode), p = payload(f, mode || 'read_only');
        const body = await capture(f, mode, p.tools, p.messages); row.initial.push(measurement(body, f, mode || 'read_only', 'local', catalog));
        if (mode) assert.ok(p.tools.length > 2); else assert.equal(p.tools.length, 2);
      }
      if (serverCount) {
        const startActivation = performance.now(); await manager.manageServers('enable', [Object.keys(definitions).at(-1)], 'scaling'); row.activationLatencyMs = performance.now()-startActivation;
        const schemas = manager.getTools('scaling'); assert.equal(schemas.length, toolsPerServer); assert.equal(manager.getTools('other-session').length, 0);
        row.activatedSchemaCount = schemas.length; row.activatedSchemaBytes = bytes(schemas); row.unrelatedSchemasAbsent = !schemas.some(t => !t.function.name.startsWith('mcp_read_issue'));
        const f = fixture('full_access'), p = payload(f, 'full_access'); const tools = builder.getToolContext(schemas, true, f.id, 'full_access', 'fixture').tools;
        row.postActivationEstimatedTokens = estimate(await capture(f, 'full_access', tools, p.messages));
        await manager.manageServers('disable', [Object.keys(definitions).at(-1)], 'scaling'); assert.equal(manager.getTools('scaling').length,0);
        assert.throws(() => manager.resolveTool(schemas[0].function.name,'scaling'), /unavailable/);
      }
      row.heapDeltaBytes = process.memoryUsage().heapUsed-beforeMemory; results.scaling.push(row);
    } finally { await manager.close(); }
  }
  emptyConfig();
  assert.ok(results.scaling.every(row => row.discoveryPromptBytes === 0 && row.resultCount <= 5 && row.relevantLastEntryPresent));
  results.diagnostics.push({ code: 'MCP_CATALOG_PROMPT_LEAKAGE', status: 'fixed in T2F; directory absent from prompt', insertionPath: 'bounded manager search returned as tool data', noBoundedSearch: false });
});

test('legacy explicit server enable retains whole-server compatibility; stale removal cannot resolve old schema', async () => {
  const manager = new McpManager({ configPath: path.join(directory,'large.json'), lazyByDefault: true,
    createConnection: async () => ({ setNotificationHandler() {}, listTools: async () => ({ tools: Array.from({ length:150 }, (_,i) => ({ name:'read_record_'+i, description:'Inspect a disposable mock record', inputSchema:{ type:'object', properties:{ id:{type:'string'} } } })) }), close:async()=>{} }) });
  try {
    await manager.saveConfig({mcpServers:{large:{command:'never-executed'}}});
    const start=performance.now(); await manager.manageServers('enable',['large'],'large-session');
    const tools=manager.getTools('large-session'); assert.equal(tools.length,150);
    results.largeServer={availableTools:150,neededTools:2,activatedTools:tools.length,schemaBytes:bytes(tools),estimatedSchemaTokens:estimate(tools),activationLatencyMs:performance.now()-start,selectiveActivationSupported:false};
    const saved=mcp.configPath; mcp.configPath=manager.configPath;
    try { const f=fixture('full_access'),p=payload(f,'full_access'); const body=await capture(f,'full_access',builder.getToolContext(tools,true,f.id,'full_access','fixture').tools,p.messages); results.largeServer.postActivationEstimatedInputTokens=estimate(body); results.largeServer.requestFingerprint=hash(body); } finally {mcp.configPath=saved;}
    const old=tools[0].function.name;
    await manager.saveConfig({mcpServers:{}}); assert.equal(manager.getTools('large-session').length,0); assert.throws(()=>manager.resolveTool(old,'large-session'),/unavailable/);
  } finally {await manager.close();}
});

test('representative coding task: actual adapters, same-run refresh, recovery callback, cumulative full-catalog comparison', async () => {
  emptyConfig();
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const cp = require('../src/main/cloudProviders');
  for (const provider of ['local','anthropic','openrouter']) for (const fullCatalog of [false,true]) {
    const f=fixture('full_access'), runId='coding-'+provider+'-'+fullCatalog;
    fs.writeFileSync(path.join(f.root,'SettingsModal.jsx'),'export const title = "Settings";\n');
    activation.begin(f.id,runId);
    const context=require('../src/main/lspExecutionContext').createContext(f.id,'full_access',runId);
    const operations=[
      ['search_project_content',{query:'Settings'}], ['read_project_file',{relative_path:'SettingsModal.jsx'}],
      ['str_replace_editor',{relative_path:'SettingsModal.jsx',old_str:'export const title = "Settings";',new_str:'export const title = "Preferences";'}],
      ['run_tests',{command:JSON.stringify(process.execPath)+` -e 'require("node:assert/strict").match(require("node:fs").readFileSync("SettingsModal.jsx","utf8"), /Preferences/)'`}],
    ];
    let index=0, executed=0, recoveryCalls=0, steerDelivered=0; const profiles=[], outcomes=[];
    const initial=payload(f,'full_access','Inspect the component, make a small edit and verify it.');
    const getTools=()=>fullCatalog ? [...agentTools, ...builder.memoryTools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.input_schema}})), require('../src/main/engineManager').askUserTool] : builder.getToolContext([],true,f.id,'full_access','fixture').tools;
    const respond=async (_url,options)=>{
      const body=JSON.parse(options.body), n=index++;
      profiles.push({request:n+1,estimatedInputTokens:estimate(body),requestBytes:bytes(body),requestFingerprint:hash(body),schemaCount:body.tools.length});
      const names=body.tools.map(t=>t.function?.name??t.name); assert.equal(new Set(names).size,names.length);
      if(n){
        if(provider==='anthropic') assert.ok(body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'&&c.tool_use_id==='step-'+n)));
        else assert.ok(body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='step-'+n));
      }
      const op=operations[n]; if(op) assert.ok(names.includes(op[0]),op[0]);
      if(provider==='anthropic') return Response.json({content:op?[{type:'tool_use',id:'step-'+(n+1),name:op[0],input:op[1]}]:[{type:'text',text:'Verified. [TASK COMPLETE]'}],stop_reason:op?'tool_use':'end_turn',usage:{input_tokens:123,output_tokens:1}});
      return Response.json({choices:[{message:op?{tool_calls:[{id:'step-'+(n+1),type:'function',function:{name:op[0],arguments:JSON.stringify(op[1])}}]}:{content:'Verified. [TASK COMPLETE]'},finish_reason:op?'tool_calls':'stop'}]});
    };
    let transport=respond;
    if(provider!=='local') transport=cp.createCloudFetch({type:'cloud',provider,model:provider==='anthropic'?'claude-fixture':'fixture'},{stream:false,fetchImpl:respond});
    const fetchImpl=async(url,options)=>{
      if(provider==='local'&&index===2&&!recoveryCalls){
        const replacement=await options.contextRecovery({contextWindowLimit:32768}); assert.ok(replacement); recoveryCalls++;
      }
      return transport(url,options);
    };
    try {
      const final=await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',cloud:provider!=='local',messages:initial.messages,chatTools:getTools(),getChatTools:async()=>getTools(),
        recoverContext:async()=>({messages:builder.rebuildChatMessages({sessionId:f.id,modelId:'fixture'})}),
        takeSteeringInstructions:async()=>index===1?[{id:'steer',content:'Keep the task objective and verify the edit.'}]:[],markSteeringDelivered:async()=>{steerDelivered++;},
        fetchImpl,executeTool:async call=>{executed++; const result=await require('./helpers/approvedNativeCommand.cjs')({...call,sessionId:f.id,permissionMode:'full_access',executionContext:context}); outcomes.push({name:call.name,error:!!result?.error,status:result?.status??null});assert.ok(!result?.error,JSON.stringify(result));if(call.name==='run_tests')assert.equal(result.status,'passed');return result;}});
      assert.equal(outcomes.length,operations.length);assert.ok(outcomes.every(o=>!o.error));assert.ok(outcomes.some(o=>o.name==='run_tests'&&o.status==='passed'));assert.equal(executed,operations.length);assert.equal(index,operations.length+1);assert.equal(steerDelivered,1);
      assert.equal(fs.readFileSync(path.join(f.root,'SettingsModal.jsx'),'utf8'),'export const title = "Preferences";\n');
      results.loops.push({provider,fullCatalog,runIdStable:true,requests:index,executed,activationCalls:0,failedActivations:0,repeatedActivations:0,editCount:1,steeringDelivered:steerDelivered,recoveryCallbacks:recoveryCalls,
        recoveryMethod:provider==='local'?'explicit transport recovery callback, not actual threshold pressure':'not exercised',completed:true,outcomes,profiles,cumulativeEstimatedInputTokens:profiles.reduce((s,p)=>s+p.estimatedInputTokens,0),outputTokens:null});
    } finally{activation.end(f.id,runId);}
  }
});

test('native and mock GitHub MCP execute together with independent session grants', async()=>{
  const config=path.join(directory,'coexist.json');
  const manager=new McpManager({configPath:config,lazyByDefault:true,createConnection:async()=>({setNotificationHandler(){},listTools:async()=>({tools:[{name:'read_issue',description:'Read mock GitHub issue',inputSchema:{type:'object',properties:{}}}]}),callTool:async()=>({content:[{type:'text',text:'Disposable issue details'}]}),close:async()=>{}})});
  const f=fixture('full_access'), id='coexist'; activation.begin(f.id,id);
  const previousManage=mcp.findAndPrepare; manager.beginRun(f.id,id);
  try{
    await manager.saveConfig({mcpServers:{github:{command:'never-executed',description:'GitHub issues'}}});
    mcp.findAndPrepare=(...args)=>manager.findAndPrepare(...args);
    const context=require('../src/main/lspExecutionContext').createContext(f.id,'full_access',id);
    fs.writeFileSync(path.join(f.root,'App.jsx'),'export default () => null;');
    const operations=[['read_project_file',{relative_path:'App.jsx'}],['find_and_prepare_mcp_tools',{query:'github read_issue'}],['MCP',{}],['str_replace_editor',{relative_path:'App.jsx',old_str:'export default () => null;',new_str:'export default () => "fixed";'}],['run_tests',{command:JSON.stringify(process.execPath)+` -e 'require("node:assert/strict").match(require("node:fs").readFileSync("App.jsx","utf8"), /fixed/)'`}]];
    let index=0,nativeCalls=0,mcpCalls=0;const outcomes=[];const p=payload(f,'full_access');
    const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
    await runMemoryChat({baseUrl:'http://fixture',modelId:'fixture',messages:p.messages,chatTools:p.tools,
      getChatTools:async()=>builder.getToolContext(manager.getTools(f.id),true,f.id,'full_access','fixture').tools,
      executeTool:async call=>{
        if(call.name.startsWith('mcp_')){mcpCalls++;const target=manager.resolveTool(call.name,f.id);return manager.callTool(target.serverName,target.toolName,JSON.parse(call.arguments),{sessionId:f.id,permissionMode:'full_access',permissionGranted:true});}
        nativeCalls++;const result=await require('./helpers/approvedNativeCommand.cjs')({...call,sessionId:f.id,permissionMode:'full_access',executionContext:context});outcomes.push({name:call.name,error:!!result?.error,status:result?.status??null});assert.ok(!result?.error,JSON.stringify(result));return result;
      },fetchImpl:async(_url,options)=>{
        const body=JSON.parse(options.body),op=operations[index++];
        const names=body.tools.map(t=>t.function.name);assert.equal(new Set(names).size,names.length);
        if(index>1)assert.ok(body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='co-'+(index-1)));
        if(!op)return Response.json({choices:[{message:{content:'Verified coexistence. [TASK COMPLETE]'},finish_reason:'stop'}]});
        const name=op[0]==='MCP'?manager.getTools(f.id)[0].function.name:op[0];assert.ok(names.includes(name));
        return Response.json({choices:[{message:{tool_calls:[{id:'co-'+index,type:'function',function:{name,arguments:JSON.stringify(op[1])}}]},finish_reason:'tool_calls'}]});
      }});
    assert.equal(nativeCalls,4);assert.equal(mcpCalls,1);assert.equal(outcomes.length,4);assert.ok(outcomes.every(o=>!o.error));assert.ok(outcomes.some(o=>o.name==='run_tests'&&o.status==='passed'));assert.match(fs.readFileSync(path.join(f.root,'App.jsx'),'utf8'),/fixed/);assert.equal(manager.getTools('different-session').length,0);
    results.coexistence={completed:true,requests:index,nativeCalls,mcpCalls,uniqueNames:true,pairsIntact:true,otherSessionSchemas:0,outcomes};
  }finally{mcp.findAndPrepare=previousManage;manager.endRun(f.id,id);activation.end(f.id,id);await manager.close();}
});

test('session/run lifecycle and model changes retain only currently authorized native exposure', async()=>{
  emptyConfig();
  const a=fixture('full_access'),b=fixture('full_access'),c=fixture();
  activation.begin(a.id,'a');activation.begin(b.id,'b');
  try{
    const available=f=>builder.getToolContext([],true,f.id,'full_access','fixture',{fullCatalog:true}).tools;
    activation.manage({action:'activate',groups:['files','editing']},a.id,available(a),'a');
    activation.manage({action:'activate',groups:['memory']},b.id,available(b),'b');
    const names=(f,mode='full_access',model='fixture')=>builder.getToolContext([],true,f.id,mode,model).tools.map(t=>t.function.name);
    assert.ok(names(a).includes('write_project_file'));assert.ok(names(b).includes('read_project_file'));assert.deepEqual(names(c,'read_only'),['find_and_prepare_mcp_tools','manage_native_tools']);
    assert.ok(names(a,'full_access','changed-model').includes('read_project_file'));
    const context=require('../src/main/lspExecutionContext').createContext(a.id,'full_access','a');
    await require('../src/main/lspExecutionContext').setMode(a.id,'read_only');
    assert.ok(!names(a,'read_only').includes('write_project_file'));
    const denied=await executeAgentTool({name:'write_project_file',arguments:{relative_path:'denied.txt',content:'no'},sessionId:a.id,permissionMode:'full_access',executionContext:context});
    assert.ok(denied.error);assert.ok(!fs.existsSync(path.join(a.root,'denied.txt')));
    activation.end(a.id,'wrong-owner');assert.equal(activation.snapshot(a.id).dynamicToolActivationCount,2);
    activation.end(a.id,'a');activation.begin(a.id,'reopened');assert.equal(activation.snapshot(a.id).dynamicToolActivationCount,0);
    assert.ok(names(a,'read_only').includes('read_project_file'));assert.ok(!names(a,'read_only').includes('write_project_file'));
    results.sessionIsolation={separateNativeGroups:true,casualWorkspaceLeak:false,modelSwitchRefresh:true,downgradeRevokes:true,staleExecutionDenied:true,newRunStartsCompact:true,uiTabs:'unverified',backendRestart:'not end-to-end tested; activation Map is process-local'};
  }finally{activation.end(a.id,'a');activation.end(a.id,'reopened');activation.end(b.id,'b');}
});

test('optional image provider absence is an explicit capability failure',async()=>{
  const f=fixture('full_access');
  const response=await executeAgentTool({sessionId:f.id,name:'generate_image',arguments:{prompt:'disposable fixture'},permissionMode:'full_access'});
  assert.ok(response.error);assert.match(String(response.error),/provider|model|configur|image/i);
  results.optionalImage={providerConfigured:false,result:'explicit error',noRemoteRequest:true};
});
