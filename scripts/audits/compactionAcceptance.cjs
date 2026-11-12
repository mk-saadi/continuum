'use strict';
// Deterministic verification only: scripted providers, temporary projects,
// no live-model inference. --all also runs the rest of the repository tests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const focused = [
  'conversationCompaction', 'mainChatCompaction', 'compressionLifecycle', 'contextOverflowRecovery', 'c6cAcceptance',
  'subagentCompaction', 'subagentCompactionHardening', 'subagentLongHorizonBudgets', 'subagentContinuation',
  'subagentTimeouts', 'subagentOutOfProcessRecovery', 'subagentModelBudgets', 'contextBudget', 'contextC1',
  'contextC1Integration', 'contextC1Ui', 'contextPanel', 's1StartupLifecycle', 'h1HistoryDeletion',
  'workspacePlan', 'compactPlanResults', 'attachmentReferences', 'r3Reliability', 'p2CompactNativeTools',
  'webToolAvailability', 'permissionIsolationReliability', 'liveSteeringIpc', 'workLog', 'workLogDisplay', 'compactionBadge', 'sessionPromptWording',
].map(name => `tests/${name}.test.cjs`).concat(['subagentCompletionDisplay','contextDispatch','liveSteeringLoop','c93PrematureStop','requestAccounting','memoryChat','t11ChildReadBatch','subagentDispatchConcurrency','t1ToolBatch'].map(name=>`tests/${name}.test.mjs`)).filter(name => fs.existsSync(path.join(root,name)));
const files = args.includes('--all') ? fs.readdirSync(path.join(root,'tests')).filter(name=>/\.test\.(?:cjs|mjs|js)$/.test(name)).sort().map(name=>`tests/${name}`) : focused;
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'continuum-compaction-acceptance-'));
const output = args.find(arg=>arg.endsWith('.json'));
let cursor = 0;
const results = [];
async function run(file) {
  const started = Date.now(), environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const log = path.join(directory,path.basename(file)+'.log');
  const stream = fs.createWriteStream(log); let text = '';
  const child = spawn(process.execPath,[path.join(root,file)],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']});
  const accept = data => { stream.write(data); text += data; };
  child.stdout.on('data',accept); child.stderr.on('data',accept);
  let timedOut = false;
  const timer = setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},120000);
  const exit = await new Promise(resolve=>{child.once('error',error=>resolve({code:null,error:error.message}));child.once('close',(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer); stream.end();
  const count = expression => {const match=text.match(expression);return match?Number(match[1]):null;};
  results.push({file,status:exit.code===0?'passed':'failed',exitCode:exit.code,signal:exit.signal??null,timedOut,
    cases:count(/^# tests (\d+)$/m),passed:count(/^# pass (\d+)$/m),failed:count(/^# fail (\d+)$/m),
    cancelled:count(/^# cancelled (\d+)$/m),durationMs:Date.now()-started,
    failures:[...text.matchAll(/^not ok [^\n]+/gm)].map(match=>match[0]),log});
}
async function worker(){while(cursor<files.length){const file=files[cursor++];await run(file);}}
(async()=>{
  await Promise.all(Array.from({length:Math.min(6,files.length)},worker));
  results.sort((a,b)=>a.file.localeCompare(b.file));
  const report={date:'2026-11-08',scope:args.includes('--all')?'all repository test files':'replacement acceptance',
    inference:'scripted; no live model',measurement:'synthetic test counts/estimates, not real tokenizer certification',
    command:`node scripts/audits/compactionAcceptance.cjs${args.includes('--all')?' --all':''}`,
    totalFiles:results.length,passedFiles:results.filter(r=>r.status==='passed').length,
    failedFiles:results.filter(r=>r.status==='failed').length,results};
  if(output)fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({totalFiles:report.totalFiles,passedFiles:report.passedFiles,failedFiles:report.failedFiles,
    failures:results.filter(r=>r.status==='failed').map(r=>r.file),output:output??null,logs:directory},null,2));
  if(report.failedFiles)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
