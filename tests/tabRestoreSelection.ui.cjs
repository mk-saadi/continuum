// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/tabRestoreSelection.ui.cjs
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os');
const esbuild=require('esbuild'),assert=require('node:assert/strict');
const profile=syncFs.mkdtempSync(path.join(os.tmpdir(),'tab-selection-profile-'));
app.setPath('userData',profile);app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tab-selection-'));
 let browser;
 try{
  await esbuild.build({stdin:{contents:`
   import React,{useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';
   import {TabProvider,useTabs} from './src/context/TabContext.jsx';
   import TabBar from './src/components/TabBar.jsx';
   window.memoryPalace={getAllSessions:async()=>[{sessions:[{id:'sa'},{id:'sb'},{id:'sc'}]}]};
   window.chatAPI={};
   const key='continuum_open_tabs';
   if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({tabs:[
    {id:'a',sessionId:'sa',title:'First',saved:true},
    {id:'b',sessionId:'sb',title:'Workspace',projectId:'project',view:'project',saved:true},
    {id:'c',sessionId:'sc',title:'Tasks',view:'tasks',saved:true}],activeTabId:'a'}));
   function Probe(){const tabs=useTabs();window.tabsApi=tabs;useLayoutEffect(()=>{
    if(window.flushOnCommit && tabs.activeTabId===window.flushOnCommit){
     window.dispatchEvent(new Event('pagehide'));
     window.storedDuringCommit=JSON.parse(localStorage.getItem(key)).activeTabId;
    }
   },[tabs.activeTabId]);return <TabBar/>;}
   createRoot(document.getElementById('root')).render(<TabProvider><Probe/></TabProvider>);
  `,loader:'jsx',resolveDir:process.cwd()},bundle:true,outfile:path.join(dir,'fixture.js'),define:{'process.env.NODE_ENV':'"test"'}});
  await fs.writeFile(path.join(dir,'index.html'),'<div id="root"></div><script src="fixture.js"></script>');
  const open=async()=>{browser=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await browser.loadFile(path.join(dir,'index.html'));await browser.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{if(window.tabsApi)return resolve(true);if(n++>100)return reject(Error('hydration timeout'));setTimeout(tick,20)};tick()})`)};
  await open();
  assert.equal(await browser.webContents.executeJavaScript(`window.flushOnCommit='c';window.tabsApi.activateTab('c');new Promise(resolve=>setTimeout(()=>resolve(window.storedDuringCommit),50))`),'c','unload during commit must save latest selected tab');
  await browser.reload();
  await browser.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,150))`);
  assert.equal(await browser.webContents.executeJavaScript('window.tabsApi.activeTabId'),'c','reload restores last tab');
  assert.equal(await browser.webContents.executeJavaScript('window.tabsApi.activeTab.view'),'tasks','reload restores its page');
  await browser.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',ctrlKey:true,bubbles:true}));new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await browser.webContents.executeJavaScript('window.tabsApi.activeTabId'),'b','keyboard selection selects middle tab');
  browser.destroy();await open();
  assert.equal(await browser.webContents.executeJavaScript('window.tabsApi.activeTabId'),'b','fresh window restores middle tab');
  assert.equal(await browser.webContents.executeJavaScript('window.tabsApi.activeTab.projectId'),'project');
  console.log('Last/middle tab selection survives commit-time unload, reload, fresh window and keyboard navigation.');
 }finally{browser?.destroy();await fs.rm(dir,{recursive:true,force:true});await fs.rm(profile,{recursive:true,force:true});}
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)});
