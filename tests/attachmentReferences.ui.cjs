'use strict';
// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/attachmentReferences.ui.cjs
const {app,BrowserWindow,dialog}=require('electron');
const fs=require('node:fs'), fsp=fs.promises, path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
const esbuild=require('esbuild');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-references-ui-'));
app.setPath('userData',path.join(directory,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
let window,dispose,database,chosen=[];
const oldDialog=dialog.showOpenDialog;
dialog.showOpenDialog=async()=>({canceled:!chosen.length,filePaths:chosen});
const run=code=>window.webContents.executeJavaScript(code);
const wait=async(expression,label)=>{
  for(let i=0;i<150;i++) {if(await run(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error(label+': '+await run('window.fixtureError || document.body.textContent'));
};
const click=async(text,scope='document')=>run(`(()=>{const button=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button missing: '+${JSON.stringify(text)});button.click();})()`);
app.whenReady().then(async()=>{
  try {
    database=require('../src/main/db');database.initDatabase();
    const store=require('../src/main/attachmentStore'), sessions=require('../src/main/sessionManager');
    require('../src/main/capabilityOverrides').saveOverrides({type:'local',modelId:'/fixture-model.gguf'},{image:true,audio:true,video:true});
    dispose=require('../src/main/ipcHandlers').registerIpcHandlers({isTrustedSender:event=>event.sender===window?.webContents && event.senderFrame===event.sender.mainFrame,
      getEngineConfig:()=>({modelPath:'/fixture-model.gguf',port:9})});
    for(const id of ['ui-selection','ui-drop','ui-paste','ui-recover','ui-history'])sessions.getOrCreateSession(id,'/fixture-model.gguf');
    await esbuild.build({entryPoints:[path.join(__dirname,'fixtures/attachmentReferences.jsx')],bundle:true,outfile:path.join(directory,'fixture.js'),loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"test"'}});
    await fsp.writeFile(path.join(directory,'index.html'),'<div id="root"></div><script src="fixture.js"></script>');
    window=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../src/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    await window.loadFile(path.join(directory,'index.html'));window.webContents.debugger.attach('1.3');
    const fixtures=await require('./fixtures/attachmentImages.cjs').attachmentImages();
    const source=path.join(directory,'dense.png');fs.writeFileSync(source,fixtures[0].bytes);
    const reset=async id=>{
      await run(`window.fixtureMessages=null;window.fixtureSubmitted=null;window.changeFixtureSession(${JSON.stringify(id)})`);
      await wait(`!!document.querySelector('textarea[aria-label="Message"]') && !document.querySelector('input[aria-label="Choose attachments"]').disabled`,'composer ready');
      await new Promise(resolve=>setTimeout(resolve,80));
    };
    const select=async(file,{suppress=false}={})=>{
      if(suppress)await run(`document.querySelector('input[aria-label="Choose attachments"]').addEventListener('change',e=>e.stopImmediatePropagation(),{capture:true,once:true})`);
      const {root}=await window.webContents.debugger.sendCommand('DOM.getDocument');
      const {nodeId}=await window.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'input[aria-label="Choose attachments"]'});
      await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[file]});
    };
    const selected=()=>wait(`!!document.querySelector('[aria-label="Selected attachments"] img') && document.querySelector('[aria-label="Selected attachments"] img').naturalWidth>0`,'selected preview');
    const drafts=id=>database.db.prepare('SELECT * FROM attachment_drafts WHERE session_id=? ORDER BY rowid DESC').all(id);
    const current=id=>store.view({version_id:drafts(id)[0].version_id,draft_token:drafts(id)[0].token,session_id:id});
    await reset('ui-selection');await select(source);await selected();
    let selection=current('ui-selection');assert.equal(selection.storage_kind,'referenced');assert.equal(selection.file_path,source);
    assert.equal(fs.existsSync(store.directory()),false,'native selection does not copy the source');
    assert.equal(await run(`document.querySelector('[aria-label="Selected attachments"] img').naturalWidth`),4096);
    console.log('Native Chromium selection → reference, 4096x2048 preview, no managed copy.');
    await reset('ui-drop');await select(source,{suppress:true});
    await run(`(()=>{const input=document.querySelector('input[aria-label="Choose attachments"]');const data=new DataTransfer();data.items.add(input.files[0]);input.closest('[data-dragging]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
    await selected();assert.equal(current('ui-drop').storage_kind,'referenced');assert.equal(fs.existsSync(store.directory()),false);
    console.log('Native-backed drop → reference, no managed copy.');
    await reset('ui-paste');
    const pasted=fixtures[1];
    await run(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(pasted.bytes.toString('base64'))}),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'',{type:'image/png'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);
    await selected();const paste=current('ui-paste');assert.equal(paste.storage_kind,'managed');assert.deepEqual(fs.readFileSync(paste.file_path),pasted.bytes);
    console.log('Pathless paste → managed original PNG, alpha intact.');
    assert.equal(await run(`window.api.stageAttachments([{nativePath:${JSON.stringify(source)}}],{sessionId:'ui-paste'}).then(()=>false,error=>/real file|authorization/.test(error.message))`),true,'renderer cannot claim an arbitrary native path');
    await reset('ui-recover');await select(source);await selected();
    const asset=current('ui-recover').asset_id;
    fs.writeFileSync(source,pasted.bytes);
    await click('Details');await wait(`document.querySelector('[aria-label="Attachment details"]').textContent.includes('source has changed')`,'changed source feedback');
    await click('Accept changed version');await wait(`document.querySelector('[aria-label="Selected attachments"] img').naturalWidth===37`,'accepted version preview');
    assert.equal(current('ui-recover').asset_id,asset);
    const moved=path.join(directory,'moved.png');fs.renameSync(source,moved);chosen=[moved];
    await click('Locate file');await wait(`document.querySelector('[aria-label="Attachment details"]').textContent.includes('moved.png')`,'relink details');
    assert.equal(current('ui-recover').file_path,moved);
    await click('Keep a copy');await wait(`document.querySelector('[aria-label="Selected attachments"]').textContent.includes('Managed copy')`,'durable copy badge');
    const copy=current('ui-recover');assert.deepEqual(fs.readFileSync(copy.file_path),pasted.bytes);fs.unlinkSync(moved);
    await run(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`);
    await wait('!!window.fixtureMessages','durable copy submits after source deletion');
    const grant=sessions.loadSession('ui-recover').messages.at(-1).attachments[0];assert.equal(grant.storage_kind,'managed');
    let outgoing;
    await store.withSnapshots('ui-recover',[],async()=>{
      const messages=require('../src/main/promptBuilder').rebuildChatMessages({sessionId:'ui-recover',modelId:'/fixture-model.gguf'});
      const fetchImpl=require('../src/main/modelCapabilities').createMediaGuardedFetch(async(url,options)=>{
        if(url.endsWith('/props'))return Response.json({modalities:{vision:true}});
        outgoing=JSON.parse(options.body);return Response.json({choices:[{message:{content:'Fixture complete'},finish_reason:'stop'}]});
      });
      await (await import('../src/lib/memoryChat.mjs')).runMemoryChat({baseUrl:'http://127.0.0.1:8999',modelId:'fixture',messages,fetchImpl});
    });
    const image=outgoing.messages.at(-1).content.find(part=>part.type==='image_url');assert.deepEqual(Buffer.from(image.image_url.url.split(',')[1],'base64'),pasted.bytes);
    console.log('Changed-source acceptance, native relink, Keep a copy, source deletion and outgoing original PNG verified.');
    // A historical missing reference is recoverable in the renderer, not a crash.
    const historical=path.join(directory,'historical.png');fs.writeFileSync(historical,pasted.bytes);
    const files=await store.stage([{nativePath:historical}],{sessionId:'ui-history'});
    await store.withSnapshots('ui-history',files,()=>require('../src/main/promptBuilder').prepareChatMessages({sessionId:'ui-history',modelId:'fixture',userText:'Historical fixture',attachments:files}));
    fs.unlinkSync(historical);await reset('ui-history');
    await wait(`!!document.querySelector('[aria-label="Attachments needing attention"]')`,'historical recovery panel');
    await click('Omit attachment',`document.querySelector('[aria-label="Attachments needing attention"]')`);
    await wait(`!document.querySelector('[aria-label="Attachments needing attention"]')`,'explicit omission');
    const messages=await store.withSnapshots('ui-history',[],()=>require('../src/main/promptBuilder').rebuildChatMessages({sessionId:'ui-history',modelId:'fixture'}));
    assert.match(JSON.stringify(messages),/explicitly omitted by user/);
    console.log('Missing historical source → working recovery panel and explicit omission marker.');
  } finally {
    dialog.showOpenDialog=oldDialog;dispose?.();database?.closeDatabase();window?.destroy();await fsp.rm(directory,{recursive:true,force:true});
  }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
