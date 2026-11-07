// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/casualResponse.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'casual-response-'));
 const browser=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 try {
  await esbuild.build({stdin:{contents:`
   import React from 'react';import {createRoot} from 'react-dom/client';
   import ChatMessage from './src/components/ChatMessage.jsx';
   import MessageActions from './src/components/MessageActions.jsx';
   const root=createRoot(document.getElementById('root'));
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text}}});
   let snapshot=''; const listeners=new Set();
   const buffer={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getSnapshot:()=>snapshot};
   window.push=text=>{snapshot=text;listeners.forEach(listener=>listener())};
   window.render=(message,mode='casual')=>root.render(<><ChatMessage message={message} streamBuffer={message.streaming?buffer:undefined} mode={mode} interactive={false} /><MessageActions message={message} onError={error=>{throw Error(error)}} /></>);
   window.render({id:1,role:'assistant',content:'',streaming:true});
  `,loader:'jsx',resolveDir:process.cwd()},bundle:true,outfile:path.join(dir,'fixture.js'),define:{'process.env.NODE_ENV':'"test"'}});
  await fs.writeFile(path.join(dir,'index.html'),'<div id="root"></div><script src="fixture.js"></script>');
  await browser.loadFile(path.join(dir,'index.html'));
  await browser.webContents.executeJavaScript(`(async()=>{
   const tick=()=>new Promise(resolve=>setTimeout(resolve,70));
   const check=(condition,label)=>{if(!condition)throw Error(label)};
   const activity=()=>document.querySelector('[aria-label="Reply activity"]');
   const copy=()=>document.querySelector('[aria-label="Copy message"]');
   const outside=()=>{const clone=document.getElementById('root').cloneNode(true);clone.querySelector('[aria-label="Reply activity"]')?.remove();return clone.textContent};
   await tick();
   for (const mode of ['casual','workspace']) {
     window.render({id:10,role:'assistant',content:'',streaming:true},mode);await tick();
     check(document.body.textContent.includes('Prompt processing…'),'Show prompt processing before output in '+mode);
     for (const executionSteps of [
       [{id:'thought',type:'thought',content:'Thinking now'}],
       [{id:'tool',type:'tool_call',toolName:'shell',status:'running',args:{command:'pwd'}}],
       [{id:'text',type:'text',content:'Working now',startOffset:0,endOffset:11}]
     ]) {
       window.render({id:10,role:'assistant',content:'',streaming:true,executionSteps},mode);await tick();
       check(!document.body.textContent.includes('Prompt processing…'),'Hide on first '+executionSteps[0].type+' in '+mode);
     }
     window.render({id:10,role:'assistant',content:'',streaming:true},mode);await tick();
     window.push('First streamed token');await tick();
     check(!document.body.textContent.includes('Prompt processing…'),'First buffer text hides processing in '+mode);
     window.push('');
   }
   window.render({id:1,role:'assistant',content:'',streaming:true});await tick();
   window.push('Checking the download…');await tick();
   check(activity()&&!activity().open,'Live text creates collapsed Activity before any tool');
   check(!outside().includes('Checking the download'),'Live progress must not render as final');
   check(copy().disabled,'No copyable final response while working');
   activity().querySelector('summary').click();await tick();
   check(activity().textContent.includes('Checking the download'),'Live buffer renders inside Activity');
   const progress='Checking the download…';
   const steps=[{id:'text',type:'text',content:progress,startOffset:0,endOffset:progress.length},{id:'tool',type:'tool_call',toolName:'shell',status:'running',args:{command:'download'}}];
   window.push(progress+'Downloading now…');window.render({id:1,role:'assistant',content:'',streaming:true,executionSteps:steps});await tick();
   check(activity().textContent.includes(progress)&&activity().textContent.includes('Downloading now…'),'Sealed and live progress stay inside activity');
   check(!outside().includes('Downloading now'),'No progress leaks outside');
   const allProgress=progress+'Downloading now…';
   const finalSteps=[...steps,{id:'text2',type:'text',content:'Downloading now…',startOffset:progress.length,endOffset:allProgress.length}];
   window.render({id:1,role:'assistant',content:allProgress+'Download complete.',executionSteps:finalSteps});await tick();
   check(outside().includes('Download complete.')&&!outside().includes('Checking the download')&&!outside().includes('Downloading now'),'Only final response outside Activity');
   copy().click();await tick();check(window.copied==='Download complete.','Footer copies final response only');
   window.render({id:2,role:'assistant',content:'stale',active_variant_index:1,variants:[{content:'old'},{content:allProgress+'Chosen answer',executionSteps:finalSteps}]});await tick();copy().click();await tick();check(window.copied==='Chosen answer','Copy uses selected variant');
   window.render({id:3,role:'assistant',status:'interrupted',content:allProgress+'Unfinished text',executionSteps:finalSteps});await tick();check(copy().disabled&&!outside().includes('Unfinished text'),'Interrupted output is not final');
   activity().querySelector('summary').click();await tick();check(activity().textContent.includes('Unfinished text'),'Interrupted tail is retained inside Activity');
   window.render({id:4,role:'user',content:'Original user prompt'});await tick();copy().click();await tick();check(window.copied==='Original user prompt','User copy is unchanged');
  })()`);
  console.log('Live progress containment, final-only rendering/copy, variants, interruption, and user copy passed.');
 } finally {browser.destroy();await fs.rm(dir,{recursive:true,force:true});}
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)});
