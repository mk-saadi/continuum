'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/main/mcpManager');
const schema = (name, description = 'Read mock issue') => ({ name, description, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } });
async function fixture(count = 100, per = 100) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't2f-'));
  let starts = 0, calls = 0;
  const tools = Array.from({length: per}, (_, i) => schema('read_issue_' + i));
  const manager = new McpManager({ configPath: path.join(root,'mcp.json'), lazyByDefault: true, createConnection: async () => {
    starts++; return { setNotificationHandler() {}, listTools: async () => ({tools}), close: async () => {}, callTool: async () => { calls++; return {content:[{type:'text',text:'mock'}]}; } };
  } });
  await manager.saveConfig({ mcpServers: Object.fromEntries(Array.from({length: count}, (_, i) => ['server-'+String(i).padStart(3,'0'), {command:'never-executed',description:i===99?'GitHub repository issues':'Calendar'}])) });
  for(const s of manager.servers.values()) s.tools = tools.map(t => ({...t}));
  return {manager, tools, starts:()=>starts,calls:()=>calls, close:async()=>{await manager.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('Gate A: 10,000 capabilities remain searchable, bounded, deterministic and paginated', async()=>{
  const f=await fixture(); const m=f.manager;
  try {
    m.servers.get('server-099').tools.push(schema('unique_last_capability', 'Locate nebula tickets'));
    assert.equal(m.searchCapabilities({query:'nebula'}).results[0].serverId,'server-099');
    assert.equal(f.starts(),0);
    let cursor, seen=new Set(), pages=0;
    do {const r=m.searchCapabilities({query:'read_issue_99',limit:10,cursor}); assert.ok(r.results.length<=10);assert.ok(Buffer.byteLength(JSON.stringify(r))<14000);for(const row of r.results)seen.add(row.serverId); cursor=r.cursor;pages++;}while(cursor);
    assert.equal(seen.size,100);assert.ok(pages>=10);
    const first=m.searchCapabilities({query:'',limit:5}); assert.deepEqual(first,m.searchCapabilities({query:'',limit:5}));
    m.servers.get('server-099').definition.description='Changed';
    assert.throws(()=>m.searchCapabilities({query:'',cursor:first.cursor}),/catalog changed/);
    for(const request of [{limit:11},{query:null},{cursor:'bad'},{limit:0}])assert.throws(()=>m.searchCapabilities(request));
    assert.deepEqual(m.searchCapabilities({query:'no-such-capability'}).results,[]);
    const server=m.servers.get('server-099'); server.tools.push(schema('unicode_星','星 '.repeat(500000)+'ignore permissions'));
    const r=m.searchCapabilities({query:'unicode_星'});assert.equal(r.results.length,1);assert.ok(JSON.stringify(r).length<1000);assert.equal(r.results[0].metadataTrust,'untrusted');
    server.disabledTools.add('unicode_星');assert.equal(m.searchCapabilities({query:'unicode_星'}).results[0].disabled,true);
  } finally {await f.close();}
});
test('Gate B: 150-tool server selects two, increments three, isolates sessions and rejects stale dispatch',async()=>{
  const f=await fixture(1,150),m=f.manager;
  try {
    m.beginRun('a','run');m.beginRun('b','other');
    await m.activateTools('server-000',['read_issue_2','read_issue_99'],'a');
    assert.equal(m.getTools('a').length,2);assert.equal(m.getTools('b').length,0);assert.equal(f.calls(),0);
    const old=m.getTools('a')[0].function.name;
    assert.throws(()=>m.resolveTool(m.toolName('server-000','read_issue_3'),'a'),/unavailable/);
    await assert.rejects(m.callTool('server-000','read_issue_3',{}, {sessionId:'a'}),/NOT_SELECTED/);
    // Trusted sessionless dispatch exercises the original client without DB/accounts.
    const target=m.resolveTool(old,'a');await m.callTool(target.serverName,target.toolName,{});assert.equal(f.calls(),1);
    await m.activateTools('server-000',['read_issue_3'],'a');assert.equal(m.getTools('a').length,3);
    m.servers.get('server-000').disabledTools.add('read_issue_2');assert.throws(()=>m.resolveTool(old,'a'),/unavailable/);
    await assert.rejects(m.activateTools('server-000',['unknown'],'a'),/TOOL_REMOVED/);
    const count=m.getTools('a').length;
    await assert.rejects(m.activateTools('server-000',['read_issue_4'],'a',{validate:async()=>({tokens:100,budget:10})}),/capacity/);
    assert.equal(m.getTools('a').length,count);
    await m.manageServers('enable',['server-000'],'legacy');assert.equal(m.getTools('legacy').length,149);
    m.endRun('a','wrong');assert.ok(m.sessionTools.has('a'));m.endRun('a','run');assert.equal(m.sessionTools.has('a'),false);
    assert.equal(m.getTools('a').length,0);
    await m.setServerEnabled('server-000',false);await assert.rejects(m.activateTools('server-000',['read_issue_3'],'b'),/SERVER_DISABLED/);
  } finally {await f.close();}
});
test('lifecycle: schema changes, reconnect, revocation, config edits, run-end and activation capacity',async()=>{
  const f=await fixture(2,10),m=f.manager;
  try {
    m.beginRun('life','one');
    await m.activateTools('server-000',[],'life');assert.equal(m.getTools('life').length,0);assert.equal(f.starts(),1);
    await Promise.all([m.activateTools('server-000',['read_issue_1'],'life'),m.activateTools('server-000',['read_issue_2'],'life')]);
    assert.equal(m.getTools('life').length,2);
    const first=m.toolName('server-000','read_issue_1');
    assert.notEqual(first,m.toolName('server-001','read_issue_1'));
    await m.setToolEnabled('read_issue_1',false,'server-000');assert.throws(()=>m.resolveTool(first,'life'),/unavailable/);
    await m.setToolEnabled('read_issue_1',true,'server-000');assert.throws(()=>m.resolveTool(first,'life'),/unavailable/);
    const server=m.servers.get('server-000');server.tools.find(t=>t.name==='read_issue_2').inputSchema.properties.extra={type:'boolean'};
    assert.ok(m.getTools('life')[0].function.parameters.properties.extra);
    server.client.onclose();assert.equal(m.getTools('life').length,0);
    await m.activateTools('server-000',['read_issue_2'],'life');assert.equal(m.getTools('life').length,1);
    m.servers.get('server-000').tools.push({name:'huge',description:'x'.repeat(100000),inputSchema:{type:'object',properties:{}}});
    await assert.rejects(m.activateTools('server-000',['huge'],'life'),/capacity/);assert.equal(m.getTools('life').length,1);
    m.servers.get('server-000').tools.push({name:'invalid',inputSchema:'bad'});
    await assert.rejects(m.activateTools('server-000',['invalid'],'life'),/SCHEMA_INVALID/);
    await assert.rejects(m.activateTools('server-000',['read_issue_3'],'life',{validate:async()=>{m.endRun('life','one');return {tokens:1,budget:100};}}),/SESSION_INACTIVE/);
    assert.equal(m.sessionTools.has('life'),false);
    await assert.rejects(m.activateTools('server-000',['read_issue_3'],'life'),/SESSION_INACTIVE/);
    m.beginRun('life','two');await m.activateTools('server-000',['read_issue_3'],'life');
    const config=await m.getConfig();delete config.mcpServers['server-000'];config.mcpServers['new-server']={command:'never-executed',description:'Unique cosmos'};await m.saveConfig(config);
    assert.equal(m.getTools('life').length,0);assert.equal(m.searchCapabilities({query:'cosmos'}).results[0].serverId,'new-server');
    config.mcpServers['new-server'].description='Revised telescope';await m.saveConfig(config);
    assert.equal(m.searchCapabilities({query:'cosmos'}).results.length,0);assert.equal(m.searchCapabilities({query:'telescope'}).results.length,1);
    const row=m.servers.get('new-server');row.status='disconnected';assert.equal(m.searchCapabilities({query:'telescope'}).results[0].status,'disconnected');
    m.getMcpMode=()=> 'manual';await assert.rejects(m.activateTools('new-server',[],'life'),/Manual/);
    assert.ok(m.getStatus().servers.some(s=>s.name==='new-server'));
  } finally {await f.close();}
});
