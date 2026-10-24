const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-reliability-'));
const workspace = path.join(root,'workspace'); fs.mkdirSync(workspace);
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => root } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { runForeground, shutdownForegroundCommands } = require('../src/main/foregroundCommand');
initDatabase(root);
const project = require('../src/main/projectManager').createProject({name:'Commands', root_path:workspace});
require('../src/main/sessionManager').getOrCreateSession('commands', 'model', project.id);
const run = (args, signal) => require('./helpers/approvedNativeCommand.cjs')({name:'execute_command',arguments:JSON.stringify(args),sessionId:'commands',permissionMode:'full_access',signal});
const node = source => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
test.after(() => { closeDatabase(); Module._load = originalLoad; fs.rmSync(root,{recursive:true,force:true}); });

test('schema, defaults, numeric validation and maximum', async () => {
 const schema = agentTools.find(t=>t.function.name==='execute_command').function.parameters.properties.timeout_ms;
 assert.equal(schema.maximum,300000);
 for (const timeout_ms of [0,-1,999,300001,1.5,'1000',null]) {
  const r = await run({command:'echo SHOULD_NOT_RUN',timeout_ms});
  assert.equal(r.success,false); assert.match(r.error,/timeout_ms/);
 }
 const normal = await run({command:'printf default'});
 assert.equal(normal.timeout_ms,60000); assert.equal(normal.status,'completed');
 const maximum = await run({command:'printf max',timeout_ms:300000});
 assert.equal(maximum.timeout_ms,300000);
});
test('stdout, stderr, nonzero and actual exit status', async()=>{
 const r=await run({command:'printf hello; printf failure >&2; exit 7'});
 assert.equal(r.status,'nonzero_exit'); assert.equal(r.exitCode,7);
 assert.equal(r.stdout,'hello'); assert.equal(r.stderr,'failure'); assert.equal(r.output_truncated,false);
});
test('silent commands succeed; large single-line output keeps both stream tails',async()=>{
 assert.equal((await run({command:node('setTimeout(()=>{},50)')})).status,'completed');
 const r=await run({command:"printf H; head -c 2000000 /dev/zero | tr '\\0' x; printf STDOUT_TAIL; (printf E; head -c 2000000 /dev/zero | tr '\\0' y; printf ERROR_TAIL) >&2; exit 9"});
 assert.equal(r.exitCode,9); assert.equal(r.output_truncated,true);
 assert.ok(r.stdout.length<16500 && r.stderr.length<16500);
 assert.match(r.stdout,/STDOUT_TAIL$/); assert.match(r.stderr,/ERROR_TAIL$/);
});
test('absolute timeout stops periodic output and preserves null exit code',async()=>{
 const r=await run({command:node("setInterval(()=>require('fs').writeSync(1,'tick'),20)"),timeout_ms:1000});
 assert.equal(r.status,'timed_out'); assert.equal(r.exitCode,null); assert.equal(r.timedOut,true);
 assert.ok(r.duration_ms>=1000 && r.duration_ms<2500);
});
test('concurrent native calls remain isolated under cancellation',async()=>{
 const abort=new AbortController(); const timer=setTimeout(()=>abort.abort(),150);
 const [a,b]=await Promise.all([run({command:node('setInterval(()=>{},100)')},abort.signal),run({command:node("setTimeout(()=>require('fs').writeSync(1,'sibling'),500)")})]);
 clearTimeout(timer); assert.equal(a.status,'cancelled'); assert.equal(b.status,'completed'); assert.match(b.stdout,/sibling/);
});
test('deadline signal stays distinct and does not become command timeout',async()=>{
 const { armExecutionDeadline, releaseExecutionDeadline }=require('../src/main/subagents/executionDeadline');
 const deadline=armExecutionDeadline({id:'commands'},{maxRuntimeMs:150});
 try { const r=await run({command:node('setInterval(()=>{},100)'),timeout_ms:300000}); assert.equal(r.status,'agent_deadline_exceeded'); assert.equal(r.exitCode,null); }
 finally {deadline.clear();releaseExecutionDeadline('commands');}
});
test('forced group cleanup kills TERM-ignoring descendant even when shell exits',async()=>{
 const pidFile=path.join(workspace,'descendant.pid');
 const source=`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100)`;
 const r=await run({command:node(source),timeout_ms:1000}); assert.equal(r.status,'timed_out');
 const pid=Number(fs.readFileSync(pidFile,'utf8'));
 let live=false; try { const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'); live=!/\) Z /.test(stat); } catch {}
 assert.equal(live,false,'owned descendant must no longer execute');
});
test('foreground shell success cleans child with closed output',async()=>{
 const marker=path.join(workspace,'orphan-marker');
 const r=await run({command:`${node(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),800)`)} >/dev/null 2>&1 &`});
 assert.equal(r.status,'completed'); await new Promise(r=>setTimeout(r,850)); assert.equal(fs.existsSync(marker),false);
});
test('spawn errors and shutdown settle owned operations',async()=>{
 const missing=await runForeground('/no/such/runner',[],{cwd:root,timeoutMs:1000});
 assert.equal(missing.status,'spawn_failed');assert.equal(missing.exitCode,null);
 const running=runForeground(process.execPath,['-e','setInterval(()=>{},100)'],{cwd:root,timeoutMs:10000});
 await shutdownForegroundCommands();assert.equal((await running).status,'cancelled');
});

test('real main loop returns a beyond-45-second command to the same transcript and then receives steering', { skip: process.env.CONTINUUM_LONG_COMMAND_TEST !== '1' }, async()=>{
 const { runMemoryChat }=await import('../src/lib/memoryChat.mjs');
 const stream = delta => new Response(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 let round=0, executed=0, result, queued=false, delivered=0;
 const runId='command-long-same-run';
 const text=await runMemoryChat({baseUrl:'http://fixture.invalid',modelId:'fixture',runId,
  messages:[{role:'system',content:'Fixture'},{role:'user',content:'Run command'}],
  memoryTools:[],chatTools:agentTools,
  fetchImpl:async(_url,request)=>{
   if(round++===0) return stream({tool_calls:[{index:0,id:'long-command',type:'function',function:{name:'execute_command',arguments:JSON.stringify({command:node("setTimeout(()=>require('fs').writeSync(1,'LONG_OK'),46000)"),timeout_ms:55000})}}]});
   const messages=JSON.parse(request.body).messages;
   const tool=messages.find(m=>m.role==='tool' && m.tool_call_id==='long-command');
   assert.ok(tool);assert.match(tool.content,/LONG_OK/);
   assert.ok(messages.some(m=>m.role==='user' && String(m.content).includes('AFTER_COMMAND_STEERING')));
   return stream({content:'continued-same-run'});
  },
  executeTool:async call=>{
   executed++; const timer=setTimeout(()=>{queued=true;},100);
   try {result=await run(JSON.parse(call.arguments));return result;}finally{clearTimeout(timer);}
  },
  takeSteeringInstructions:async()=>queued?[{id:'steer-long',content:'AFTER_COMMAND_STEERING',deliveryRequestId:runId}]:[],
  markSteeringDelivered:async()=>{delivered++;queued=false;},
 });
 assert.equal(text,'continued-same-run');assert.equal(executed,1);assert.equal(round,2);assert.equal(delivered,1);
 assert.equal(result.status,'completed');assert.equal(result.exitCode,0);assert.ok(result.duration_ms>45000);
 console.log('LONG_COMMAND_EVIDENCE '+JSON.stringify({runId,result,round,executed,delivered}));
});

test('cancelled shell descendants are stopped before tool settlement',async()=>{
 const marker=path.join(workspace,'cancelled-descendant');
 const abort=new AbortController();
 const command=node(`process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1000);setInterval(()=>{},100)`);
 const pending=run({command},abort.signal);const timer=setTimeout(()=>abort.abort(),200);
 const r=await pending;clearTimeout(timer);assert.equal(r.status,'cancelled');
 await new Promise(r=>setTimeout(r,1100));assert.equal(fs.existsSync(marker),false);
});
test('native dispatcher reports runner spawn failure',async()=>{
 const r=await run({command:'printf forbidden',cwd:path.join(workspace,'missing-directory')});
 assert.equal(r.status,'spawn_failed');assert.equal(r.spawnError,'ENOENT');assert.equal(r.exitCode,null);
});
test('child shell tools stay outside the independent read-only allowlist',()=>{
 const {CHILD_TOOL_NAMES}=require('../src/main/subagents/agentLoop');
 assert.equal(CHILD_TOOL_NAMES.includes('execute_command'),false);
 assert.equal(CHILD_TOOL_NAMES.includes('run_tests'),false);
});

test('successful shell exit does not become timeout during descendant cleanup',async()=>{
 const r=await runForeground('/bin/sh',['-c','sleep 10 & exit 0'],{timeoutMs:100});
 assert.equal(r.status,'completed');assert.equal(r.exitCode,0);
});

test('Windows lifecycle adapter uses owned taskkill tree arguments and preserves cmd verbatim quoting',async()=>{
 const vm=require('node:vm'), {EventEmitter}=require('node:events'), {PassThrough}=require('node:stream');
 const calls=[]; const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/main/foregroundCommand'),'utf8'),{
  module,process:{platform:'win32'},performance,setTimeout,clearTimeout,setInterval,clearInterval,
  require:name=>{
   assert.equal(name,'node:child_process');
   return {spawn:(file,argv,options)=>{
    calls.push({file,argv,options});
    const child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();return child;
   }};
  },
 });
 const argv=['/d','/s','/c','"echo fixture"'];
 const r=await module.exports.runForeground('cmd.exe',argv,{timeoutMs:20,windowsVerbatimArguments:true});
 assert.equal(r.status,'timed_out');assert.equal(calls[0].options.detached,false);
 assert.equal(calls[0].options.windowsVerbatimArguments,true);
 assert.equal(calls[0].argv,argv);
 assert.deepEqual(Array.from(calls[1].argv),['/pid','12345','/T']);
 assert.deepEqual(Array.from(calls[2].argv),['/pid','12345','/T','/F']);
});
