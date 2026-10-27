'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'), os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'w5-ui-'));let window;
 try{
 await require('esbuild').build({entryPoints:[path.join(__dirname,'fixtures/compactionActivity.jsx')],bundle:true,outfile:path.join(dir,'fixture.js'),loader:{'.png':'dataurl','.svg':'dataurl'},define:{'process.env.NODE_ENV':'"test"'}});
 const cssFiles=await fs.readdir(path.join(__dirname,'../dist/assets'));
 const css=cssFiles.find(file=>file.startsWith('index-')&&file.endsWith('.css'));
 if(css)await fs.copyFile(path.join(__dirname,'../dist/assets',css),path.join(dir,'style.css'));
 await fs.writeFile(path.join(dir,'index.html'),'<link rel="stylesheet" href="style.css"><body style="background:var(--bg-primary);color:var(--text-primary)"><div id="root" style="padding:16px"></div><script src="fixture.js"></script>');
 window=new BrowserWindow({show:false,width:420,height:800,webPreferences:{sandbox:true}});await window.loadFile(path.join(dir,'index.html'));
 const result=await window.webContents.executeJavaScript(`(async()=>{
 const wait=()=>new Promise(r=>setTimeout(r,80));await wait();
 const e={id:'attempt-a',session_id:'a',run_id:'run-a',message_id:1,anchor_step_id:'read',sequence:1,revision:1,status:'generating',started_at:'2026-10-25T00:00:00Z',metadata:{}};
 window.emitActivity(e);await wait();const started=document.body.textContent.includes('Generating compact task state');
 const complete={...e,status:'completed',revision:2,metadata:{beforeTokens:10000,afterTokens:6000,measurementMethod:'approximate-full-request',continued:true,checkpointId:42,targetTokens:17000,targetMet:true,generationStages:2}};
 window.emitActivity(complete);window.emitActivity(e);window.emitActivity(complete);await wait();
 window.emitCompression({sessionId:'a',compressed:true,archivedCount:5,diagnostics:{commitOutcome:'committed-and-verified',sessionModelId:'model',modelId:'provider-native-model',actualTokens:6000,actualMeasurementMethod:'approximate-full-request',actualBudgetContract:{usableInputTokens:39000}}});
 await wait();const counterAccurate=window.counterState.contextTokens===10000&&window.counterState.contextConfidence==='estimated'&&!window.counterState.toast;
 const text=document.body.textContent;const correctOrder=text.indexOf('before.js')<text.indexOf('Context compacted')&&text.indexOf('Context compacted')<text.indexOf('after.js');
 const unique=document.querySelectorAll('[data-compaction-id]').length===1;
 const accessible=document.querySelector('[data-compaction-id] summary')?.tagName==='SUMMARY'&&!!document.querySelector('[role=status]');
 const measured=text.includes('Estimated: 10,000')&&text.includes('40.0% less')&&text.includes('Agent continued working');
 const inspectButton=[...document.querySelectorAll('button')].find(button=>button.textContent==='Inspect checkpoint');
 let focused=null;window.addEventListener('continuum:inspect-checkpoint',event=>focused=event.detail,{once:true});
 inspectButton?.click(); const inspect=focused?.sessionId==='a'&&focused?.checkpointId===42&&text.includes('Checkpoint v42')&&text.includes('Post-compaction target: 17,000 tokens · Met');
 const disclosure=document.querySelector('[data-compaction-id] summary');disclosure.click();const expands=document.querySelector('[data-compaction-id]').open;
 window.activityStore.a=[{...complete,revision:3,metadata:{...complete.metadata,generationStages:3}}];
 await new Promise(resolve=>setTimeout(resolve,2700));
 const recoveredMissedUpdate=document.body.textContent.includes('Generation stages: 3');
 window.selectActivitySession('b');await wait();const isolated=!document.body.textContent.includes('Context compacted')&&window.activityListeners.size===1;
 window.selectActivitySession('a');await wait();const reopen=document.body.textContent.includes('Context compacted')&&window.activityListeners.size===1;
 window.mountActivity(false);await wait();const cleaned=window.activityListeners.size===0;
 return {inspect,started,correctOrder,unique,accessible,measured,counterAccurate,expands,recoveredMissedUpdate,isolated,reopen,cleaned};})()`);
 await window.webContents.executeJavaScript("window.mountActivity(true);document.documentElement.dataset.theme='light'");
 await new Promise(resolve=>setTimeout(resolve,150));
 await fs.writeFile('/tmp/continuum-w5/ui-light.png',(await window.webContents.capturePage()).toPNG());
 await window.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
 await new Promise(resolve=>setTimeout(resolve,150));
 await fs.writeFile('/tmp/continuum-w5/ui-dark.png',(await window.webContents.capturePage()).toPNG());
 assert.ok(Object.values(result).every(Boolean),JSON.stringify(result));console.log('RESULTS '+JSON.stringify(result));
 }catch(e){console.error(e);process.exitCode=1;}finally{window?.destroy();await fs.rm(dir,{recursive:true,force:true});app.exit(process.exitCode??0);}
});
