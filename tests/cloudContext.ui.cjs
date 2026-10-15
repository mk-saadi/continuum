const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const esbuild=require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const dir=await fs.mkdtemp('/tmp/cloud-context-ui-');
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 try {
  await esbuild.build({stdin:{contents:`
   import React from 'react'; import {createRoot} from 'react-dom/client';
   import {useMemoryPalace} from './src/components/MemoryPalace';
   import {buildContextLabel} from './src/lib/contextDisplay.mjs';
   window.ctx=102400;
   window.api={getCloudModelMetadata:async()=>[{providerId:'provider',modelId:'org/model',contextLength:window.ctx}],getEffectiveSettings:async()=>({effective:{memoryEnabled:true}})};
   window.memoryPalace={getContextUsage:async()=>({totalTokens:500}),getCoreMemories:async()=>[],measureContext:async()=>({tokens:500,modelId:'cloud:provider:org/model',sessionId:'session',method:'approximate-full-request'}),onCompressionComplete:()=>()=>{}};
   function Probe(){const palace=useMemoryPalace('cloud:provider:org/model',null,'session',()=>{},{isCloud:true,isActive:false}); window.palace=palace;return <div>{buildContextLabel({total:500,limit:palace.limit,isCloud:true}).label}</div>}
   createRoot(document.getElementById('root')).render(<Probe/>);
  `,loader:'jsx',resolveDir:process.cwd()},bundle:true,outfile:path.join(dir,'fixture.js')});
  await fs.writeFile(path.join(dir,'index.html'),'<div id="root"></div><script src="fixture.js"></script>');
  await win.loadFile(path.join(dir,'index.html'));
  await win.webContents.executeJavaScript(`(async()=>{const wait=()=>new Promise(r=>setTimeout(r,80));await wait();if(!document.body.textContent.includes('500 / 102.4k'))throw Error('Cloud limit missing');window.ctx=256000;window.dispatchEvent(new Event('model-capabilities-changed'));await wait();if(!document.body.textContent.includes('500 / 256.0k'))throw Error('Override refresh missing');window.ctx=null;window.dispatchEvent(new Event('model-capabilities-changed'));await wait();if(!document.body.textContent.includes('Cloud context'))throw Error('Unknown limit fallback missing');})()`);
  console.log('Cloud header limit, override refresh and unknown-limit fallback passed.');
 }finally{win.destroy();await fs.rm(dir,{recursive:true,force:true});}
 app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
